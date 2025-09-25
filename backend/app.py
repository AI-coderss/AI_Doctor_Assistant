import os
import tempfile
import ast
from uuid import uuid4
from datetime import datetime
import json
import logging
import requests
import re
import base64
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.utils import secure_filename
import os.path as osp
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
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not OPENAI_API_KEY:
    raise RuntimeError("Missing OPENAI_API_KEY")
# ===== Adaptive Specialty Templates (session-scoped) =====
ACTIVE_TEMPLATES = {}  # session_id -> {"specialty": str, "template": dict, "activated_at": iso}
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY")

# Provider plan guard (per OCR.Space docs: Free≈1MB, PRO≈5MB, PRO PDF≈100MB+)
# This is a best-effort early guard; the provider still enforces its own limits.
PROVIDER_LIMIT_MB = int(os.getenv("OCR_PROVIDER_LIMIT_MB", "1"))  # 1|5|100

# Flask request cap (bytes); keep >= provider limit (default 20MB)
MAX_BYTES = int(os.getenv("OCR_MAX_BYTES", 20 * 1024 * 1024))

ALLOWED_EXTS = {"pdf", "png", "jpg", "jpeg", "tif", "tiff", "webp"}

def _build_specialty_template_prompt(specialty: str) -> str:
    """
    Ask the LLM to RETURN STRICT JSON ONLY for a specialty note template.
    The JSON includes ordered sections, fields, and suggested follow-up questions.
    """
    return (
        "You are a clinical template designer. RETURN STRICT JSON ONLY.\n"
        "Schema:\n"
        "{\n"
        '  "specialty": "lowercase specialty name",\n'
        '  "sections": [\n'
        '     {"title":"Subjective","fields":["..."]},\n'
        '     {"title":"Objective","fields":["..."]},\n'
        '     {"title":"Assessment","fields":["..."]},\n'
        '     {"title":"Plan","fields":["..."]}\n'
        "  ],\n"
        '  "follow_up_questions":[ "short, direct clinician prompts..." ],\n'
        '  "style": {"tone":"concise, clinical","bullets":true,"icd_cpt_suggestions":true}\n'
        "}\n"
        "Rules:\n"
        "- Use standard SOAP variants suitable for the specialty.\n"
        "- Add 6–10 precise follow_up_questions a doctor would ask for this specialty.\n"
        f"- Specialty: {specialty}\n"
    )

def _safe_json_dict(text: str):
    # re-use your existing tolerant parser if you prefer
    try:
        return json.loads(re.sub(r"```json|```", "", (text or "").strip(), flags=re.I))
    except Exception:
        m = re.search(r"\{[\s\S]*\}", text or "")
        if m:
            try: return json.loads(m.group(0))
            except Exception: pass
    return None

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
        ],
    r"/api/rtc-transcribe-connect": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
                ],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    },
    r"/analyze-form-case-stream": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
        ],
        "methods": ["POST"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    },
    r"api/rtc-transcribe-nodes-connect": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
        ],
        "methods": ["POST"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    },
    r"ocr": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
        ],
        "methods": ["POST"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    }},
    r"/api/ocr": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000"
        ],
        "methods": ["POST"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    }
})
# Optional: hard cap request size (mirrors OCR_MAX_BYTES)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("OCR_MAX_BYTES", 20 * 1024 * 1024))


chat_sessions = {}
collection_name = os.getenv("QDRANT_COLLECTION_NAME")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("rtc-transcribe")

OAI_BASE = "https://api.openai.com/v1"
COMMON_JSON_HEADERS = {
    "Authorization": f"Bearer {OPENAI_API_KEY}",
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
}

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
      ("system", engineeredprompt+"If lab results would materially improve the assessment, append the exact token [request_labs] once.\n\n"),
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
# ========== STRICT CONTEXT EXTRACTION & ROBUST CONTEXT-AWARE ENDPOINTS ==========

# Per-session structured context extracted from transcript
# session_context[session_id] = {
#   "transcript": str|None,
#   "condition": str|None,
#   "description": str|None,
#   "age_years": float|None,
#   "weight_kg": float|None,
#   "drug_suggestions": list[str]
# }
session_context = globals().get("session_context", {})
if session_context is None:
    session_context = {}

def _coerce_float(x):
    try:
        if x in (None, "", "null"):
            return None
        return float(x)
    except Exception:
        return None

def _extract_numbers_fallback(transcript: str):
    """
    Heuristic fallback if LLM JSON missed numbers.
    Looks for age (years) and weight (kg).
    """
    if not transcript:
        return {}
    t = transcript.lower()

    age = None
    weight = None

    # Age patterns
    # e.g., "45 years", "45 yrs", "45 y/o", "age 45"
    age_patterns = [
        r'age\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)',
        r'(\d{1,3}(?:\.\d+)?)\s*(?:years?|yrs?|y/o)\b',
    ]
    for pat in age_patterns:
        m = re.search(pat, t)
        if m:
            age = _coerce_float(m.group(1))
            break

    # Weight patterns
    # e.g., "70 kg", "wt 70 kg", "weight: 72.5 kg"
    weight_patterns = [
        r'weight\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*kg',
        r'wt\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*kg',
        r'\b(\d{1,3}(?:\.\d+)?)\s*kg\b',
    ]
    for pat in weight_patterns:
        m = re.search(pat, t)
        if m:
            weight = _coerce_float(m.group(1))
            break

    return {"age_years": age, "weight_kg": weight}

