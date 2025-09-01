import os
import tempfile
from uuid import uuid4
from datetime import datetime
import json
import re
import base64
import random
from dotenv import load_dotenv
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import qdrant_client
from openai import OpenAI
from prompts.prompt import engineeredprompt
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_qdrant import Qdrant
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain


# Load env vars
load_dotenv()

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": [
            "https://dsahdoctoraiassistantbot.onrender.com",
            "http://localhost:3000"
        ],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    }
})


chat_sessions = {}
collection_name = os.getenv("QDRANT_COLLECTION_NAME")

# Initialize OpenAI client
client = OpenAI()

# === VECTOR STORE ===
def get_vector_store():
    qdrant = qdrant_client.QdrantClient(
        url=os.getenv("QDRANT_HOST"),
        api_key=os.getenv("QDRANT_API_KEY"),
        timeout=60.0
    )
    embeddings = OpenAIEmbeddings()
    return Qdrant(client=qdrant, collection_name=collection_name, embeddings=embeddings)

vector_store = get_vector_store()

# === RAG Chain ===
def get_context_retriever_chain():
    llm = ChatOpenAI(model="gpt-4o")
    retriever = vector_store.as_retriever()
    prompt = ChatPromptTemplate.from_messages([
        MessagesPlaceholder("chat_history"),
        ("user", "{input}"),
        ("user", "Given the above conversation, generate a search query to look up in order to get information relevant to the conversation"),
    ])
    return create_history_aware_retriever(llm, retriever, prompt)

def get_conversational_rag_chain():
    retriever_chain = get_context_retriever_chain()
    llm = ChatOpenAI(model="gpt-4o")
    prompt = ChatPromptTemplate.from_messages([
        ("system", engineeredprompt),
        MessagesPlaceholder("chat_history"),
        ("user", "{input}"),
    ])
    return create_retrieval_chain(retriever_chain, create_stuff_documents_chain(llm, prompt))

conversation_rag_chain = get_conversational_rag_chain()

# === /stream ===
@app.route("/stream", methods=["POST"])
def stream():
    data = request.get_json()
    session_id = data.get("session_id", str(uuid4()))
    user_input = data.get("message")
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    def generate():
        answer = ""

        # === Pure RAG only ===
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": user_input}
            ):
                token = chunk.get("answer", "")
                answer += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        # Save session
        chat_sessions[session_id].append({"role": "user", "content": user_input})
        chat_sessions[session_id].append({"role": "assistant", "content": answer})

    return Response(
        stream_with_context(generate()),
        content_type="text/plain",
        headers={"Access-Control-Allow-Origin": "https://dsahdoctoraiassistantbot.onrender.com"}
    )

# === /generate ===
@app.route("/generate", methods=["POST"])
def generate():
    data = request.get_json()
    session_id = data.get("session_id", str(uuid4()))
    user_input = data.get("message", "")
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    response = conversation_rag_chain.invoke(
        {"chat_history": chat_sessions[session_id], "input": user_input}
    )
    answer = response["answer"]

    chat_sessions[session_id].append({"role": "user", "content": user_input})
    chat_sessions[session_id].append({"role": "assistant", "content": answer})

    return jsonify({"response": answer, "session_id": session_id})

# === /tts ===
@app.route("/tts", methods=["POST"])
def tts():
    text = (request.json or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "No text supplied"}), 400

    response = client.audio.speech.create(
        model="tts-1",
        voice="fable",
        input=text
    )
    audio_file = "temp_audio.mp3"
    response.stream_to_file(audio_file)
    with open(audio_file, "rb") as f:
        audio_bytes = f.read()
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    return jsonify({"audio_base64": audio_base64})

# === /reset ===
@app.route("/reset", methods=["POST"])
def reset():
    session_id = request.json.get("session_id")
    if session_id in chat_sessions:
        del chat_sessions[session_id]
    return jsonify({"message": "Session reset"}), 200

