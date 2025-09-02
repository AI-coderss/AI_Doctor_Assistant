# app.py — Flask + LangChain RAG + Qdrant + OpenAI
import os, tempfile, ast, json, re, base64, random
from uuid import uuid4
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS

import qdrant_client
from openai import OpenAI

from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_qdrant import Qdrant
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from prompts.prompt import engineeredprompt  # your existing system prompt

# ========= Boot =========
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

client = OpenAI()
chat_sessions = {}
collection_name = os.getenv("QDRANT_COLLECTION_NAME")

# Holds per-session case context extracted from transcript
# session_context[session_id] = {
#   "transcript": "...",
#   "condition": "Bronchitis",
#   "age_years": 45,
#   "weight_kg": 70,
#   "drug_suggestions": ["Amoxicillin", "Azithromycin", ...]
# }
session_context = {}

# ========= Vector store & RAG =========
def get_vector_store():
    qdrant = qdrant_client.QdrantClient(
        url=os.getenv("QDRANT_HOST"),
        api_key=os.getenv("QDRANT_API_KEY"),
        timeout=60.0
    )
    embeddings = OpenAIEmbeddings()
    return Qdrant(client=qdrant, collection_name=collection_name, embeddings=embeddings)

vector_store = get_vector_store()

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

# ========= Helpers =========
def _validate_dosage_payload(payload: dict):
    # Only 'drug' is strictly required now; age/weight/condition may come from context
    if "drug" not in payload or not str(payload["drug"]).strip():
        return "Invalid drug."
    # If age/weight are present, must be positive
    for k in ("age", "weight"):
        if k in payload and payload[k] not in (None, ""):
            try:
                v = float(payload[k])
                if v <= 0:
                    return f"{k.capitalize()} must be a positive number."
            except Exception:
                return f"{k.capitalize()} must be a number."
    return None

def _extract_json_dict(text: str):
    if not text:
        return None
    cleaned = re.sub(r"```json|```", "", text, flags=re.IGNORECASE).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        pass
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
    age_txt = "unknown" if age is None else f"{age}"
    weight_txt = "unknown" if weight is None else f"{weight}"
    cond_txt = condition or "unknown"
    return (
        "CLINICAL DOSAGE CALCULATION REQUEST (ENGLISH ONLY).\n"
        "Use ONLY knowledge retrieved by the RAG chain (authoritative pharmaceutical books/guidelines). "
        "Consider adult vs pediatric dosing, renal/hepatic adjustments, max daily doses, route & frequency.\n\n"
        "Return STRICT JSON with EXACT keys: dosage, regimen, notes. No extra text.\n"
        "Schema:\n"
        "{\n"
        '  "dosage": "e.g., 500 mg every 8 hours",\n'
        '  "regimen": "e.g., Oral for 7 days",\n'
        '  "notes": "safety/monitoring/adjustments"\n'
        "}\n\n"
        f"Patient:\n- Drug: {drug}\n- Age: {age_txt} years\n- Weight: {weight_txt} kg\n- Condition: {cond_txt}\n"
    )

def _build_context_extraction_prompt(transcript, topn=8):
    return (
        "From the following patient consultation transcript, extract these fields as STRICT JSON (no extra text):\n"
        "{\n"
        '  "condition": "short primary condition/diagnosis or reason for visit",\n'
        '  "age_years": number | null,\n'
        '  "weight_kg": number | null,\n'
        f'  "drug_suggestions": ["top {topn} evidence-based candidate drugs for the condition (generic names)"]\n'
        "}\n"
        "If a value is not found, use null or an empty list. DO NOT invent values.\n\n"
        f"Transcript:\n{transcript}\n"
    )

def _build_drug_suggestion_prompt(condition, topn=10):
    return (
        "Return STRICT JSON only with key 'drugs' as an array of strings.\n"
        f"For the condition '{condition}', list the top {topn} commonly used evidence-based DRUG NAMES (generic) "
        "suitable for initial consideration (do not include dose here).\n"
        '{ "drugs": ["...", "..."] }'
    )

# ========= Transcription (kept) =========
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
        with open(temp_path, "rb") as f:
            result = client.audio.transcriptions.create(model="whisper-1", file=f, response_format="text")
        transcript_text = result if isinstance(result, str) else str(result)
    finally:
        try: os.remove(temp_path)
        except: pass
    return jsonify({"transcript": transcript_text})