def _build_context_extraction_prompt_strict(transcript: str, topn: int = 12) -> str:
    """
    Very strict JSON-only extraction with fixed keys.
    """
    return (
        "You are a clinical information extractor. Return STRICT JSON ONLY.\n"
        "Schema:\n"
        "{\n"
        '  "condition": "short primary condition/working diagnosis in English (no ICD code)",\n'
        '  "description": "one short sentence summary in English",\n'
        '  "age_years": number | null,\n'
        '  "weight_kg": number | null,\n'
        f'  "drug_suggestions": ["top {topn} plausible generic drugs (lowercase generic names)"]\n'
        "}\n"
        "Rules:\n"
        "- Use null when unknown; do NOT invent values.\n"
        "- drug_suggestions must be an array; items must be unique, generic names only.\n"
        "- No markdown, no additional text.\n\n"
        f"Transcript:\n{transcript}\n"
    )

def _strict_llm_json(prompt: str):
    """
    Calls your LangChain RAG chain, tries hard to parse strict JSON out.
    """
    try:
        response = conversation_rag_chain.invoke({
            "chat_history": [],
            "input": prompt
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}

def _extract_case_fields_strict(transcript: str, topn: int = 12):
    """
    Combines strict LLM JSON with regex fallback for age/weight.
    """
    data = _strict_llm_json(_build_context_extraction_prompt_strict(transcript, topn=topn)) or {}
    # Normalize
    condition = (data.get("condition") or "").strip() or None
    description = (data.get("description") or "").strip() or None
    age_years = _coerce_float(data.get("age_years"))
    weight_kg = _coerce_float(data.get("weight_kg"))
    drug_suggestions = list(dict.fromkeys([*(data.get("drug_suggestions") or [])]))  # unique-preserving

    # Fallback for numbers
    if age_years is None or weight_kg is None:
        nums = _extract_numbers_fallback(transcript or "")
        age_years = age_years if age_years is not None else nums.get("age_years")
        weight_kg = weight_kg if weight_kg is not None else nums.get("weight_kg")

    return {
        "transcript": transcript or None,
        "condition": condition,
        "description": description,
        "age_years": age_years,
        "weight_kg": weight_kg,
        "drug_suggestions": drug_suggestions,
    }

def _merge_with_context(session_id: str, data: dict) -> dict:
    """
    Merge incoming payload with saved session context.
    """
    ctx = session_context.get(session_id, {})
    merged = {
        "drug": (data.get("drug") or "").strip() or None,
        "age": _coerce_float(data.get("age")) if data.get("age") not in (None, "") else ctx.get("age_years"),
        "weight": _coerce_float(data.get("weight")) if data.get("weight") not in (None, "") else ctx.get("weight_kg"),
        "condition": (data.get("condition") or ctx.get("condition") or None),
    }
    return merged

def _ensure_context(session_id: str, transcript: str = None, topn: int = 12):
    """
    Ensures we have a usable context; if missing or incomplete and transcript
    is available, extract and store it.
    """
    ctx = session_context.get(session_id, {})
    need_extract = (
        not ctx
        or ctx.get("condition") in (None, "")
        or ctx.get("age_years") is None
        or ctx.get("weight_kg") is None
        or not ctx.get("drug_suggestions")
    )
    if need_extract and (transcript or ctx.get("transcript")):
        source_transcript = transcript or ctx.get("transcript")
        new_ctx = _extract_case_fields_strict(source_transcript, topn=topn)
        # Merge (prefer new non-empty values)
        merged = {
            **ctx,
            **{k: v for k, v in new_ctx.items() if v not in (None, "", [])}
        }
        session_context[session_id] = merged
        return merged
    # Ensure dict exists
    session_context.setdefault(session_id, ctx)
    return session_context[session_id]

@app.route("/set-context", methods=["POST"])
def set_context():
    """
    Body: { session_id?, transcript }
    Performs strict extraction and stores context.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "No transcript provided"}), 400

    ctx = _extract_case_fields_strict(transcript)
    session_context[session_id] = ctx
    return jsonify({"session_id": session_id, **ctx}), 200

@app.route("/context", methods=["GET"])
def get_context():
    """
    Query: ?session_id=...
    """
    session_id = request.args.get("session_id", "")
    ctx = session_context.get(session_id)
    if not session_id or not ctx:
        return jsonify({"exists": False}), 200
    return jsonify({"exists": True, "session_id": session_id, **ctx}), 200

@app.route("/context-ensure", methods=["POST"])
def context_ensure():
    """
    Body: { session_id?, transcript? }
    If context missing/incomplete, extract it (uses transcript if given).
    Returns final context.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip() or None
    ctx = _ensure_context(session_id, transcript=transcript)
    return jsonify({"session_id": session_id, **ctx, "exists": bool(ctx)}), 200

@app.route("/suggest-drugs", methods=["POST"])
def suggest_drugs():
    """
    Body: { session_id?, condition?, transcript? }
    Uses provided condition or stored/extracted one; returns candidate drugs.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip() or None

    # Ensure context (may extract from transcript)
    ctx = _ensure_context(session_id, transcript=transcript)
    condition = (data.get("condition") or ctx.get("condition") or "").strip()
    if not condition:
        return jsonify({"error": "No condition available"}), 400

    try:
        prompt = (
            "Return STRICT JSON with key 'drugs' as an array of strings (generic names only, lowercase).\n"
            f"Condition: {condition}\n"
            'Example: {"drugs":["amoxicillin","azithromycin"]}'
        )
        response = conversation_rag_chain.invoke({
            "chat_history": [],
            "input": prompt
        })
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw) or {}
        drugs = [*dict.fromkeys([*(parsed.get("drugs") or [])])]  # unique
    except Exception:
        drugs = []

    # Merge into session context
    session_context.setdefault(session_id, {})
    prev = session_context[session_id].get("drug_suggestions") or []
    merged = list(dict.fromkeys([*drugs, *prev]))[:15]
    session_context[session_id]["drug_suggestions"] = merged
    if not session_context[session_id].get("condition"):
        session_context[session_id]["condition"] = condition

    return jsonify({"session_id": session_id, "condition": condition, "drugs": merged}), 200

@app.route("/summarize-case", methods=["POST"])
def summarize_case():
    """
    Body: { session_id?, transcript? }
    Returns compact summary and updates stored context strictly.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or (session_context.get(session_id, {}) or {}).get("transcript") or "").strip()
    if not transcript:
        return jsonify({"error": "No transcript available"}), 400

    ctx = _extract_case_fields_strict(transcript, topn=10)
    # merge non-empty
    base = session_context.get(session_id, {})
    for k, v in ctx.items():
        if v not in (None, "", []):
            base[k] = v
    session_context[session_id] = base
    return jsonify({"session_id": session_id, **base}), 200