# === /start-quiz ===
@app.route("/start-quiz", methods=["POST"])
def start_quiz():
    data = request.json
    session_id = data.get("session_id", str(uuid4()))
    topic = data.get("topic", "IVF")
    difficulty = data.get("difficulty", "mixed")

    rag_prompt = (
        f"You are an IVF virtual training assistant. Generate exactly 20 multiple-choice questions on '{topic}'. "
        f"Each question must reflect '{difficulty}' difficulty level. Return them strictly as a JSON array. "
        "Each object must follow this format:\n"
        '{ "id": "q1", "text": "...", "options": ["A", "B", "C", "D"], "correct": "B", "difficulty": "easy" }\n'
        "Respond ONLY with valid JSON — no markdown, commentary, or explanations."
    )

    response = conversation_rag_chain.invoke(
        {"chat_history": chat_sessions.get(session_id, []), "input": rag_prompt}
    )
    raw_answer = response["answer"]
    raw_cleaned = re.sub(r"```json|```", "", raw_answer).strip()
    questions = json.loads(raw_cleaned)

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []
    chat_sessions[session_id].append({"role": "user", "content": rag_prompt})
    chat_sessions[session_id].append({"role": "assistant", "content": raw_answer})

    return jsonify({"questions": questions, "session_id": session_id})

# === /quiz-feedback-stream ===
@app.route("/quiz-feedback-stream", methods=["POST"])
def quiz_feedback_stream():
    data = request.get_json()
    session_id = data.get("session_id", str(uuid4()))
    prompt = data.get("prompt") or data.get("message", "").strip()
    context_items = data.get("context", [])

    context_string = "\n".join([
        f"Q: {item['text']}\nUser Answer: {item['userAnswer']}\nCorrect Answer: {item['correct']}"
        for item in context_items
    ]) if context_items else ""

    full_prompt = (
        f"You are a helpful IVF tutor. The following questions were answered incorrectly by the trainee:\n\n"
        f"{context_string}\n\nNow answer this question:\n{prompt}"
    )

    def generate():
        for chunk in conversation_rag_chain.stream(
            {"chat_history": chat_sessions.get(session_id, []), "input": full_prompt}
        ):
            yield chunk.get("answer", "")

    return Response(stream_with_context(generate()), content_type="text/plain")

# === /submit-quiz ===
performance_log = []

@app.route("/submit-quiz", methods=["POST"])
def submit_quiz():
    data = request.get_json()
    attempt_number = len(performance_log) + 1
    entry = {
        "attempt": attempt_number,
        "score": data.get("score", 0),
        "correct": data.get("correct", 0),
        "duration": data.get("duration_minutes", 0),
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M")
    }
    performance_log.append(entry)
    return jsonify({"status": "success", "attempt": attempt_number}), 200

@app.route("/quiz-performance", methods=["GET"])
def quiz_performance():
    return jsonify({
        "attempt": [e["attempt"] for e in performance_log],
        "score": [e["score"] for e in performance_log],
        "correct_answers": [e["correct"] for e in performance_log],
        "duration_minutes": [e["duration"] for e in performance_log],
        "timestamp": [e["timestamp"] for e in performance_log]
    })

# === /suggestions ===
@app.route("/suggestions", methods=["GET"])
def suggestions():
    # --- SOLUTION ---
    # 1. Create a list of different prompts tailored to AI Doctor Assistant
    prompt_templates = [
        "Please suggest 25 common and helpful diagnostic questions a doctor might ask when seeking a second opinion for a patient. Format them as a numbered list.",
        "Generate a list of 25 essential questions for supporting doctors in diagnosis and treatment planning. Focus on supplementing the doctor’s opinion with clinical reasoning and guidelines.",
        "What are 25 frequently asked questions doctors could use when evaluating differential diagnoses and treatment options? Return them in a numbered list format.",
        "Suggest 25 diverse clinical questions that guide analysis from patient history to diagnosis, investigations, and treatment planning. Provide a numbered list.",
        "As an AI Doctor Assistant, list 25 insightful questions that help doctors structure decision-making: diagnostics, risk/benefit assessment, treatment pathways, and patient safety. Return as a numbered list."
    ]

    # 2. Select a random prompt from the list
    random_prompt = random.choice(prompt_templates)

    # 3. Invoke the RAG chain with the selected prompt
    response = conversation_rag_chain.invoke({
        "chat_history": [],
        "input": random_prompt
    })
    
    raw = response.get("answer", "")
    lines = raw.split("\n")
    # 4. Clean and extract questions
    questions = [re.sub(r"^[\s•\-\d\.\)]+", "", line).strip() for line in lines if line.strip()]
    
    return jsonify({"suggested_questions": questions[:25]})


