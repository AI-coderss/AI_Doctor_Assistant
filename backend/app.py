import os
import tempfile
import ast
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
# ===== Helpers for dosage JSON handling =====
def _validate_dosage_payload(payload: dict):
    required = ["drug", "age", "weight", "condition"]
    for k in required:
        if k not in payload:
            return f"Missing field: {k}"
    try:
        age = float(payload["age"])
        weight = float(payload["weight"])
        if age <= 0 or weight <= 0:
            return "Age and weight must be positive numbers."
    except Exception:
        return "Age and weight must be numbers."
    if not str(payload["drug"]).strip():
        return "Invalid drug."
    if not str(payload["condition"]).strip():
        return "Invalid condition."
    return None


def _extract_json_dict(text: str):
    """
    Parse model output that may be:
      - pure JSON
      - fenced ```json ... ```
      - first JSON-looking block in the text
      - python-literal-compatible (last resort)
    """
    if not text:
        return None

    cleaned = re.sub(r"```json|```", "", text, flags=re.IGNORECASE).strip()

    # Try strict JSON first
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Fallback: first {...} block
    m = re.search(r"\{[\s\S]*\}", cleaned)
    if m:
        candidate = m.group(0)
        try:
            return json.loads(candidate)
        except Exception:
            try:
                obj = ast.literal_eval(candidate)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                pass
    return None


def _build_dosage_prompt(drug, age, weight, condition):
    """
    Builds the user message sent to your RAG chain.
    Your global system prompt (engineeredprompt) remains unchanged.
    """
    return (
        "CLINICAL DOSAGE CALCULATION REQUEST (ENGLISH ONLY).\n"
        "Use ONLY knowledge retrieved by the RAG chain (authoritative pharmaceutical books/guidelines). "
        "Consider adult vs pediatric dosing, renal/hepatic adjustments, and indication.\n\n"
        "Return STRICT JSON with EXACT keys: dosage, regimen, notes. No extra text.\n"
        "Schema:\n"
        "{\n"
        '  "dosage": "e.g., 500 mg every 8 hours",\n'
        '  "regimen": "e.g., Oral for 7 days",\n'
        '  "notes": "safety/monitoring/adjustments"\n'
        "}\n\n"
        f"Patient:\n- Drug: {drug}\n- Age: {age} years\n- Weight: {weight} kg\n- Condition: {condition}\n"
    )


# ====== NEW: /transcribe ======
@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio_data" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio_data"]
    supported = ['flac','m4a','mp3','mp4','mpeg','mpga','oga','ogg','wav','webm']
    ext = audio_file.filename.split('.')[-1].lower()
    if ext not in supported:
        return jsonify({"error": f"Unsupported file format: {ext}. Supported: {supported}"}), 400

    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
        audio_file.save(tmp.name)
        temp_path = tmp.name

    try:
        # Whisper transcription (English)
        with open(temp_path, "rb") as f:
            # whisper-1 or gpt-4o-transcribe depending on availability
            result = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="text"
            )
        transcript_text = result if isinstance(result, str) else str(result)
    finally:
        try: os.remove(temp_path)
        except: pass

    return jsonify({"transcript": transcript_text})

# ====== NEW: /case-second-opinion-stream ======
@app.route("/case-second-opinion-stream", methods=["POST"])
def case_second_opinion_stream():
    data = request.get_json() or {}
    context = (data.get("context") or "").strip()
    session_id = data.get("session_id", str(uuid4()))

    if not context:
        return jsonify({"error": "No context provided"}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    # Force a structured medical answer; English only; allows Mermaid at end if model decides
    structured_instruction = (
        "SECOND OPINION CASE ANALYSIS.\n"
        "Using ONLY the transcript and retrieved clinical knowledge, respond in ENGLISH with the following exact sections:\n\n"
        "The diagnosis:\n"
        "The differential diagnosis:\n"
        "The recommended lab test and investigation:\n"
        "Drug prescriptions:\n"
        "Recommendations to The Doctor:\n"
        "Treatment plan:\n\n"
        "Keep it specific and evidence-aware; include dosages when appropriate. "
        "If helpful, you MAY append a flow pathway as a Mermaid block wrapped in ```mermaid ...```."
    )

    rag_input = (
        f"{structured_instruction}\n\n"
        f"Patient consultation transcript:\n{context}\n"
    )

    def generate():
        answer_acc = ""
        try:
            for chunk in conversation_rag_chain.stream({
                "chat_history": chat_sessions.get(session_id, []),
                "input": rag_input
            }):
                token = chunk.get("answer", "")
                answer_acc += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        # persist into chat history after streaming completes
        chat_sessions.setdefault(session_id, [])
        chat_sessions[session_id].append({"role": "user", "content": "[Voice Transcript Submitted]"})
        chat_sessions[session_id].append({"role": "assistant", "content": answer_acc})

    return Response(stream_with_context(generate()), content_type="text/plain")

# ===== existing endpoints (unchanged) =====

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
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": user_input}
            ):
                token = chunk.get("answer", "")
                answer += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        chat_sessions[session_id].append({"role": "user", "content": user_input})
        chat_sessions[session_id].append({"role": "assistant", "content": answer})

    return Response(stream_with_context(generate()), content_type="text/plain")

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