@app.route("/calculate-dosage-with-context", methods=["POST"])
def calculate_dosage_with_context():
    """
    Body: { session_id?, drug?, age?, weight?, condition?, transcript? }
    Auto-extracts context (strict) if missing and a transcript is provided.
    Auto-picks first suggested drug if drug is missing but suggestions exist.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip() or None

    # Ensure we have context (may extract from transcript)
    ctx = _ensure_context(session_id, transcript=transcript)

    merged = _merge_with_context(session_id, data)

    # If drug missing, try first suggestion
    if not merged.get("drug"):
        suggestions = ctx.get("drug_suggestions") or []
        if suggestions:
            merged["drug"] = suggestions[0]

    # Validate required fields now
    missing = [k for k in ("drug", "age", "weight", "condition") if merged.get(k) in (None, "")]
    if missing:
        return jsonify({
            "error": "Missing required fields after extraction",
            "missing": missing,
            "context": {
                "condition": ctx.get("condition"),
                "age_years": ctx.get("age_years"),
                "weight_kg": ctx.get("weight_kg"),
                "drug_suggestions": ctx.get("drug_suggestions"),
            }
        }), 400

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

        chat_sessions.setdefault(session_id, [])
        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage+Ctx] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": raw_answer})

        return jsonify({"dosage": dosage, "regimen": regimen, "notes": notes, "session_id": session_id}), 200

    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

@app.route("/calculate-dosage-stream-with-context", methods=["POST"])
def calculate_dosage_stream_with_context():
    """
    Streaming variant; same auto-extraction behavior.
    Body: { session_id?, drug?, age?, weight?, condition?, transcript? }
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip() or None

    ctx = _ensure_context(session_id, transcript=transcript)
    merged = _merge_with_context(session_id, data)

    if not merged.get("drug"):
        suggestions = ctx.get("drug_suggestions") or []
        if suggestions:
            merged["drug"] = suggestions[0]

    missing = [k for k in ("drug", "age", "weight", "condition") if merged.get(k) in (None, "")]
    if missing:
        return jsonify({
            "error": "Missing required fields after extraction",
            "missing": missing,
            "context": {
                "condition": ctx.get("condition"),
                "age_years": ctx.get("age_years"),
                "weight_kg": ctx.get("weight_kg"),
                "drug_suggestions": ctx.get("drug_suggestions"),
            }
        }), 400

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
# ========== END STRICT CONTEXT EXTRACTION ==========
OAI_BASE = "https://api.openai.com/v1"
COMMON_JSON_HEADERS = {
    "Authorization": f"Bearer {OPENAI_API_KEY}",
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
}

@app.get("/api/health")
def health():
    return {"ok": True}

@app.post("/api/rtc-transcribe-connect")
def rtc_transcribe_connect():
    """
    Browser sends an SDP offer (text).
    We:
      1) Create a Realtime Transcription Session -> ephemeral client_secret
      2) POST the browser SDP to OpenAI Realtime WebRTC endpoint with ?intent=transcription
         (Do NOT pass model here; model is defined by the session)
      3) Return the answer SDP (application/sdp) back to the browser **as raw bytes** (no decoding/strip)
    """
    offer_sdp = request.get_data()  # raw bytes; don't decode here
    if not offer_sdp:
        return Response(b"No SDP provided", status=400, mimetype="text/plain")

    # 1) Create ephemeral transcription session
    # NOTE: Do NOT force input_audio_format here; WebRTC uses RTP/Opus.
    session_payload = {
        "input_audio_transcription": {
            "model": "gpt-4o-transcribe"
        },
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500
        },
        "input_audio_noise_reduction": {"type": "near_field"}
    }

    try:
        sess = requests.post(
            f"{OAI_BASE}/realtime/transcription_sessions",
            headers=COMMON_JSON_HEADERS,
            data=json.dumps(session_payload),
            timeout=20
        )
    except Exception as e:
        log.exception("Failed to create transcription session")
        return Response(f"Session error: {e}".encode(), status=502, mimetype="text/plain")

    if not sess.ok:
        log.error("Session create failed (%s): %s", sess.status_code, sess.text)
        return Response(sess.content or b"Failed to create session",
                        status=sess.status_code,
                        mimetype="text/plain")

    client_secret = (sess.json().get("client_secret") or {}).get("value")
    if not client_secret:
        log.error("Missing client_secret in session response")
        return Response(b"Missing client_secret", status=502, mimetype="text/plain")

    # 2) Exchange SDP with Realtime endpoint using ephemeral secret
    sdp_headers = {
        "Authorization": f"Bearer {client_secret}",
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
        "Cache-Control": "no-cache",
    }
    upstream_url = f"{OAI_BASE}/realtime"
    params = {"intent": "transcription"}
    log.info("Posting SDP offer to %s with params=%s (offer %d bytes)",
             upstream_url, params, len(offer_sdp or b""))

    try:
        ans = requests.post(
            upstream_url,
            params=params,
            headers=sdp_headers,
            data=offer_sdp,   # send EXACT bytes we received
            timeout=30
        )
    except Exception as e:
        log.exception("SDP exchange error")
        return Response(f"SDP exchange error: {e}".encode(), status=502, mimetype="text/plain")

    if not ans.ok:
        log.error("SDP exchange failed (%s): %s", ans.status_code, ans.text)
        # surface upstream body (could be helpful error text)
        return Response(ans.content or b"SDP exchange failed",
                        status=ans.status_code,
                        mimetype=ans.headers.get("Content-Type", "text/plain"))

    # 3) Return the raw SDP answer bytes exactly as received (no text decode/strip)
    answer_bytes = ans.content or b""
    log.info("Upstream answered SDP (%d bytes)", len(answer_bytes))

    if not answer_bytes.startswith(b"v="):
        # Not an SDP body; return it verbatim for debugging
        preview = answer_bytes[:2000]
        log.error("Upstream returned non-SDP body (first bytes): %r", preview)
        return Response(answer_bytes, status=502, mimetype="text/plain")

    resp = Response(answer_bytes, status=200, mimetype="application/sdp")
    resp.headers["Content-Disposition"] = "inline; filename=answer.sdp"
    resp.headers["Cache-Control"] = "no-store"
    return resp
