import os
import tempfile
import ast
from uuid import uuid4
import base64, uuid, json
from datetime import datetime
import json
import logging
import requests
import re
import base64
import hashlib
import unicodedata
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.utils import secure_filename
from typing import List, Dict, Any
import os.path as osp
import random
from dotenv import load_dotenv
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import qdrant_client
from openai import OpenAI
from prompts.prompt import engineeredprompt
from prompts.drug_system_prompt import DRUG_SYSTEM_PROMPT
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
from flask_cors import CORS

CORS(
    app,
    resources={
        # Default policy (applies to everything unless a more specific rule below overrides it)
        r"/*": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/api/rtc-transcribe-connect": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/transcribe": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/case-second-opinion-stream": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },

        r"/analyze-form-case-stream": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },

        r"/transcribe_widget": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/ocr": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },

        r"/api/ocr": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },

        # --- NEW: Medication checker endpoints (cover all /meds/* routes) ---

        r"/meds/parse": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],  "methods": ["POST", "OPTIONS"],       "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/meds/map": {
            "origins": ["https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization", "Accept"],
            "supports_credentials": True,
        },
        r"/vision/analyze": {
        "origins": [
            "https://ai-doctor-assistant-app-dev.onrender.com",
            "http://localhost:3000",
        ],
        "methods": ["POST"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True,
    },
    }
)

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