@app.route("/tts", methods=["POST"])
def tts():
    text = (request.json or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "No text supplied"}), 400

    response = client.audio.speech.create(model="tts-1", voice="fable", input=text)
    audio_file = "temp_audio.mp3"
    response.stream_to_file(audio_file)
    with open(audio_file, "rb") as f:
        audio_bytes = f.read()
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    return jsonify({"audio_base64": audio_base64})

@app.route("/reset", methods=["POST"])
def reset():
    session_id = request.json.get("session_id")
    if session_id in chat_sessions:
        del chat_sessions[session_id]
    return jsonify({"message": "Session reset"}), 200


@app.route("/suggestions", methods=["GET"])
def suggestions():
    prompt_templates = [
        "Please suggest 25 common and helpful diagnostic questions a doctor might ask when seeking a second opinion for a patient. Format them as a numbered list.",
        "Generate a list of 25 essential questions for supporting doctors in diagnosis and treatment planning. Focus on supplementing the doctor’s opinion with clinical reasoning and guidelines.",
        "What are 25 frequently asked questions doctors could use when evaluating differential diagnoses and treatment options? Return them in a numbered list format.",
        "Suggest 25 diverse clinical questions that guide analysis from patient history to diagnosis, investigations, and treatment planning. Provide a numbered list.",
        "As an AI Doctor Assistant, list 25 insightful questions that help doctors structure decision-making: diagnostics, risk/benefit assessment, treatment pathways, and patient safety. Return as a numbered list."
    ]
    random_prompt = random.choice(prompt_templates)
    response = conversation_rag_chain.invoke({"chat_history": [], "input": random_prompt})
    raw = response.get("answer", "")
    lines = raw.split("\n")
    questions = [re.sub(r"^[\s•\-\d\.\)]+", "", line).strip() for line in lines if line.strip()]
    return jsonify({"suggested_questions": questions[:25]})

@app.route("/mindmap", methods=["POST"])
def mindmap():
    session_id = request.json.get("session_id", str(uuid4()))
    topic = request.json.get("topic", "IVF")
    rag_prompt = (
        f"You are an IVF training mind map assistant. Generate a JSON mind map for topic '{topic}'. "
        f"Use a valid JSON tree structure, no markdown or comments."
    )
    response = conversation_rag_chain.invoke({"chat_history": chat_sessions.get(session_id, []), "input": rag_prompt})
    raw_cleaned = re.sub(r"```json|```", "", response["answer"]).strip()
    nodes = json.loads(raw_cleaned)
    return jsonify({"nodes": nodes, "session_id": session_id})

@app.route("/diagram", methods=["POST"])
def diagram():
    session_id = request.json.get("session_id", str(uuid4()))
    topic = request.json.get("topic", "IVF Process Diagram")
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
    response = client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": prompt}])
    raw_answer = response.choices[0].message.content
    match = re.search(r"```mermaid([\s\S]+?)```", raw_answer, re.IGNORECASE)
    mermaid_code = match.group(1).strip() if match else "graph TD\nA[Error] --> B[No diagram]"
    cleaned_mermaid = re.sub(r'\[([^\[\]]*?)\d+([^\[\]]*?)\]', r'[\1\2]', mermaid_code)
    return jsonify({"type": "mermaid", "syntax": cleaned_mermaid, "topic": topic})