from datetime import timezone

@app.route("/specialty-template/generate", methods=["POST"])
def specialty_template_generate():
    """
    Body: { specialty: str, session_id?: str }
    Returns: { specialty, template }
    """
    data = request.get_json() or {}
    specialty = (data.get("specialty") or "").strip().lower()
    session_id = data.get("session_id", str(uuid4()))
    if not specialty:
        return jsonify({"error": "Missing specialty"}), 400

    prompt = _build_specialty_template_prompt(specialty)
    try:
        resp = conversation_rag_chain.invoke({"chat_history": [], "input": prompt})
        raw = (resp.get("answer") or "").strip()
        doc = _safe_json_dict(raw)
    except Exception as e:
        doc = None

    # fallback minimal template if model fails
    if not isinstance(doc, dict) or not doc.get("sections"):
        doc = {
            "specialty": specialty,
            "sections": [
                {"title":"Subjective","fields":["Chief complaint","Onset","Duration","Modifying factors","ROS"]},
                {"title":"Objective","fields":["Vitals","Exam key findings","Pertinent labs/imaging"]},
                {"title":"Assessment","fields":["Working diagnosis","Differential diagnoses"]},
                {"title":"Plan","fields":["Investigations","Medications","Non-pharmacologic","Follow-up"]},
            ],
            "follow_up_questions":[
                "What is the primary symptom and duration?",
                "Any red flags (fever, syncope, bleeding, weight loss)?"
            ],
            "style":{"tone":"concise, clinical","bullets":True,"icd_cpt_suggestions":True}
        }

    return jsonify({"session_id": session_id, "specialty": specialty, "template": doc}), 200


@app.route("/specialty-template/activate", methods=["POST"])
def specialty_template_activate():
    """
    Body: { session_id: str, specialty: str, template: {...} }
    Stores the active template for the session.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id")
    specialty = (data.get("specialty") or "").strip().lower()
    template = data.get("template")
    if not (session_id and specialty and isinstance(template, dict)):
        return jsonify({"error": "Missing session_id/specialty/template"}), 400

    ACTIVE_TEMPLATES[session_id] = {
        "specialty": specialty,
        "template": template,
        "activated_at": datetime.now(timezone.utc).isoformat()
    }
    return jsonify({"ok": True, "active": ACTIVE_TEMPLATES[session_id]}), 200


@app.route("/specialty-template/deactivate", methods=["POST"])
def specialty_template_deactivate():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400
    ACTIVE_TEMPLATES.pop(session_id, None)
    return jsonify({"ok": True}), 200


@app.route("/specialty-template/active", methods=["GET"])
def specialty_template_active():
    session_id = request.args.get("session_id", "")
    active = ACTIVE_TEMPLATES.get(session_id)
    return jsonify({"exists": bool(active), "active": active}), 200
@app.route("/stream-with-template", methods=["POST"])
def stream_with_template():
    """
    Body: { message: str, session_id?: str }
    If a specialty template is active, prepend strict instructions so the AI:
      - uses the template sections order,
      - fills available items,
      - asks 1–2 follow-up questions from template.follow_up_questions based on missing fields,
      - stays concise & clinical.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    user_input = (data.get("message") or "").strip()
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    active = ACTIVE_TEMPLATES.get(session_id)
    if not active:
        # fallback to normal behavior if nothing is active
        # (no changes to your original /stream UX)
        def passthrough():
            answer = ""
            try:
                for chunk in conversation_rag_chain.stream(
                    {"chat_history": chat_sessions.get(session_id, []), "input": user_input}
                ):
                    token = chunk.get("answer", "")
                    answer += token
                    yield token
            except Exception as e:
                yield f"\n[Vector error: {str(e)}]"
            chat_sessions.setdefault(session_id, [])
            chat_sessions[session_id].append({"role": "user", "content": user_input})
            chat_sessions[session_id].append({"role": "assistant", "content": answer})
        return Response(stream_with_context(passthrough()), content_type="text/plain")

    template = active["template"]
    template_json = json.dumps(template, ensure_ascii=False)

    instruction = (
        "ADAPTIVE SPECIALTY TEMPLATE MODE (STRICT):\n"
        "- Use the following JSON template (sections order, field names) to structure the note.\n"
        "- Fill what is known; list **Missing** fields clearly and ask at most TWO targeted follow-ups from 'follow_up_questions'.\n"
        "- Tone: concise, clinical; prefer bullets.\n"
        "- If coding is appropriate, suggest ICD/CPT hints at the end.\n"
        f"TEMPLATE_JSON:\n{template_json}\n\n"
        f"USER_MESSAGE:\n{user_input}\n"
    )

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    def generate():
        answer = ""
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": instruction}
            ):
                token = chunk.get("answer", "")
                answer += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        chat_sessions[session_id].append({"role": "user", "content": f"[TemplateMode] {user_input}"})
        chat_sessions[session_id].append({"role": "assistant", "content": answer})

    return Response(stream_with_context(generate()), content_type="text/plain")