# ========= NEW: Context endpoints =========
@app.route("/set-context", methods=["POST"])
def set_context():
    """
    Store transcript, extract condition/age/weight and drug suggestions via RAG.
    Body: { session_id?, transcript }
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "No transcript provided"}), 400

    # Extract JSON using RAG
    try:
        response = conversation_rag_chain.invoke({
            "chat_history": chat_sessions.get(session_id, []),
            "input": _build_context_extraction_prompt(transcript)
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw) or {}
    except Exception as e:
        parsed = {}

    context = {
        "transcript": transcript,
        "condition": parsed.get("condition"),
        "age_years": parsed.get("age_years"),
        "weight_kg": parsed.get("weight_kg"),
        "drug_suggestions": parsed.get("drug_suggestions") or [],
    }
    session_context[session_id] = context
    return jsonify({"session_id": session_id, **context}), 200

@app.route("/context", methods=["GET"])
def get_context():
    session_id = request.args.get("session_id")
    if not session_id or session_id not in session_context:
        return jsonify({"exists": False})
    return jsonify({"exists": True, "session_id": session_id, **session_context[session_id]})

@app.route("/suggest-drugs", methods=["POST"])
def suggest_drugs():
    """
    Body: { session_id?, condition? }
    Uses provided condition or the one in session_context.
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

    # Merge with any previously stored suggestions
    ctx = session_context.setdefault(session_id, {})
    prev = ctx.get("drug_suggestions") or []
    merged = list(dict.fromkeys([*drugs, *prev]))[:15]
    ctx["drug_suggestions"] = merged
    if "condition" not in ctx:
        ctx["condition"] = condition

    return jsonify({"session_id": session_id, "condition": condition, "drugs": merged})

# ========= Case analysis stream (kept) =========
@app.route("/case-second-opinion-stream", methods=["POST"])
def case_second_opinion_stream():
    data = request.get_json() or {}
    context = (data.get("context") or "").strip()
    session_id = data.get("session_id", str(uuid4()))
    if not context:
        return jsonify({"error": "No context provided"}), 400
    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

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
    rag_input = f"{structured_instruction}\n\nPatient consultation transcript:\n{context}\n"

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
        chat_sessions.setdefault(session_id, [])
        chat_sessions[session_id].append({"role": "user", "content": "[Voice Transcript Submitted]"})
        chat_sessions[session_id].append({"role": "assistant", "content": answer_acc})

    return Response(stream_with_context(generate()), content_type="text/plain")

# ========= Chat endpoints (kept light) =========
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
            for chunk in conversation_rag_chain.stream({"chat_history": chat_sessions[session_id], "input": user_input}):
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
    response = conversation_rag_chain.invoke({"chat_history": chat_sessions[session_id], "input": user_input})
    answer = response["answer"]
    chat_sessions[session_id].append({"role": "user", "content": user_input})
    chat_sessions[session_id].append({"role": "assistant", "content": answer})
    return jsonify({"response": answer, "session_id": session_id})

# ========= TTS (kept) =========
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
    if session_id in session_context:
        del session_context[session_id]
    return jsonify({"message": "Session reset"}), 200

# ========= Dosage (context-aware) =========
@app.route("/calculate-dosage-stream", methods=["POST"])
def calculate_dosage_stream():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    # Merge payload with session_context if missing fields
    ctx = session_context.get(session_id, {})
    merged = {
        "drug": data.get("drug"),
        "age": data.get("age", ctx.get("age_years")),
        "weight": data.get("weight", ctx.get("weight_kg")),
        "condition": data.get("condition", ctx.get("condition")),
    }
    err = _validate_dosage_payload(merged)
    if err:
        return jsonify({"error": err}), 400
    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    prompt = _build_dosage_prompt(
        str(merged["drug"]).strip(),
        float(merged["age"]) if merged["age"] not in (None, "") else None,
        float(merged["weight"]) if merged["weight"] not in (None, "") else None,
        (merged["condition"] or "").strip() or None
    )

    def generate():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream({"chat_history": chat_sessions[session_id], "input": prompt}):
                token = chunk.get("answer", "")
                acc += token
                yield token
        except Exception as e:
            yield f'\n{{"error":"Vector error: {str(e)}"}}'
        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage Request] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(generate()), content_type="text/plain")

@app.route("/calculate-dosage", methods=["POST"])
def calculate_dosage():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    ctx = session_context.get(session_id, {})
    merged = {
        "drug": data.get("drug"),
        "age": data.get("age", ctx.get("age_years")),
        "weight": data.get("weight", ctx.get("weight_kg")),
        "condition": data.get("condition", ctx.get("condition")),
    }
    err = _validate_dosage_payload(merged)
    if err:
        return jsonify({"error": err}), 400
    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    prompt = _build_dosage_prompt(
        str(merged["drug"]).strip(),
        float(merged["age"]) if merged["age"] not in (None, "") else None,
        float(merged["weight"]) if merged["weight"] not in (None, "") else None,
        (merged["condition"] or "").strip() or None
    )

    try:
        response = conversation_rag_chain.invoke({"chat_history": chat_sessions[session_id], "input": prompt})
        raw_answer = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw_answer)
        if not parsed or not isinstance(parsed, dict):
            return jsonify({"error": "The model did not return valid JSON.", "raw": raw_answer[:2000]}), 502
        dosage  = str(parsed.get("dosage", "")).strip()
        regimen = str(parsed.get("regimen", "")).strip()
        notes   = str(parsed.get("notes", "")).strip()
        if not (dosage and regimen):
            return jsonify({"error": "Incomplete dosage JSON from model.", "raw": raw_answer[:2000]}), 502
        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage Request] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": raw_answer})
        return jsonify({"dosage": dosage, "regimen": regimen, "notes": notes, "session_id": session_id}), 200
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

# ========= Run =========
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)