# === /mindmap ===
@app.route("/mindmap", methods=["POST"])
def mindmap():
    session_id = request.json.get("session_id", str(uuid4()))
    topic = request.json.get("topic", "IVF")

    rag_prompt = (
        f"You are an IVF training mind map assistant. Generate a JSON mind map for topic '{topic}'. "
        f"Use a valid JSON tree structure, no markdown or comments."
    )

    response = conversation_rag_chain.invoke(
        {"chat_history": chat_sessions.get(session_id, []), "input": rag_prompt}
    )
    raw_cleaned = re.sub(r"```json|```", "", response["answer"]).strip()
    nodes = json.loads(raw_cleaned)

    return jsonify({"nodes": nodes, "session_id": session_id})

# === /diagram ===
@app.route("/diagram", methods=["POST"])
def diagram():
    """
    Generates valid Mermaid code using OpenAI,
    extracts only the mermaid block,
    removes numbers inside square brackets.
    """
    session_id = request.json.get("session_id", str(uuid4()))
    topic = request.json.get("topic", "IVF Process Diagram")

    # Strict prompt for Mermaid syntax only
    prompt = (
        f"You are a diagram assistant for IVF related topics and training for IVF fellowships using diagrams and flowcharts to explain concepts. "
        f"For the topic '{topic}', produce a clear Mermaid diagram in this format:\n"
        "```mermaid\n"
        "graph TD\n"
        "Step1 --> Step2 --> Step3\n"
        "```\n"
        "Return ONLY the Mermaid block, wrapped in triple backticks. No explanations."
        "Ensure that your mermaid syntax is clean"
    )

    # Call OpenAI chat completion
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}]
    )
    raw_answer = response.choices[0].message.content

    # Extract Mermaid code
    match = re.search(r"```mermaid([\s\S]+?)```", raw_answer, re.IGNORECASE)
    mermaid_code = match.group(1).strip() if match else "graph TD\nA[Error] --> B[No diagram]"

    # Remove numbers inside [ ... ] brackets (e.g., [Step 1] -> [Step ])
    cleaned_mermaid = re.sub(r'\[([^\[\]]*?)\d+([^\[\]]*?)\]', r'[\1\2]', mermaid_code)

    return jsonify({
        "type": "mermaid",
        "syntax": cleaned_mermaid,
        "topic": topic
    })

@app.route("/websearch_trend", methods=["POST"])
def websearch_trend():
    try:
        data = request.get_json()
        user_input = data.get("query", "")

        if not user_input:
            return jsonify({"error": "No query provided"}), 400

        # Use OpenAI Responses API with web search tool
        stream = client.responses.create(
            model="gpt-4o",
            tools=[{"type": "web_search_preview"}],
            input=(
                f"For this query: '{user_input}', "
                f"search the web and return two fields:\n"
                f"1. A short explanation of the trend (under 400 characters).\n"
                f"2. A valid Highcharts JSON config using column or line chart.\n\n"
                f"Respond as a JSON object with two fields: 'explanation' and 'chartConfig'."
            )
        )

        # Convert the result to usable JSON
        raw_output = stream.output_text.strip()
        try:
            # Attempt to parse directly
            json_match = re.search(r"{.*}", raw_output, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                return jsonify(parsed), 200
            else:
                return jsonify({"error": "No JSON found in response", "raw": raw_output}), 400
        except json.JSONDecodeError:
            return jsonify({"error": "Malformed JSON in response", "raw": raw_output}), 400

    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500
# === /generate-followups ===
@app.route("/generate-followups", methods=["POST"])
def generate_followups():
    data = request.get_json()
    last_answer = data.get("last_answer", "")
    if not last_answer:
        return jsonify({"followups": []})

    followup_prompt = (
        f"Based on the following assistant response, generate 3 short and helpful follow-up questions "
        f"that the user might want to ask next, analyze the last answer :\n\n{last_answer}\n\n and provide a set of follow-up questions that are relevant to the topic discussed. "
        f"Format the response as a JSON array of strings."
    )

    try:
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": followup_prompt}
            ],
            temperature=0.7
        )

        text = completion.choices[0].message.content.strip()
        match = re.search(r'\[(.*?)\]', text, re.DOTALL)
        questions = json.loads(f"[{match.group(1)}]") if match else []
        return jsonify({"followups": questions})

    except Exception as e:
        print(f"Error generating followups: {e}")
        return jsonify({"followups": []})


# === Run ===
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)