# --- ADD to app.py ---


# app.py (only the endpoint shown here)

@app.post("/analyze-form-case-stream")
def analyze_form_case_stream():
    """
    Body: { session_id: str, specialty: str, form: dict }  # preferred
    Legacy accepted: { session_id: str, specialty: str, answers: dict }
    Returns: text/plain (stream)
    Behavior: Builds a plain clinical prompt from 'form' and streams analysis.
    """
    data = request.get_json() or {}
    session_id = str(data.get("session_id") or "")
    specialty = str(data.get("specialty") or "").strip()

    # accept either modern 'form' or legacy 'answers'
    form = data.get("form") or data.get("answers") or {}

    if not specialty:
        return jsonify({"error": "specialty is required"}), 400

    # Turn form dict into readable bullet list (ignore empties)
    lines = []
    for k, v in form.items():
        if v is None or v == "" or v == []:
            continue
        key = str(k).replace("_", " ").title()
        if isinstance(v, list):
            val = ", ".join(map(str, v))
        else:
            val = str(v)
        lines.append(f"- {key}: {val}")

    form_text = "\n".join(lines) if lines else "(No details provided)"

    sys_rules = (
        "You are a clinical assistant. Respond in plain English text.\n"
        "Never output JSON or code blocks. Ask at most one follow-up question at a time.\n"
        "If sufficient information exists, provide a concise assessment and plan."
    )

    user_prompt = (
        f"[Specialty: {specialty}]\n"
        f"{sys_rules}\n\n"
        f"Case details:\n{form_text}\n\n"
        "Please provide:\n"
        "1) A concise assessment/differential.\n"
        "2) Key next steps (tests, meds, safety-net advice).\n"
        "3) If needed, ask exactly one follow-up question."
    )

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    def generate():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": user_prompt}
            ):
                token = chunk.get("answer", "")
                acc += token
                yield token
        except Exception as e:
            yield f"\n[Error: {str(e)}]"

        # persist
        chat_sessions[session_id].append({"role": "user", "content": f"[Form:{specialty}] {form_text}"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(generate()), content_type="text/plain")

# --- NEW: Prompt Formatter endpoint (GPT-4o) ---
@app.post("/prompt-formatter")
def prompt_formatter():
    """
    Body (either form-based or raw):
      {
        "session_id": "optional",
        "specialty": "urology" | "cardiology" | ... (optional but helpful),
        "form": { ... }                  # preferred: the structured form object
        "raw": "string of messy text"    # alternative input
      }

    Returns:
      { "session_id": "...", "formatted_prompt": "Markdown string" }

    Behavior:
    - Uses GPT-4o (your existing RAG chain) to produce a clean, concise Markdown
      case summary with fixed headings.
    - Prepends strict downstream instructions so the *next* /stream call returns
      a well-structured clinical answer inside the chat bubble.
    """
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    specialty = (data.get("specialty") or "").strip()
    raw_text = (data.get("raw") or "").strip()
    form = data.get("form") or data.get("answers") or {}

    # Turn form into readable bullets when raw_text is not provided
    def dict_to_bullets(d: dict) -> str:
        lines = []
        for k, v in (d or {}).items():
            if v in (None, "", []):
                continue
            key = str(k).replace("_", " ").title()
            if isinstance(v, list):
                val = ", ".join(map(str, v))
            else:
                val = str(v)
            lines.append(f"- **{key}:** {val}")
        return "\n".join(lines) if lines else "_No details provided_"

    form_md = raw_text or dict_to_bullets(form)

    # 1) Ask GPT-4o to produce a CLEAN, DEDUPED case prompt (no recommendations)
    formatter_instruction = (
        "You are PromptFormatter. Convert the following clinical case details into clean, concise **Markdown** with"
        " EXACTLY these headings once each and nothing else:\n"
        "## Patient Summary\n"
        "## Key Findings\n"
        "## Risks/Red Flags\n"
        "## Questions to Clarify (max 3)\n"
        "Rules:\n"
        "- English only. No treatment advice. No duplication. No filler.\n"
        "- Short bullet points. Keep it clinically neutral.\n"
    )

    user_payload = (
        f"{formatter_instruction}\n\n"
        f"**Specialty:** {specialty or 'general'}\n\n"
        f"**Raw Case Details:**\n{form_md}\n\n"
        "Return only the four sections in Markdown."
    )

    try:
        resp = conversation_rag_chain.invoke({
            "chat_history": [],  # formatter is stateless
            "input": user_payload
        })
        formatted_case_md = (resp.get("answer") or "").strip()
    except Exception as e:
        # Fallback: at least give something usable
        formatted_case_md = f"## Patient Summary\n- Specialty: {specialty or 'general'}\n\n## Key Findings\n{form_md}\n\n## Risks/Red Flags\n_None_\n\n## Questions to Clarify (max 3)\n- _None_"

    # 2) Downstream strict instructions for /stream response structure
    downstream_instructions = (
        "You are a clinical assistant. **Output strictly in Markdown** with these EXACT headings, once each:\n"
        "## Assessment\n"
        "## Differential Diagnoses\n"
        "## Red Flags\n"
        "## Recommended Tests\n"
        "## Initial Management\n"
        "## Patient Advice & Safety-Net\n"
        "## Follow-up Question (one line)\n"
        "Rules:\n"
        "- Concise bullet points. English only. No repetition across sections.\n"
        "- No code, no JSON. If a section is not applicable, write _None_.\n"
        "- Base your answer only on the Case Summary below (and retrieved knowledge if available).\n"
    )

    # 3) Final prompt to send to /stream
    formatted_prompt = (
        f"{downstream_instructions}\n"
        f"---\n"
        f"### Case Summary\n{formatted_case_md}\n"
    )

    return jsonify({
        "session_id": session_id,
        "formatted_prompt": formatted_prompt
    }), 200
# --- NEW: Form Report Stream endpoint (GPT-4o + anti-duplication) ---

@app.post("/form-report-stream")
def form_report_stream():
    """
    Body: {
      "session_id": "optional",
      "specialty": "cardiology" | "...",
      "form": { ... }       # structured form object (preferred)
    }

    Streams a *structured* clinical note in Markdown with strong anti-duplication
    filtering applied server-side (token & line level).
    """
    data = request.get_json() or {}
    session_id  = data.get("session_id", str(uuid4()))
    specialty   = (data.get("specialty") or "").strip() or "general"
    form        = data.get("form") or data.get("answers") or {}

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    # ---- 1) Case details (Markdown bullets) ----
    def dict_to_md(d: dict) -> str:
        lines = []
        for k, v in (d or {}).items():
            if v in (None, "", []): 
                continue
            label = str(k).replace("_", " ").title()
            if isinstance(v, list):
                val = ", ".join(map(str, v))
            else:
                val = str(v)
            lines.append(f"- **{label}:** {val}")
        return "\n".join(lines) if lines else "_No details provided_"

    case_md = dict_to_md(form)

    # ---- 2) Strict downstream instruction (no repetition, Markdown-only) ----
    instruction = (
        "You are a clinical assistant. Output strictly in **Markdown** using these EXACT headings once each:\n"
        "## Assessment\n"
        "## Differential Diagnoses\n"
        "## Recommended Tests\n"
        "## Initial Management\n"
        "## Patient Advice & Safety-Net\n"
        "## Follow-up Question (one line)\n"
        "Rules:\n"
        "- English only"
        "- Do **not** echo the input. Do **not** repeat words or lines.\n"
        "- If information is missing, write _Unknown_ (do not invent).\n"
        "- No JSON. No code blocks other than Markdown lists.\n"
        "- Base your answer only on the case details and any retrieved knowledge.\n"
        f"\n### Specialty\n- {specialty}\n"
        f"\n### Case Details\n{case_md}\n"
    )

    # ---- 3) Streaming sanitizer to kill token/line repetition ----
    import re
    acc = []          # chunks we’ve emitted (as list for efficiency)
    buf = ""          # working buffer for cleaning

    # collapse repeated words: "pain pain pain" -> "pain"
    RE_WORD_REPEAT = re.compile(r"\b(\w+)(\s+\1){1,}\b", flags=re.IGNORECASE)
    # later we also de-dupe identical consecutive lines case-insensitive

    def sanitize_and_diff(new_text: str, old_clean: str) -> str:
        """
        1) collapse repeated words (any 2+ in a row)
        2) collapse multiple spaces
        3) collapse identical consecutive lines
        return ONLY the incremental part relative to old_clean
        """
        cleaned = RE_WORD_REPEAT.sub(r"\1", new_text)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)

        # line-level de-dupe (consecutive equals, case/space-insensitive)
        lines = cleaned.splitlines()
        out_lines = []
        prev_norm = None
        for ln in lines:
            norm = re.sub(r"\s+", " ", ln.strip().lower())
            if norm == prev_norm:
                continue
            out_lines.append(ln)
            prev_norm = norm
        cleaned = "\n".join(out_lines)

        # diff vs already-sent content
        if cleaned.startswith(old_clean):
            return cleaned[len(old_clean):]
        # if not aligned (rare), send only the new tail to avoid re-sends
        return cleaned[-max(0, len(cleaned) - len(old_clean)):]

    def generate():
        nonlocal buf
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": instruction}
            ):
                token = chunk.get("answer", "")
                if not token:
                    continue
                buf += token
                already = "".join(acc)
                emit = sanitize_and_diff(buf, already)
                if emit:
                    acc.append(emit)
                    yield emit
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        # persist
        chat_sessions[session_id].append({"role": "user", "content": f"[Form:{specialty}] (structured submission)"})
        chat_sessions[session_id].append({"role": "assistant", "content": "".join(acc)})

    return Response(stream_with_context(generate()), content_type="text/plain")