# ===== NEW: /calculate-dosage-stream =====
@app.route("/calculate-dosage-stream", methods=["POST"])
def calculate_dosage_stream():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    err = _validate_dosage_payload(data)
    if err:
        return jsonify({"error": err}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    drug = str(data["drug"]).strip()
    age = float(data["age"])
    weight = float(data["weight"])
    condition = str(data["condition"]).strip()

    prompt = _build_dosage_prompt(drug, age, weight, condition)

    def generate():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": prompt}
            ):
                token = chunk.get("answer", "")
                acc += token
                yield token
        except Exception as e:
            yield f'\n{{"error":"Vector error: {str(e)}"}}'

        chat_sessions[session_id].append({
            "role": "user",
            "content": f"[Dosage Request] {drug} / {age}y / {weight}kg / {condition}"
        })
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(generate()), content_type="text/plain")
# ===== NEW: /calculate-dosage =====
@app.route("/calculate-dosage", methods=["POST"])
def calculate_dosage():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    err = _validate_dosage_payload(data)
    if err:
        return jsonify({"error": err}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    drug = str(data["drug"]).strip()
    age = float(data["age"])
    weight = float(data["weight"])
    condition = str(data["condition"]).strip()

    prompt = _build_dosage_prompt(drug, age, weight, condition)

    try:
        # Use your existing LangChain RAG chain
        response = conversation_rag_chain.invoke(
            {"chat_history": chat_sessions[session_id], "input": prompt}
        )
        raw_answer = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw_answer)

        if not parsed or not isinstance(parsed, dict):
            return jsonify({
                "error": "The model did not return valid JSON.",
                "raw": raw_answer[:2000]
            }), 502

        dosage  = str(parsed.get("dosage", "")).strip()
        regimen = str(parsed.get("regimen", "")).strip()
        notes   = str(parsed.get("notes", "")).strip()
        if not (dosage and regimen):
            return jsonify({
                "error": "Incomplete dosage JSON from model.",
                "raw": raw_answer[:2000]
            }), 502

        # Persist to history (optional, consistent with your pattern)
        chat_sessions[session_id].append({
            "role": "user",
            "content": f"[Dosage Request] {drug} / {age}y / {weight}kg / {condition}"
        })
        chat_sessions[session_id].append({"role": "assistant", "content": raw_answer})

        return jsonify({
            "dosage": dosage,
            "regimen": regimen,
            "notes": notes,
            "session_id": session_id
        }), 200

    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500
# ========== ADDITIONS: CONTEXT & SMART DOSAGE (APPEND ONLY) ==========

# Per-session structured context extracted from transcript
# session_context[session_id] = {
#   "transcript": str,
#   "condition": str|None,
#   "description": str|None,
#   "age_years": float|None,
#   "weight_kg": float|None,
#   "drug_suggestions": list[str]
# }
session_context = {}

def _build_context_extraction_prompt(transcript: str, topn: int = 10) -> str:
    """
    Ask the RAG chain to extract a tiny, strict-JSON summary from the transcript.
    """
    return (
        "From the following patient consultation transcript, extract STRICT JSON only:\n"
        "{\n"
        '  "condition": "primary condition or working diagnosis (short)",\n'
        '  "description": "1-2 sentence summary of the case (English)",\n'
        '  "age_years": number | null,\n'
        '  "weight_kg": number | null,\n'
        f'  "drug_suggestions": ["top {topn} plausible generic drugs for this condition"]\n'
        "}\n"
        "If unknown, use null or an empty list. Do not invent values.\n\n"
        f"Transcript:\n{transcript}\n"
    )

def _build_drug_suggestion_prompt(condition: str, topn: int = 12) -> str:
    """
    Get a list of drug suggestions for a given condition. Strict JSON.
    """
    return (
        "Return STRICT JSON with key 'drugs' as an array of strings (generic names only).\n"
        f"Condition: {condition}\n"
        f"Top {topn} commonly used evidence-based candidates.\n"
        '{ "drugs": ["...", "..."] }'
    )

def _merge_with_context(session_id: str, data: dict) -> dict:
    """
    Merge incoming payload with saved session context (if any) so we can
    call your existing strict validator without changing it.
    """
    ctx = session_context.get(session_id, {})
    merged = {
        "drug": data.get("drug"),
        "age": data.get("age", ctx.get("age_years")),
        "weight": data.get("weight", ctx.get("weight_kg")),
        "condition": data.get("condition", ctx.get("condition")),
    }
    # Normalize numeric strings
    try:
        if merged["age"] not in (None, ""):
            merged["age"] = float(merged["age"])
    except Exception:
        pass
    try:
        if merged["weight"] not in (None, ""):
            merged["weight"] = float(merged["weight"])
    except Exception:
        pass
    return merged