# ====== NEW: /case-second-opinion-stream (UPDATED) ======
@app.route("/case-second_opinion_stream", methods=["POST"])
def case_second_opinion_stream():
    """
    Streams a SECOND OPINION analysis with a strict JSON header so the front-end
    can render charts, ICD-10 table, and sections reliably.

    Output contract (MUST start with a fenced JSON block):
    ```json
    {
      "primary_diagnosis": {"name": "...", "icd10": "..."},                # required
      "differential_diagnosis": [                                          # required
        {"name": "...", "probability_percent": 42, "icd10": "..."},        # 0–100, sum ~100
        ...
      ],
      "recommended_labs": ["...","..."],                                   # optional
      "imaging": ["...","..."],                                            # optional (radiology/investigations)
      "prescriptions": ["...","..."],                                      # optional (drugs/doses)
      "recommendations": ["...","..."],                                    # optional (to the doctor)
      "treatment_plan": ["...","..."],                                     # optional
      "services": ["...","..."]                                            # optional (referrals/clinic services)
    }
    ```
    After that JSON, the model may continue with a human-readable narrative
    (The diagnosis:, The differential diagnosis:, etc.) as before.
    """
    data = request.get_json() or {}
    context = (data.get("context") or "").strip()
    session_id = data.get("session_id", str(uuid4()))

    if not context:
        return jsonify({"error": "No context provided"}), 400

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    structured_instruction = (
        "SECOND OPINION CASE ANALYSIS.\n"
        "You MUST begin your response with a single fenced JSON block exactly as specified below. "
        "Use ENGLISH. Use ICD-10-CM codes when applicable. Probabilities must be integers 0–100 that sum ~100.\n\n"
        "Start your output with ONLY this JSON (no text before it):\n"
        "```json\n"
        "{\n"
        '  "primary_diagnosis": {"name": "STRING", "icd10": "STRING or null"},\n'
        '  "differential_diagnosis": [\n'
        '    {"name": "STRING", "probability_percent": 35, "icd10": "STRING or null"}\n'
        "  ],\n"
        '  "recommended_labs": ["ARRAY OF STRINGS"],\n'
        '  "imaging": ["ARRAY OF STRINGS"],\n'
        '  "prescriptions": ["ARRAY OF STRINGS"],\n'
        '  "recommendations": ["ARRAY OF STRINGS"],\n'
        '  "treatment_plan": ["ARRAY OF STRINGS"],\n'
        '  "services": ["ARRAY OF STRINGS"]\n'
        "}\n"
        "```\n\n"
        "After that JSON block, continue with the human-readable sections in this exact order:\n"
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
                # Stream raw tokens to the client as before
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


# ===== OCR: helpers (replace your current _post_ocr_space / _aggregate_parsed_text) =====
import mimetypes

# Expand mimetypes so we don't default to image/png for everything
mimetypes.add_type("application/pdf", ".pdf")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/jpeg", ".jpeg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/tiff", ".tif")
mimetypes.add_type("image/tiff", ".tiff")
mimetypes.add_type("image/bmp", ".bmp")
mimetypes.add_type("image/gif", ".gif")
mimetypes.add_type("image/heic", ".heic")
mimetypes.add_type("image/heif", ".heif")

# Accept **all common images + PDF** (no “png-only” behavior)
ALLOWED_EXTS = {
    "pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif", "heic", "heif"
}
REJECTED_PREFIXES = ("video/", "audio/")

def _guess_mimetype(filename: str, fallback: str = None) -> str:
    ext = (osp.splitext(filename)[1] or "").lower()
    if not ext:
        return fallback or "application/octet-stream"
    mime, _ = mimetypes.guess_type(filename)
    return mime or fallback or "application/octet-stream"

def _post_ocr_space(file_storage, filename, ext, language, overlay, engine,
                    is_table=None, scale=None, detect_orientation=None):
    """
    Sends the uploaded file stream to OCR.Space and returns parsed JSON.
    Works for PDF and common image types. No PNG forcing anymore.
    """
    # Keep the original extension for the upstream provider
    forced_name = secure_filename(filename or f"upload.{ext or 'bin'}")
    # Prefer the browser/werkzeug-detected mimetype; otherwise guess by extension
    forced_mime = file_storage.mimetype or _guess_mimetype(forced_name, "application/octet-stream")

    data = {
        "apikey": OCR_SPACE_API_KEY,
        "language": language,
        "isOverlayRequired": overlay,
        "OCREngine": engine,  # "1" or "2"
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
    """Combine text across OCR.Space pages; return (text, page_count)."""
    if result_json.get("IsErroredOnProcessing") or "ParsedResults" not in result_json:
        return None, 0
    pages = result_json.get("ParsedResults") or []
    texts = []
    for p in pages:
        t = (p or {}).get("ParsedText", "")
        if t:
            texts.append(t)
    return ("\n\n".join(texts).strip(), len(pages))

# ===== OCR: session-aware endpoints (replace your current /ocr + /api/ocr routes) =====
@app.route("/ocr", methods=["POST"])
@app.route("/api/ocr", methods=["POST"])
def ocr_from_image():
    """
    Multipart form (all optional except 'image'|'file'):
      - image | file        : PDF or image to OCR
      - language            : default 'eng'
      - overlay             : 'true' | 'false' (default 'false')
      - engine              : '1' | '2' (default '2')
      - session_id          : chat session id (fallbacks to X-Session-Id or auto-generates)
      - attach              : 'true' | 'false' (default 'true') -> push OCR text into chat_sessions[session_id]
      - role                : 'user' | 'assistant' (default 'user') for attached message
      - label               : short label prefix (default 'OCR Document')
      - max_chars           : int cap stored in history (default env OCR_HISTORY_MAX_CHARS or 8000)

    Response:
      { text, meta, session_id, attached, chars_saved, truncated }
    """
    try:
        if not OCR_SPACE_API_KEY:
            app.logger.error("OCR_SPACE_API_KEY is not set")
            return _json_error("OCR_SPACE_API_KEY is not configured", 500)

        # ---- session awareness ----
        session_id = (
            (request.form.get("session_id") or "").strip()
            or (request.headers.get("X-Session-Id") or "").strip()
            or str(uuid4())
        )
        attach_flag = (request.form.get("attach", "true").strip().lower() != "false")
        attach_role = (request.form.get("role") or "user").strip().lower()
        if attach_role not in ("user", "assistant"):
            attach_role = "user"
        label = (request.form.get("label") or "OCR Document").strip()[:48]

        try:
            max_chars_env = int(os.environ.get("OCR_HISTORY_MAX_CHARS", "8000"))
        except Exception:
            max_chars_env = 8000
        try:
            max_chars_req = int(request.form.get("max_chars", "") or max_chars_env)
        except Exception:
            max_chars_req = max_chars_env
        max_chars_req = max(1000, min(200_000, max_chars_req))

        # ---- input file (PDF or any image/*) ----
        f = request.files.get("image") or request.files.get("file")
        if not f:
            return _json_error("No file uploaded. Use form field 'image' or 'file'.", 400)

        filename = secure_filename(f.filename or "upload")
        ext = (osp.splitext(filename)[1].lstrip(".") or "").lower()

        app.logger.info(
            "OCR request: path=%s session_id=%s filename=%s mimetype=%s content_length=%s",
            request.path, session_id, filename, getattr(f, "mimetype", None), request.content_length
        )

        # ---- guards: allow PDF and images; reject audio/video; soft-check extension ----
        if f.mimetype and f.mimetype.startswith(REJECTED_PREFIXES):
            return _json_error("Video/audio files are not supported by OCR.", 400)

        if ext and ext not in ALLOWED_EXTS:
            # If extension is unknown but mimetype looks like image/pdf, allow it
            looks_image_or_pdf = (
                (f.mimetype or "").startswith("image/") or (f.mimetype == "application/pdf")
            )
            if not looks_image_or_pdf:
                return _json_error(
                    "Unsupported file type. Only PDF or images are supported.",
                    400, allowed=sorted(ALLOWED_EXTS)
                )

        # ---- size caps (server + provider plan) ----
        if request.content_length and request.content_length > MAX_BYTES:
            return _json_error(
                f"File too large for server cap (> {MAX_BYTES // (1024 * 1024)}MB).",
                413, limit_mb=MAX_BYTES // (1024 * 1024)
            )

        provider_limit = PROVIDER_LIMIT_MB * 1024 * 1024
        if request.content_length and request.content_length > provider_limit:
            # Provider free plans are small; let clients see a helpful message
            return _json_error(
                f"File exceeds your OCR plan limit ({PROVIDER_LIMIT_MB}MB). "
                f"Please compress the file or upgrade your OCR plan.",
                413, provider_limit_mb=PROVIDER_LIMIT_MB
            )

        # ---- tunables ----
        language = request.form.get("language", "eng")
        overlay = request.form.get("overlay", "false")
        engine = request.form.get("engine", "2")
        is_table = request.form.get("isTable")
        scale = request.form.get("scale")
        detect_orientation = request.form.get("detectOrientation")

        # ---- provider call (works for PDF + image types) ----
        try:
            result, forced_mime = _post_ocr_space(
                f, filename, ext, language, overlay, engine,
                is_table=is_table, scale=scale, detect_orientation=detect_orientation
            )
        except requests.exceptions.RequestException as e:
            app.logger.exception("OCR provider network error")
            return _json_error("OCR request failed", 502, detail=str(e))
        except RuntimeError as e:
            app.logger.error("OCR provider returned non-JSON/HTML error: %s", e)
            return _json_error(str(e), 502)

        # ---- parse / validate provider response ----
        text, pages = _aggregate_parsed_text(result)
        if text is None:
            app.logger.error("OCR provider error payload: %s", result)
            return _json_error(
                "OCR failed",
                400,
                message=result.get("ErrorMessage", "No detailed message"),
                details=result
            )
        if not text:
            app.logger.warning("OCR succeeded but empty text")
            return _json_error("OCR succeeded but returned no text", 502, provider=result)

        # ---- optionally attach OCR text into chat history for context ----
        attached = False
        chars_saved = 0
        truncated = False

        if attach_flag:
            chat_sessions.setdefault(session_id, [])
            header = (
                f"[{label} Uploaded]\n"
                f"- File: {filename}\n"
                f"- Pages: {pages}\n"
                f"- Language: {language}\n"
                f"- Engine: {engine}\n"
                f"- Mimetype: {forced_mime}\n"
                f"---\n"
            )
            content = text
            if len(content) > max_chars_req:
                content = content[:max_chars_req]
                truncated = True

            message_text = header + content + ("\n[...truncated...]" if truncated else "")
            chat_sessions[session_id].append({"role": attach_role, "content": message_text})
            attached = True
            chars_saved = len(content)

        # ---- success ----
        return jsonify({
            "text": text,
            "meta": {
                "filename": filename,
                "mimetype": forced_mime,
                "pages": pages,
                "language": language,
                "engine": engine,
            },
            "session_id": session_id,
            "attached": attached,
            "chars_saved": chars_saved,
            "truncated": truncated
        })

    except Exception:
        app.logger.exception("Unhandled error in /api/ocr")
        return jsonify({"error": "Internal server error"}), 500
# ---------- Labs: AI parse + classification ----------
# Put near the top-level with other imports if missing
import math

# Common adult reference ranges (generic; used only when none are found in the text)
# Units are important; we do not auto-convert units here.
DEFAULT_LAB_RANGES = [
    {"name": "hemoglobin",  "aliases": ["hb","hgb","hemoglobin"],         "unit": "g/dL",  "low": 13.0, "high": 17.0},
    {"name": "hematocrit",  "aliases": ["hct","hematocrit"],              "unit": "%",     "low": 40.0, "high": 50.0},
    {"name": "wbc",         "aliases": ["wbc","wbc count","white blood"], "unit": "10^3/uL","low": 4.0, "high": 10.0},
    {"name": "rbc",         "aliases": ["rbc","red blood cells"],         "unit": "10^6/uL","low": 4.5, "high": 5.9},
    {"name": "platelets",   "aliases": ["plt","platelet","platelets"],    "unit": "10^3/uL","low": 150, "high": 450},
    {"name": "mcv",         "aliases": ["mcv"],                           "unit": "fL",    "low": 80,   "high": 100},
    {"name": "mch",         "aliases": ["mch"],                           "unit": "pg",    "low": 27,   "high": 33},
    {"name": "mchc",        "aliases": ["mchc"],                          "unit": "g/dL",  "low": 32,   "high": 36},
    {"name": "rdw",         "aliases": ["rdw"],                           "unit": "%",     "low": 11.5, "high": 14.5},
    {"name": "neutrophils", "aliases": ["neutrophil","neut%"],            "unit": "%",     "low": 40,   "high": 70},
    {"name": "lymphocytes", "aliases": ["lymphocyte","lymph%"],           "unit": "%",     "low": 20,   "high": 45},
    {"name": "monocytes",   "aliases": ["monocyte","mono%"],              "unit": "%",     "low": 2,    "high": 8},
    {"name": "eosinophils", "aliases": ["eosinophil","eos%"],             "unit": "%",     "low": 1,    "high": 4},
    {"name": "basophils",   "aliases": ["basophil","baso%"],              "unit": "%",     "low": 0,    "high": 1},
]

def _canon_name(name: str) -> str:
    t = (name or "").strip().lower()
    t = re.sub(r"[^a-z0-9 %/\^\-\+\.\(\)]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # try alias matching
    for item in DEFAULT_LAB_RANGES:
        if t == item["name"]:
            return item["name"]
        for a in item["aliases"]:
            if t == a:
                return item["name"]
    # light heuristic: remove trailing units in name
    t2 = re.sub(r"\(.*?\)$", "", t).strip()
    for item in DEFAULT_LAB_RANGES:
        if t2 == item["name"] or t2 in item["aliases"]:
            return item["name"]
    return t  # fallback

def _default_range_for(name: str):
    n = _canon_name(name)
    for item in DEFAULT_LAB_RANGES:
        if item["name"] == n:
            return {"low": item["low"], "high": item["high"], "unit": item["unit"], "canonical": n}
    return None

def _to_num(x):
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        t = x.strip().replace(",", ".")
        m = re.match(r"^[-+]?\d+(?:\.\d+)?$", t)
        if m:
            try:
                return float(m.group(0))
            except Exception:
                return None
    return None

def _classify(value, low, high, band_frac=0.075):
    """
    Returns status in {"normal","borderline","abnormal"} and direction {"low","high",None}
    """
    v = _to_num(value); lo = _to_num(low); hi = _to_num(high)
    if v is None or lo is None or hi is None or hi <= lo:
        return {"status": None, "direction": None}
    if v < lo or v > hi:
        return {"status": "abnormal", "direction": "low" if v < lo else "high"}
    band = max( (hi - lo) * band_frac, 1e-9 )
    if abs(v - lo) <= band or abs(v - hi) <= band:
        return {"status": "borderline", "direction": None}
    return {"status": "normal", "direction": None}

@app.post("/labs/parse")
def labs_parse():
    """
    Body: { "text": "OCR raw text" }
    Returns: { "labs": [ {name,value,unit,low,high,status,direction} ... ] }
    """
    payload = request.get_json(silent=True) or {}
    raw_text = (payload.get("text") or "").strip()
    if not raw_text:
        return jsonify({"labs": []}), 200

    # 1) Ask the model to extract structured labs (JSON ONLY)
    system = (
        "Extract laboratory results from text and return STRICT JSON with key 'labs' as an array. "
        "Each item: {name, value, unit, low, high}. "
        "Prefer numeric 'low' and 'high' if a reference range is present. "
        "If a line is not a lab (IDs, dates, headings), ignore it."
    )
    user = f"Text:\n{raw_text[:12000]}"

    llm_labs = []
    try:
        resp = client.chat.completions.create(
            model=os.environ.get("STRUCTURE_MODEL","gpt-4o-mini"),
            temperature=0.2,
            messages=[{"role":"system","content":system},
                      {"role":"user","content":user}],
        )
        content = (resp.choices[0].message.content or "").strip()
        content = re.sub(r"```json|```", "", content, flags=re.I).strip()
        doc = json.loads(content) if content.startswith("{") else {}
        if isinstance(doc, dict) and isinstance(doc.get("labs"), list):
            llm_labs = doc["labs"]
    except Exception:
        llm_labs = []

    # 2) Normalize + fill defaults + classify
    out = []
    seen = set()
    for item in llm_labs:
        name = str(item.get("name") or "").strip()
        value = _to_num(item.get("value"))
        unit  = (item.get("unit") or "").strip()
        low   = _to_num(item.get("low"))
        high  = _to_num(item.get("high"))

        if not name or value is None:
            continue

        # Add defaults when missing
        if low is None or high is None or (high is not None and low is not None and high <= low):
            d = _default_range_for(name)
            if d:
                if not unit: unit = d["unit"]
                if low is None: low = d["low"]
                if high is None: high = d["high"]

        # final guard: ignore obvious non-labs
        canon = _canon_name(name)
        key = (canon, value, unit, low, high)
        if key in seen:
            continue
        seen.add(key)

        cls = _classify(value, low, high)
        out.append({
            "name": name,
            "value": value,
            "unit": unit,
            "low": low,
            "high": high,
            "status": cls["status"],       # "normal" | "borderline" | "abnormal" | None
            "direction": cls["direction"], # "low" | "high" | None
        })

    # 3) Fallback: try a tiny regex parser if LLM returned nothing useful
    if not out:
        lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
        rx = re.compile(
            r"^([A-Za-z][A-Za-z0-9\s\(\)\/\+\-%\.]+?)\s*[:\-]?\s*"
            r"(-?\d+(?:[.,]\d+)?)\s*"
            r"([A-Za-zµ%\/\^\d\.\-]*)\s*"
            r"(?:\(\s*(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?)\s*\)|"
            r"(?:ref(?:erence)?|range|normal)\s*:?[^0-9\-]*(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?)"
            r")?",
            re.I
        )
        for ln in lines:
            m = rx.match(ln)
            if not m: 
                continue
            name = m.group(1).strip()
            v    = _to_num(m.group(2))
            unit = (m.group(3) or "").strip()
            lo   = _to_num(m.group(4) or m.group(6))
            hi   = _to_num(m.group(5) or m.group(7))
            if v is None: 
                continue

            if lo is None or hi is None or (hi is not None and lo is not None and hi <= lo):
                d = _default_range_for(name)
                if d:
                    if not unit: unit = d["unit"]
                    if lo is None: lo = d["low"]
                    if hi is None: hi = d["high"]

            cls = _classify(v, lo, hi)
            out.append({
                "name": name, "value": v, "unit": unit,
                "low": lo, "high": hi, "status": cls["status"], "direction": cls["direction"]
            })

    # keep only sensible rows
    filtered = []
    for r in out:
        # require a numeric value and either a range OR a status decided by AI/fallback
        if r.get("value") is None:
            continue
        if (r.get("low") is None or r.get("high") is None) and r.get("status") is None:
            continue
        filtered.append(r)

    return jsonify({"labs": filtered}), 200
# ---------- Utilities ----------

def _json_only(s: str):
    try:
        return json.loads(re.sub(r"```json|```", "", (s or "").strip(), flags=re.I))
    except Exception:
        m = re.search(r"\{[\s\S]*\}", s or "")
        if m:
            try: return json.loads(m.group(0))
            except Exception: pass
    return None

def _norm_token(s: str) -> str:
    t = re.sub(r"[^a-z0-9\s\-]", " ", (s or "").lower())
    t = re.sub(r"[\s\-]+", " ", t).strip()
    return t

def _best_generic_for_line(line: str, normalized_list: list[str]) -> str | None:
    L = _norm_token(line or "")
    for g in normalized_list or []:
        gt = _norm_token(g)
        if re.search(rf"\b{re.escape(gt)}\b", L) or gt in L:
            return g
    return None

# ---------- Local parsing helpers (no external services) ----------

STRENGTH_RX = r"(?P<strength>\d+(?:\.\d+)?)(?:\s*)(?P<unit>mg|mcg|g|iu|units|ml)\b"
FREQ_WORDS   = r"(once daily|twice daily|three times daily|every\s*\d+\s*(?:h|hr|hrs|hours)|bid|tid|qid|q\d+h|qhs|qam|qpm|prn)"
FORM_WORDS   = r"(tablet|tab|capsule|cap|syrup|solution|suspension|patch|injection|cream|ointment|drops|spray)"
ROUTE_WORDS  = r"(po|oral|by mouth|iv|im|sc|subcut|subcutaneous|topical|inhalation|ophthalmic|otic|nasal|rectal|vaginal)"

NAME_FIRST_RX = re.compile(
    rf"""
    ^\s*
    (?P<name>[A-Za-z][A-Za-z0-9\-\s']+)
    (?:[,;\s]+{STRENGTH_RX})?
    (?:[,;\s]+(?P<form>{FORM_WORDS}))?
    (?:[,;\s]+(?P<route>{ROUTE_WORDS}))?
    (?:[,;\s]+(?P<frequency>{FREQ_WORDS}))?
    (?:[,;\s]+(?P<prn>prn))?
    """,
    re.IGNORECASE | re.VERBOSE,
)

def _clean_str(s: str | None) -> str | None:
    if s is None: return None
    t = re.sub(r"\s+", " ", s).strip()
    return t or None

def _normalize_lines(text: str) -> list[str]:
    lines = [x.strip() for x in re.split(r"[\r\n]+", text or "") if x.strip()]
    out = []
    for ln in lines:
        ln = re.sub(r"^\s*[\-\*\u2022]\s*", "", ln)
        ln = re.sub(r"^\s*\d+\.\s*", "", ln)
        out.append(ln)
    return out

def _parse_line(line: str) -> dict | None:
    m = NAME_FIRST_RX.search(line or "")
    if not m:
        return None
    d = m.groupdict()
    return {
        "name": _clean_str(d.get("name")),
        "strength": _clean_str(d.get("strength")),
        "unit": _clean_str(d.get("unit")),
        "form": _clean_str(d.get("form")),
        "route": _clean_str(d.get("route")),
        "frequency": _clean_str(d.get("frequency")),
        "prn": True if (d.get("prn") or "").lower() == "prn" else False,
        "raw": (line or "").strip(),
    }

# ---------- Dedicated Drug RAG chain (Qdrant-backed) ----------

def get_drug_context_retriever_chain():
    llm = ChatOpenAI(model=os.environ.get("DRUG_QUERY_MODEL", "gpt-4o-mini"))
    retriever = vector_store.as_retriever()
    query_prompt = ChatPromptTemplate.from_messages([
        MessagesPlaceholder("chat_history"),
        ("user", "{input}"),
        ("user",
         "Generate one focused query for authoritative medication/interaction sources "
         "(generic names, classes, mechanisms like CYP/UGT/P-gp, contraindications, dosing).")
    ])
    return create_history_aware_retriever(llm, retriever, query_prompt)

def get_drug_rag_chain():
    retriever_chain = get_drug_context_retriever_chain()
    llm = ChatOpenAI(model=os.environ.get("DRUG_REASONING_MODEL", "gpt-4o"))
    prompt = ChatPromptTemplate.from_messages([
        ("system", DRUG_SYSTEM_PROMPT),
        MessagesPlaceholder("chat_history"),
        ("user", "{input}"),
        ("system", "EVIDENCE EXCERPTS:\n{context}\n")
    ])
    stuff = create_stuff_documents_chain(llm, prompt)
    return create_retrieval_chain(retriever_chain, stuff)

drug_rag_chain = get_drug_rag_chain()

def _rag_name_normalize(lines: list[str]) -> list[str]:
    inputs = "\n".join([f"- {ln}" for ln in lines if ln.strip()])
    user = (
        "MODE: NAME NORMALIZATION\n"
        "Input medication strings (one per line):\n"
        f"{inputs}\n\n"
        "Return STRICT JSON ONLY per schema."
    )
    out = drug_rag_chain.invoke({"chat_history": [], "input": user})
    raw = (out.get("answer") or "").strip()
    doc = _json_only(raw) or {}
    arr = doc.get("normalized") or []
    seen, norm = set(), []
    for a in arr:
        g = (a or "").strip().lower()
        if g and g not in seen:
            seen.add(g); norm.append(g)
    return norm

def _rag_interaction_discovery(generics: list[str]) -> dict:
    if not generics:
        return {"interactions": [], "citations": []}
    bullets = "\n".join([f"- {g}" for g in generics])
    user = (
        "MODE: INTERACTION DISCOVERY\n"
        "Drugs (generic, lowercase):\n"
        f"{bullets}\n\n"
        "Return STRICT JSON ONLY per schema."
    )
    out = drug_rag_chain.invoke({"chat_history": [], "input": user})
    raw = (out.get("answer") or "").strip()
    doc = _json_only(raw) or {}
    inters = doc.get("interactions") or []
    cits   = doc.get("citations") or []
    for it in inters:
        if isinstance(it.get("pair"), list):
            it["pair"] = [(p or "").lower() for p in it["pair"]]
    return {"interactions": inters, "citations": cits}

def _rag_narrative_summary(mapped: list[dict], interactions: list[dict], ocr_text: str) -> str:
    lines = []
    for m in mapped or []:
        parts = [
            m.get("generic") or (m.get("name") or "unknown"),
            f'{m.get("strength","")}{m.get("unit","")}'.strip(),
            m.get("form") or "",
            m.get("route") or "",
            m.get("frequency") or "",
            "PRN" if m.get("prn") else "",
            "(dup)" if m.get("dup") else "",
        ]
        clean = " • ".join([p for p in parts if p]).strip(" •")
        lines.append(f"- {clean}")
    meds_block = "\n".join(lines) or "- (none parsed)"

    user = (
        "MODE: NARRATIVE SUMMARY\n"
        "Produce a concise clinician-facing summary.\n\n"
        "EXTRACTED MEDICATIONS:\n"
        f"{meds_block}\n\n"
        "INTERACTIONS JSON (truncated):\n"
        f"{json.dumps(interactions, ensure_ascii=False)[:4000]}\n\n"
        "OCR CONTEXT (truncated):\n"
        f"{(ocr_text or '')[:2000]}\n"
    )
    out = drug_rag_chain.invoke({"chat_history": [], "input": user})
    return (out.get("answer") or "").strip()

# ---------- ROUTES (POST + OPTIONS to satisfy preflight) ----------

@app.route("/meds/parse", methods=["POST", "OPTIONS"])
def meds_parse():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    meds = []
    for ln in _normalize_lines(text):
        m = _parse_line(ln)
        if m and m.get("name"):
            meds.append(m)
    return jsonify({"meds": meds})

# ====================== helpers for /meds/map (RAG-only) ======================

def _slugify_generic(name: str) -> str:
    """Deterministic, URL-safe id from a generic name (used as pseudo RxCUI)."""
    if not name:
        return ""
    # normalize accents, collapse spaces, keep alnum+hyphen
    x = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    x = re.sub(r"[^a-z0-9]+", "-", x.lower()).strip("-")
    if not x:
        # as a last resort, stable short hash
        x = hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]
    return x

def _rag_map_meds(meds: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Use your existing RAG chain to canonicalize meds in one shot.
    Input 'meds' is the array produced by /meds/parse (name/strength/unit/form/route/frequency/prn/raw).
    Returns aligned list with canonical 'generic', 'form', 'route', 'strength', 'unit', 'frequency'.
    """
    # Build deterministic, index-aligned prompt
    lines = []
    for i, m in enumerate(meds):
        parts = []
        if m.get("name"): parts.append(f"name={m['name']}")
        if m.get("strength"): parts.append(f"strength={m['strength']}")
        if m.get("unit"): parts.append(f"unit={m['unit']}")
        if m.get("form"): parts.append(f"form={m['form']}")
        if m.get("route"): parts.append(f"route={m['route']}")
        if m.get("frequency"): parts.append(f"frequency={m['frequency']}")
        if m.get("prn"): parts.append("prn=true")
        raw = m.get("raw") or " ".join(parts) or (m.get("name") or "")
        lines.append(f"{i}. {raw}".strip())

    # Strict, JSON-only instruction (no brands, lowercase generic)
    instruction = (
        "CANONICALIZE MEDICATION LINES.\n"
        "Return STRICT JSON ONLY as:\n"
        "{ \"mapped\": [ {\"index\": <int>, \"generic\": <string|null>, "
        "\"strength\": <string|null>, \"unit\": <string|null>, "
        "\"form\": <string|null>, \"route\": <string|null>, "
        "\"frequency\": <string|null>, \"prn\": <bool|null> } ... ] }\n"
        "Rules:\n"
        "- generic = lowercase international nonproprietary name (INN), no brand names.\n"
        "- Do NOT invent values. If unknown/unspecified, use null.\n"
        "- Keep array aligned to the input by 'index'.\n"
        "- No extra keys. No markdown. No text outside JSON.\n\n"
        "Input lines:\n" + "\n".join(lines)
    )

    try:
        resp = conversation_rag_chain.invoke({"chat_history": [], "input": instruction})
        raw = (resp.get("answer") or "").strip()
        doc = _extract_json_dict(raw) or {}
        out = doc.get("mapped") or []
        # sanity: coerce to list of dicts with required keys
        norm = []
        for it in out:
            if not isinstance(it, dict): 
                continue
            idx = it.get("index")
            if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(meds):
                continue
            norm.append({
                "index": idx,
                "generic": (it.get("generic") or None),
                "strength": (it.get("strength") or None),
                "unit": (it.get("unit") or None),
                "form": (it.get("form") or None),
                "route": (it.get("route") or None),
                "frequency": (it.get("frequency") or None),
                "prn": bool(it.get("prn")) if it.get("prn") is not None else None,
            })
        return norm
    except Exception:
        # If the model fails, we return an empty signal and let fallback logic handle it.
        return []

# ============================== /meds/map (RAG) ===============================

@app.post("/meds/map")
def meds_map():
    """
    RAG-only canonicalization & duplicate detection.
    Request: { "meds": [ { name,strength,unit,form,route,frequency,prn,raw } ... ] }
    Response: { "mapped": [ { name,strength,unit,form,route,frequency,prn, raw,
                               rxnorm: { rxcui, name }, dup: bool } ... ] }
    - rxnorm.rxcui is a deterministic slug from generic name (pseudo-RxCUI).
    - 'dup' is true when multiple entries share the same generic slug.
    """
    data = request.get_json(silent=True) or {}
    meds = data.get("meds") or []
    if not isinstance(meds, list):
        return jsonify({"error": "meds must be a list"}), 400

    # 1) Ask RAG to canonicalize (best effort)
    rag = _rag_map_meds(meds)

    # 2) Merge RAG output into original rows (preserving any parsed fields)
    merged: List[Dict[str, Any]] = []
    rag_by_idx = {it["index"]: it for it in rag}

    for i, m in enumerate(meds):
        r = rag_by_idx.get(i, {})
        # pick canonical generic if available; else fall back to parsed name (lowercased)
        generic = (r.get("generic") or (m.get("name") or "").strip().lower()) or None
        rxcui = _slugify_generic(generic or (m.get("name") or ""))

        merged.append({
            # original parsed fields from /meds/parse
            "name": m.get("name"),
            "strength": r.get("strength") if r.get("strength") is not None else m.get("strength"),
            "unit": r.get("unit") if r.get("unit") is not None else m.get("unit"),
            "form": r.get("form") if r.get("form") is not None else m.get("form"),
            "route": r.get("route") if r.get("route") is not None else m.get("route"),
            "frequency": r.get("frequency") if r.get("frequency") is not None else m.get("frequency"),
            "prn": r.get("prn") if r.get("prn") is not None else bool(m.get("prn")),
            "raw": m.get("raw") or m.get("name"),

            # canonical handle used by the FE for de-dup & grouping
            "rxnorm": {
                "rxcui": rxcui or None,          # pseudo id (stable)
                "name": generic or m.get("name") # canonical display
            },
        })

    # 3) Duplicate marking by canonical id (slug)
    bucket: Dict[str, List[int]] = {}
    for idx, m in enumerate(merged):
        key = (m.get("rxnorm") or {}).get("rxcui") or ""
        if not key:
            continue
        bucket.setdefault(key, []).append(idx)

    for idxs in bucket.values():
        if len(idxs) > 1:
            for i in idxs:
                merged[i]["dup"] = True

    return jsonify({"mapped": merged}), 200

@app.route("/meds/check", methods=["POST", "OPTIONS"])
def meds_check():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    # Accept any of the following payload styles:
    # 1) {"drugs": ["amoxicillin","lisinopril", ...]}
    # 2) {"mapped": [ {...,"generic":"amoxicillin"}, ... ]}
    # 3) {"rxcuis": ["amoxicillin","lisinopril"]}  # treated as generics (BWC)
    drugs = data.get("drugs") or []
    if not drugs:
        mapped = data.get("mapped") or []
        if mapped:
            drugs = [ (m.get("generic") or "").strip().lower()
                      for m in mapped if (m.get("generic") or "").strip() ]
    if not drugs:
        # Back-compat with frontends sending rxcuis (we treat them as generics here)
        drugs = [ (x or "").strip().lower() for x in (data.get("rxcuis") or []) ]

    # unique, ordered
    seen, generics = set(), []
    for d in drugs:
        d = (d or "").strip().lower()
        if d and d not in seen:
            seen.add(d); generics.append(d)

    res = _rag_interaction_discovery(generics)
    return jsonify(res)

@app.route("/meds/analyze-stream", methods=["POST", "OPTIONS"])
def meds_analyze_stream():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    mapped = data.get("mapped") or []
    interactions_obj = data.get("interactions")

    if not interactions_obj:
        generics, seen = [], set()
        for m in mapped:
            g = (m.get("generic") or "").strip().lower()
            if g and g not in seen:
                seen.add(g); generics.append(g)
        interactions_obj = _rag_interaction_discovery(generics)

    try:
        narrative_text = _rag_narrative_summary(mapped, interactions_obj.get("interactions") or [], text)
    except Exception as e:
        narrative_text = f"[Error generating narrative: {e}]"

    def generate():
        for chunk in re.findall(r".{1,600}", narrative_text, flags=re.S):
            yield chunk

    return Response(stream_with_context(generate()), content_type="text/plain")
# ============================== Speech-to-Text ==============================
SUPPORTED_FORMATS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']

def speech_to_text(path: str) -> dict:
    with open(path, "rb") as f:
        res = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            response_format="text"   # simplest: returns raw text string
        )
    # Some SDKs return a str directly for response_format="text"
    text = getattr(res, "text", None)
    if isinstance(res, str) and not text:
        text = res
    return {"text": (text or "").strip()}

@app.route("/transcribe_widget", methods=["POST"])
def transcribe_widget():
    if "audio_data" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio_data"]
    file_extension = (audio_file.filename.rsplit(".", 1)[-1] if "." in audio_file.filename else "").lower()

    if file_extension not in SUPPORTED_FORMATS:
        return jsonify({
            "error": f"Unsupported file format: {file_extension}. "
                     f"Supported formats: {SUPPORTED_FORMATS}"
        }), 400

    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{file_extension}") as tmp:
        audio_file.save(tmp.name)
        temp_path = tmp.name

    try:
        transcript_result = speech_to_text(temp_path)
    finally:
        try:
            os.remove(temp_path)
        except Exception:
            pass

    return jsonify({"transcript": transcript_result.get("text", "")})
# ============================== Medical Vision ==============================
# In-memory caches (swap to Redis/DB in production)
VISION_CACHE = {}        # image_id -> {"data_url": ..., "meta": {...}, "session_id": ...}
SESSION_CONTEXT = {}     # session_id -> {"transcript": "...", "summary": "...", ...}
# ^ If you already have a context store from /set-context, reuse that instead of this dict.

MEDICAL_VISION_SYSTEM_PROMPT = (
    "You are an AI clinical imaging assistant speaking to a physician (not the patient). "
    "Use a doctor-to-doctor tone. "
    "Identify the likely modality (e.g., X-ray, CT, MRI, ultrasound, ECG, fundus, dermoscopy, wound photo, slide). "
    "Be succinct, evidence-minded, and avoid patient-facing language. "
    "Never fabricate measurements; do not claim a diagnosis."
)

def _file_to_data_url(file_storage):
    data = file_storage.read()
    if not data:
        return None
    mimetype = file_storage.mimetype or "application/octet-stream"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mimetype};base64,{b64}"

def _get_session_context_text(session_id: str) -> str:
    """
    Pull the current clinical context so the vision model understands the case.
    Replace this with your existing context store (e.g., the one set by /set-context).
    """
    ctx = (SESSION_CONTEXT or {}).get(session_id) or {}
    bits = []
    if ctx.get("summary"):
        bits.append(f"SUMMARY:\n{ctx['summary']}")
    if ctx.get("transcript"):
        bits.append(f"TRANSCRIPT (recent):\n{ctx['transcript'][:4000]}")
    if ctx.get("condition"):
        bits.append(f"PROVISIONAL CONDITION: {ctx['condition']}")
    return "\n\n".join(bits) if bits else "No additional session context available."

def _extract_numbered_questions(markdown_text: str):
    """
    Heuristic: extract lines like '1. ...', '2. ...' to return as a questions array.
    Helpful for clients that want machine-readable prompts; text is still returned for chat.
    """
    if not markdown_text:
        return []
    out = []
    for line in markdown_text.splitlines():
        line = line.strip()
        # 1. Question text
        if line[:2].isdigit() or line.startswith("1."):
            pass  # fall through to regex
        import re
        m = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if m:
            q = m.group(1).strip()
            if q:
                out.append(q)
    return out

@app.route("/vision/analyze", methods=["POST"])
def vision_analyze():
    """
    Two-phase endpoint.

    Phase A (init): multipart/form-data
      - image: file (required)
      - session_id: optional (recommended) – ties into whole app context
      - prompt: optional string (overrides default instruction)
    -> returns:
       { phase: "questions",
         text: "<physician-facing follow-up questions>",
         questions: ["Q1", "Q2", ...],     # best-effort extraction
         image_id: "<id for finalize>",
         meta: {...}
       }

    Phase B (finalize): application/json
      { "image_id": "<from init>", "answers": ["...","..."], "session_id": "..." }
    -> returns:
       { phase: "final", text: "<final report markdown>", meta: {...} }
    """
    try:
        # -------- PHASE A: INIT (upload) --------
        if "image" in request.files:
            f = request.files["image"]
            if not (f and (f.mimetype or "").startswith("image/")):
                return jsonify(error="Only image/* files are accepted."), 400

            data_url = _file_to_data_url(f)
            if not data_url:
                return jsonify(error="Empty file or read error."), 400

            session_id = (request.form.get("session_id") or "").strip() or None
            user_prompt = request.form.get("prompt", "").strip() or \
                "Before any final report, ask targeted follow-up questions you need to optimize the read."

            ctx_text = _get_session_context_text(session_id) if session_id else "No additional session context."

            # Compose: ask QUESTIONS FIRST (no final report yet)
            # Return a short, physician-facing set of 3–6 targeted questions.
            init_resp = client.responses.create(
                model="gpt-4o",
                input=[
                    {
                        "role": "system",
                        "content": [
                            {"type": "input_text", "text": MEDICAL_VISION_SYSTEM_PROMPT},
                            {"type": "input_text", "text":
                                "You are in PHASE A (follow-up questions first). "
                                "Given the image and case context, produce 3–6 concise, targeted questions "
                                "that would materially change or sharpen your final read. "
                                "Prefer specifics (e.g., acuity, clinical status, device placement context, "
                                "prior comparisons, suspected complication). "
                                "Do NOT produce a final report in this phase."
                             },
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text":
                                f"CASE CONTEXT (from session {session_id or 'n/a'}):\n{ctx_text}\n\n"
                                f"PHASE A TASK: {user_prompt}"
                             },
                            {"type": "input_image", "image_url": data_url},
                        ],
                    },
                ],
            )

            text = init_resp.output_text or "Please answer the follow-up questions to proceed."
            questions = _extract_numbered_questions(text)

            image_id = str(uuid.uuid4())
            meta = {
                "filename": getattr(f, "filename", None),
                "mimetype": f.mimetype,
                "size": request.content_length or None,
            }
            VISION_CACHE[image_id] = {
                "data_url": data_url,
                "meta": meta,
                "session_id": session_id,
            }

            return jsonify(
                phase="questions",
                text=text,
                questions=questions,
                image_id=image_id,
                meta=meta,
            ), 200

        # -------- PHASE B: FINALIZE (answers -> final report) --------
        data = request.get_json(silent=True) or {}
        image_id = (data.get("image_id") or "").strip()
        answers = data.get("answers")
        session_id = (data.get("session_id") or "").strip() or None

        if not image_id:
            return jsonify(error="Missing image_id."), 400
        if answers is None:
            return jsonify(error="Missing answers (array or string)."), 400

        rec = VISION_CACHE.get(image_id)
        if not rec:
            return jsonify(error="Unknown or expired image_id."), 400

        data_url = rec["data_url"]
        meta = rec["meta"]
        ctx_text = _get_session_context_text(session_id or rec.get("session_id"))

        if isinstance(answers, list):
            answers_text = "\n".join(f"- {a}" for a in answers if str(a).strip())
        else:
            answers_text = str(answers or "").strip()

        # Compose FINAL report with answers + context
        final_resp = client.responses.create(
            model="gpt-4o",
            input=[
                {
                    "role": "system",
                    "content": [
                        {"type": "input_text", "text": MEDICAL_VISION_SYSTEM_PROMPT},
                        {"type": "input_text", "text":
                            "You are now in PHASE B (final report). "
                            "Integrate: case context, the image, and the doctor's answers. "
                            "Return a concise, physician-facing read with this structure:\n"
                            "1) Modality & adequacy (if relevant)\n"
                            "2) Key findings (bulleted, precise)\n"
                            "3) Focused differential with rationale\n"
                            "4) Recommendations (next steps / measurements / views)\n"
                            "5) Safety red flags\n"
                            "Avoid patient-facing language. Do not fabricate measurements."
                         },
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text":
                            f"CASE CONTEXT (from session {session_id or 'n/a'}):\n{ctx_text}"
                         },
                        {"type": "input_text", "text":
                            f"PHASE B – DOCTOR ANSWERS:\n{answers_text or 'No additional answers provided.'}"
                         },
                        {"type": "input_image", "image_url": data_url},
                    ],
                },
            ],
        )

        text = final_resp.output_text or "No report generated."
        return jsonify(phase="final", text=text, meta=meta), 200

    except Exception as e:
        return jsonify(error=str(e)), 500
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