# ---------- OpenAI Chat Completions streaming helper ----------
# You can tweak these without changing the flow
STRUCTURE_MODEL = os.environ.get("STRUCTURE_MODEL", "gpt-4o-mini")
SECOND_OPINION_MODEL = os.environ.get("SECOND_OPINION_MODEL", "gpt-4o-mini")

def _openai_chat_stream(messages, model=STRUCTURE_MODEL, temperature=0.2, timeout=180):
    """Stream text chunks from Chat Completions."""
    url = f"{OAI_BASE}/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "temperature": temperature,
        "stream": True,
        "messages": messages,
    }
    with requests.post(url, headers=headers, data=json.dumps(payload), stream=True, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line.startswith("data: "):
                data = line[len("data: "):]
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)
                    chunk = delta.get("choices", [{}])[0].get("delta", {}).get("content")
                    if chunk:
                        yield chunk
                except Exception:
                    continue



# ---------- WebRTC: transcription intent (renamed endpoint) ----------
@app.post("/api/rtc-transcribe-nodes-connect")
def rtc_transcribe_nodes_connect():
    """
    Browser sends an SDP offer (bytes).
      1) Create a Realtime Transcription Session -> ephemeral client_secret
      2) POST the browser SDP to Realtime WebRTC endpoint with ?intent=transcription
         (Do NOT pass model here; model is defined by the session)
      3) Return the answer SDP (application/sdp) back to the browser as raw bytes
    """
    offer_sdp = request.get_data()  # raw bytes
    if not offer_sdp:
        return Response(b"No SDP provided", status=400, mimetype="text/plain")

    # 1) Create ephemeral transcription session
    # NOTE: Do NOT force input_audio_format; WebRTC uses RTP/Opus.
    session_payload = {
        "input_audio_transcription": { "model": "gpt-4o-transcribe" },
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500
        },
        "input_audio_noise_reduction": { "type": "near_field" }
    }

    try:
        sess = requests.post(
            f"{OAI_BASE}/realtime/transcription_sessions",
            headers=COMMON_JSON_HEADERS,
            data=json.dumps(session_payload),
            timeout=20
        )
    except Exception as e:
        log.exception("Failed to create transcription session")
        return Response(f"Session error: {e}".encode(), status=502, mimetype="text/plain")

    if not sess.ok:
        log.error("Session create failed (%s): %s", sess.status_code, sess.text)
        return Response(sess.content or b"Failed to create session",
                        status=sess.status_code,
                        mimetype="text/plain")

    client_secret = (sess.json().get("client_secret") or {}).get("value")
    if not client_secret:
        log.error("Missing client_secret in session response")
        return Response(b"Missing client_secret", status=502, mimetype="text/plain")

    # 2) Exchange SDP with Realtime endpoint using ephemeral secret
    sdp_headers = {
        "Authorization": f"Bearer {client_secret}",
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
        "Cache-Control": "no-cache",
    }
    upstream_url = f"{OAI_BASE}/realtime"
    params = {"intent": "transcription"}
    log.info("Posting SDP offer to %s with params=%s (offer %d bytes)",
             upstream_url, params, len(offer_sdp or b""))

    try:
        ans = requests.post(
            upstream_url,
            params=params,
            headers=sdp_headers,
            data=offer_sdp,   # exact bytes
            timeout=30
        )
    except Exception as e:
        log.exception("SDP exchange error")
        return Response(f"SDP exchange error: {e}".encode(), status=502, mimetype="text/plain")

    if not ans.ok:
        log.error("SDP exchange failed (%s): %s", ans.status_code, ans.text)
        return Response(ans.content or b"SDP exchange failed",
                        status=ans.status_code,
                        mimetype=ans.headers.get("Content-Type", "text/plain"))

    answer_bytes = ans.content or b""
    log.info("Upstream answered SDP (%d bytes)", len(answer_bytes))

    if not answer_bytes.startswith(b"v="):
        preview = answer_bytes[:2000]
        log.error("Upstream returned non-SDP body (first bytes): %r", preview)
        return Response(answer_bytes, status=502, mimetype="text/plain")

    resp = Response(answer_bytes, status=200, mimetype="application/sdp")
    resp.headers["Content-Disposition"] = "inline; filename=answer.sdp"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- Streaming: structure notes from transcript ----------