@app.route("/set-context", methods=["POST"])
def set_context():
    """
    Body: { session_id?, transcript }
    Stores transcript-derived context for later auto-fill.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "No transcript provided"}), 400

    try:
        response = conversation_rag_chain.invoke({
            "chat_history": chat_sessions.get(session_id, []),
            "input": _build_context_extraction_prompt(transcript)
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw) or {}
    except Exception as e:
        parsed = {}

    context_obj = {
        "transcript": transcript,
        "condition": parsed.get("condition"),
        "description": parsed.get("description"),
        "age_years": parsed.get("age_years"),
        "weight_kg": parsed.get("weight_kg"),
        "drug_suggestions": parsed.get("drug_suggestions") or [],
    }
    session_context[session_id] = context_obj
    return jsonify({"session_id": session_id, **context_obj}), 200

@app.route("/context", methods=["GET"])
def get_context():
    """
    Query params: ?session_id=...
    Returns stored context (if any) so the front-end can prefill the calculator.
    """
    session_id = request.args.get("session_id", "")
    ctx = session_context.get(session_id)
    if not session_id or not ctx:
        return jsonify({"exists": False}), 200
    return jsonify({"exists": True, "session_id": session_id, **ctx}), 200

@app.route("/suggest-drugs", methods=["POST"])
def suggest_drugs():
    """
    Body: { session_id?, condition? }
    Uses provided condition, otherwise from session context.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    condition = (data.get("condition") or (session_context.get(session_id, {}) or {}).get("condition") or "").strip()
    if not condition:
        return jsonify({"error": "No condition available"}), 400

    try:
        response = conversation_rag_chain.invoke({
            "chat_history": chat_sessions.get(session_id, []),
            "input": _build_drug_suggestion_prompt(condition)
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw) or {}
        drugs = parsed.get("drugs") or []
    except Exception:
        drugs = []

    # Merge with previously stored suggestions for that session
    ctx = session_context.setdefault(session_id, {})
    prev = ctx.get("drug_suggestions") or []
    merged = list(dict.fromkeys([*drugs, *prev]))[:15]
    ctx["drug_suggestions"] = merged
    if "condition" not in ctx:
        ctx["condition"] = condition

    return jsonify({"session_id": session_id, "condition": condition, "drugs": merged}), 200

@app.route("/summarize-case", methods=["POST"])
def summarize_case():
    """
    Body: { session_id?, transcript? }
    Returns a compact English summary + key fields for UI display.
    If transcript omitted, uses stored transcript (if available).
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or (session_context.get(session_id, {}) or {}).get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "No transcript available"}), 400

    # Reuse the same extraction prompt to keep things consistent
    try:
        response = conversation_rag_chain.invoke({
            "chat_history": chat_sessions.get(session_id, []),
            "input": _build_context_extraction_prompt(transcript, topn=8)
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw) or {}
    except Exception:
        parsed = {}

    # Update stored context (non-destructive)
    ctx = session_context.setdefault(session_id, {})
    for k in ("condition", "description", "age_years", "weight_kg"):
        if parsed.get(k) not in (None, "", []):
            ctx[k] = parsed.get(k)
    if parsed.get("drug_suggestions"):
        ctx["drug_suggestions"] = parsed["drug_suggestions"]

    return jsonify({"session_id": session_id, **ctx}), 200

@app.route("/calculate-dosage-with-context", methods=["POST"])
def calculate_dosage_with_context():
    """
    Body: { session_id?, drug?, age?, weight?, condition? }
    Fills any missing fields from stored session context, then delegates to your
    existing validation + RAG logic (unchanged).
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    merged = _merge_with_context(session_id, data)

    # Ensure all required fields exist before calling your strict validator
    missing = [k for k in ("drug", "age", "weight", "condition") if merged.get(k) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing field(s): {', '.join(missing)}"}), 400

    # Now call your existing builder & chain (exactly as in /calculate-dosage)
    try:
        prompt = _build_dosage_prompt(
            str(merged["drug"]).strip(),
            float(merged["age"]),
            float(merged["weight"]),
            str(merged["condition"]).strip(),
        )
        response = conversation_rag_chain.invoke(
            {"chat_history": chat_sessions.get(session_id, []), "input": prompt}
        )
        raw_answer = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw_answer)

        if not parsed or not isinstance(parsed, dict):
            return jsonify({"error": "The model did not return valid JSON.", "raw": raw_answer[:2000]}), 502

        dosage  = str(parsed.get("dosage", "")).strip()
        regimen = str(parsed.get("regimen", "")).strip()
        notes   = str(parsed.get("notes", "")).strip()
        if not (dosage and regimen):
            return jsonify({"error": "Incomplete dosage JSON from model.", "raw": raw_answer[:2000]}), 502

        # Persist to history similar to your existing pattern
        chat_sessions.setdefault(session_id, [])
        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage+Ctx] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": raw_answer})

        return jsonify({"dosage": dosage, "regimen": regimen, "notes": notes, "session_id": session_id}), 200

    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

@app.route("/calculate-dosage-stream-with-context", methods=["POST"])
def calculate_dosage_stream_with_context():
    """
    Streaming variant that auto-fills from context before building the prompt.
    Body: { session_id?, drug?, age?, weight?, condition? }
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    merged = _merge_with_context(session_id, data)

    missing = [k for k in ("drug", "age", "weight", "condition") if merged.get(k) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing field(s): {', '.join(missing)}"}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    prompt = _build_dosage_prompt(
        str(merged["drug"]).strip(),
        float(merged["age"]),
        float(merged["weight"]),
        str(merged["condition"]).strip(),
    )

    def generate():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": prompt}
            ):
                token = chunk.get("answer", "")
                acc += token
                yield token
        except Exception as e:
            yield f'\n{{"error":"Vector error: {str(e)}"}}'

        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage+Ctx] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(generate()), content_type="text/plain")
# ========== END ADDITIONS ==========



if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