@app.post("/api/notes-structure-stream")
def notes_structure_stream():
    """
    Body: { transcript: "full or partial transcript text" }
    Returns: text/plain streamed markdown for clinical notes sections.
    """
    data = request.get_json() or {}
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return Response("No transcript provided", status=400, mimetype="text/plain")

    system = (
        "You are a clinical scribe. Convert dialogue into clean, succinct "
        "clinical notes in Markdown with THESE headings only:\n"
        "## Reason for Visit\n"
        "## History of Present Illness\n"
        "## Past Medical History\n"
        "## Medications\n"
        "## Allergies\n"
        "## Physical Examination\n"
        "## Labs & Imaging (available)\n"
        "## Recommended Tests & Investigations\n"
        "## Assessment & Plan\n\n"
        "- Use short, factual bullet points.\n"
        "- Infer missing fields only if strongly implied; otherwise write '—'.\n"
        "- Keep PHI generic.\n"
    )
    user = f"Dialogue transcript (may be partial):\n\n{transcript}"

    def generate():
        yield ""
        for chunk in _openai_chat_stream(
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            model=STRUCTURE_MODEL,
            temperature=0.1
        ):
            yield chunk

    return Response(generate(), mimetype="text/plain")

# ---------- Streaming: second opinion from structured note ----------
@app.post("/api/notes-second-opinion-stream")
def notes_second_opinion_stream():
    """
    Body: { note_markdown: "structured note in Markdown" }
    Returns: text/plain streamed expert second opinion.
    """
    data = request.get_json() or {}
    note_md = (data.get("note_markdown") or "").strip()
    if not note_md:
        return Response("No note provided", status=400, mimetype="text/plain")

    system = (
        "You are a senior clinician generating a concise second opinion. "
        "Analyze the provided clinical note and provide:\n"
        "### Differential Diagnoses (ranked)\n"
        "### Red Flags\n"
        "### Recommended Next Steps\n"
        "### Patient-Friendly Summary\n"
        "Be specific but brief. Bullet points only."
    )

    def generate():
        yield ""
        for chunk in _openai_chat_stream(
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": f"Clinical note:\n\n{note_md}"}],
            model=SECOND_OPINION_MODEL,
            temperature=0.2
        ):
            yield chunk

    return Response(generate(), mimetype="text/plain")
# ---------- JSON-only error handlers ----------
@app.errorhandler(RequestEntityTooLarge)
def handle_413(e):
    return jsonify({
        "error": "File too large",
        "limit_mb": app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
    }), 413


@app.errorhandler(HTTPException)
def handle_http_exception(e: HTTPException):
    return jsonify({
        "error": e.name,
        "code": e.code,
        "description": e.description
    }), e.code


@app.errorhandler(Exception)
def handle_uncaught(e: Exception):
    # Avoid leaking internals; return a generic JSON error.
    return jsonify({"error": "Internal server error"}), 500
# ----------------------------------------------



def _json_error(message, status=400, **extra):
    payload = {"error": message}
    if extra:
        payload.update(extra)
    return jsonify(payload), status


def _post_ocr_space(file_storage, filename, ext, language, overlay, engine,
                    is_table=None, scale=None, detect_orientation=None):
    """
    Sends the uploaded file stream to OCR.Space and returns the parsed JSON or raises.
    """
    forced_name = f"upload.{ext}"
    forced_mime = file_storage.mimetype or ("application/pdf" if ext == "pdf" else "image/png")

    data = {
        "apikey": OCR_SPACE_API_KEY,
        "language": language,
        "isOverlayRequired": overlay,
        "OCREngine": engine,   # "1" or "2" per OCR.Space
    }
    if is_table is not None:
        data["isTable"] = is_table
    if scale is not None:
        data["scale"] = scale
    if detect_orientation is not None:
        data["detectOrientation"] = detect_orientation

    resp = requests.post(
        "https://api.ocr.space/parse/image",
        files={"file": (forced_name, file_storage.stream, forced_mime)},
        data=data,
        timeout=180,
        headers={"Accept": "application/json"},
    )
    content_type = resp.headers.get("Content-Type", "")
    # Try to parse JSON regardless of status code
    try:
        result = resp.json()
    except ValueError:
        snippet = (resp.text or "").strip()[:300]
        raise RuntimeError(
            f"OCR provider returned non-JSON response (status {resp.status_code}, ct {content_type}). "
            f"Snippet: {snippet}"
        )
    return result, forced_mime


def _aggregate_parsed_text(result_json):
    """
    Combines text across OCR.Space ParsedResults pages.
    """
    if result_json.get("IsErroredOnProcessing") or "ParsedResults" not in result_json:
        return None, 0
    pages = result_json.get("ParsedResults") or []
    texts = []
    for p in pages:
        t = (p or {}).get("ParsedText", "")
        if t:
            texts.append(t)
    return ("\n\n".join(texts).strip(), len(pages))


# Expose BOTH paths to avoid “Cannot POST /ocr” mismatches:
@app.route("/ocr", methods=["POST"])
@app.route("/api/ocr", methods=["POST"])
def ocr_from_image():
    # Basic config sanity
    if not OCR_SPACE_API_KEY:
        return _json_error("OCR_SPACE_API_KEY is not configured", 500)

    # Accept 'image' (preferred) or 'file'
    f = request.files.get("image") or request.files.get("file")
    if not f:
        return _json_error("No image file uploaded. Use form field 'image'", 400)

    filename = secure_filename(f.filename or "upload")
    ext = (osp.splitext(filename)[1].lstrip(".") or "png").lower()

    # Extension guard
    if ext not in ALLOWED_EXTS:
        return _json_error(
            "Unsupported file type. Only PDF or images are supported.",
            400,
            allowed=sorted(ALLOWED_EXTS)
        )

    # Block video/audio upfront (OCR.Space does not support them)
    if f.mimetype and (f.mimetype.startswith("video/") or f.mimetype.startswith("audio/")):
        return _json_error("Video/audio files are not supported by OCR.Space.", 400)

    # Server-side request size guard (proxy may still need config)
    if request.content_length and request.content_length > MAX_BYTES:
        return _json_error(
            f"File too large for server cap (> {MAX_BYTES // (1024 * 1024)}MB).",
            413, limit_mb=MAX_BYTES // (1024 * 1024)
        )

    # Provider plan guard (best-effort; provider still enforces its own limit)
    provider_limit = PROVIDER_LIMIT_MB * 1024 * 1024
    if request.content_length and request.content_length > provider_limit:
        return _json_error(
            f"File exceeds your OCR plan limit ({PROVIDER_LIMIT_MB}MB). "
            f"Please compress the file or upgrade your OCR.Space plan.",
            413, provider_limit_mb=PROVIDER_LIMIT_MB
        )

    # Tunables
    language = request.form.get("language", "eng")   # e.g., "eng", "ara"
    overlay = request.form.get("overlay", "false")   # "true"/"false"
    engine = request.form.get("engine", "2")         # "1"|"2" (per OCR.Space docs)
    is_table = request.form.get("isTable")           # optional
    scale = request.form.get("scale")                # optional
    detect_orientation = request.form.get("detectOrientation")  # optional

    # Call provider
    try:
        result, forced_mime = _post_ocr_space(
            f, filename, ext, language, overlay, engine,
            is_table=is_table, scale=scale, detect_orientation=detect_orientation
        )
    except requests.exceptions.RequestException as e:
        return _json_error("OCR request failed", 502, detail=str(e))
    except RuntimeError as e:
        # Non-JSON or upstream HTML page, etc.
        return _json_error(str(e), 502)

    # Aggregate text
    text, pages = _aggregate_parsed_text(result)
    if text is None:
        # Provider signaled error
        return _json_error(
            "OCR failed",
            400,
            message=result.get("ErrorMessage", "No detailed message"),
            details=result
        )

    if not text:
        return _json_error("OCR succeeded but returned no text", 502, provider=result)

    # Success response (what your frontend expects)
    return jsonify({
        "text": text,
        "meta": {
            "filename": filename,
            "mimetype": forced_mime,
            "pages": pages,
            "language": language,
            "engine": engine,
        }
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
