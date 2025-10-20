# app.py — cleaned, deduplicated, deployment-ready

import os
import re
import ast
import json
import math
import uuid
import base64
import hashlib
import logging
import mimetypes
import unicodedata
import tempfile
import requests
from uuid import uuid4
from datetime import datetime, timezone
from typing import List, Dict, Any

from dotenv import load_dotenv
from flask import (
    Flask, request, jsonify, Response,
    stream_with_context, make_response
)
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.utils import secure_filename
from flask_cors import CORS

import qdrant_client
from qdrant_client import QdrantClient

from openai import OpenAI

# LangChain / Vector store
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_qdrant import QdrantVectorStore  # new API (old Qdrant is deprecated)
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain

# Prompts
from prompts.prompt import engineeredprompt
from prompts.drug_system_prompt import DRUG_SYSTEM_PROMPT

# -------------------------------------------------------------------
# Load env and basic config
# -------------------------------------------------------------------
load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("Missing OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY)

QDRANT_URL = os.getenv("QDRANT_HOST") or os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION_NAME")
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY")

# Request limits (deploy-safe defaults)
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", 20 * 1024 * 1024))   # 20MB
PROVIDER_LIMIT_MB = int(os.getenv("OCR_PROVIDER_LIMIT_MB", "1"))     # OCR.Space free ~1MB
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES

# Logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("doctor-assistant")

# CORS (single consolidated config)
CORS(
    app,
    resources={
        r"/*": {
            "origins": [
                "https://ai-doctor-assistant-app-dev.onrender.com",
                "http://localhost:3000",
            ],
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": [
                "Content-Type", "Authorization", "Accept", "X-Requested-With", "X-Session-Id"
            ],
            "expose_headers": ["Content-Type"],
            "supports_credentials": True,
            "max_age": 86400,
        }
    },
)

# Constants for OpenAI Realtime/SDP endpoints
OAI_BASE = "https://api.openai.com/v1"
COMMON_JSON_HEADERS = {
    "Authorization": f"Bearer {OPENAI_API_KEY}",
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
}

# -------------------------------------------------------------------
# Session state (in-memory)
# -------------------------------------------------------------------
chat_sessions: Dict[str, List[Dict[str, str]]] = {}
session_context: Dict[str, Dict[str, Any]] = {}
ACTIVE_TEMPLATES: Dict[str, Dict[str, Any]] = {}

# -------------------------------------------------------------------
# Qdrant + Vector Store (migrated to QdrantVectorStore)
# -------------------------------------------------------------------
def get_vector_store() -> QdrantVectorStore:
    """
    Build a QdrantVectorStore retriever connection.
    - Uses check_compatibility=False to avoid noisy version warnings when you control both ends.
      See qdrant-client docs for this parameter.
    """
    qdrant = QdrantClient(
        url=QDRANT_URL,
        api_key=QDRANT_API_KEY,
        timeout=60.0,
        check_compatibility=False,  # silence version check when you know it's OK
    )
    embeddings = OpenAIEmbeddings()
    return QdrantVectorStore(
        client=qdrant,
        collection_name=QDRANT_COLLECTION,
        embeddings=embeddings
    )

vector_store = get_vector_store()

# -------------------------------------------------------------------
# RAG chains
# -------------------------------------------------------------------
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

# -------------------------------------------------------------------
# Utility: tolerant JSON extraction and helpers
# -------------------------------------------------------------------
def _extract_json_dict(text: str):
    if not text:
        return None
    cleaned = re.sub(r"```json|```", "", text, flags=re.I).strip()
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

def _json_only(s: str):
    try:
        return json.loads(re.sub(r"```json|```", "", (s or "").strip(), flags=re.I))
    except Exception:
        m = re.search(r"\{[\s\S]*\}", s or "")
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None

def _coerce_float(x):
    try:
        if x in (None, "", "null"):
            return None
        return float(x)
    except Exception:
        return None

# -------------------------------------------------------------------
# Health
# -------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True}

# -------------------------------------------------------------------
# Whisper transcription (file upload)
# -------------------------------------------------------------------
def speech_to_text(audio_path: str) -> Dict[str, str]:
    with open(audio_path, "rb") as f:
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            response_format="text",
            file=f
        )
    return {"text": transcript}

@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio_data" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    audio_file = request.files["audio_data"]
    supported = {'flac','m4a','mp3','mp4','mpeg','mpga','oga','ogg','wav','webm'}
    ext = (audio_file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in supported:
        return jsonify({"error": f"Unsupported file format: {ext}. Supported: {sorted(supported)}"}), 400
    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
        audio_file.save(tmp.name)
        path = tmp.name
    try:
        out = speech_to_text(path)
    finally:
        try:
            os.remove(path)
        except Exception:
            pass
    return jsonify({"transcript": out.get("text", "")})

# -------------------------------------------------------------------
# Chat (RAG) — stream + single
# -------------------------------------------------------------------
@app.route("/stream", methods=["POST"])
def stream():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    user_input = (data.get("message") or "").strip()
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    chat_sessions.setdefault(session_id, [])

    def gen():
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

    return Response(stream_with_context(gen()), content_type="text/plain")

@app.route("/generate", methods=["POST"])
def generate_once():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    user_input = (data.get("message") or "").strip()
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    chat_sessions.setdefault(session_id, [])
    resp = conversation_rag_chain.invoke({"chat_history": chat_sessions[session_id], "input": user_input})
    answer = resp.get("answer", "")

    chat_sessions[session_id].append({"role": "user", "content": user_input})
    chat_sessions[session_id].append({"role": "assistant", "content": answer})
    return jsonify({"response": answer, "session_id": session_id})

@app.route("/reset", methods=["POST"])
def reset():
    session_id = (request.json or {}).get("session_id")
    if session_id and session_id in chat_sessions:
        del chat_sessions[session_id]
    return jsonify({"message": "Session reset"}), 200

# -------------------------------------------------------------------
# TTS helper (OpenAI)
# -------------------------------------------------------------------
@app.route("/tts", methods=["POST"])
def tts():
    text = (request.json or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "No text supplied"}), 400
    resp = client.audio.speech.create(model="tts-1", voice="fable", input=text)
    out = "temp_audio.mp3"
    resp.stream_to_file(out)
    with open(out, "rb") as f:
        b = f.read()
    audio_b64 = base64.b64encode(b).decode("utf-8")
    try:
        os.remove(out)
    except Exception:
        pass
    return jsonify({"audio_base64": audio_b64})

# -------------------------------------------------------------------
# Suggestions (uses RAG)
# -------------------------------------------------------------------
@app.route("/suggestions", methods=["GET"])
def suggestions():
    templates = [
        "Please suggest 25 common and helpful diagnostic questions a doctor might ask when seeking a second opinion for a patient. Format them as a numbered list.",
        "Generate a list of 25 essential questions for supporting doctors in diagnosis and treatment planning. Focus on supplementing the doctor’s opinion with clinical reasoning and guidelines.",
        "What are 25 frequently asked questions doctors could use when evaluating differential diagnoses and treatment options? Return them in a numbered list format.",
        "Suggest 25 diverse clinical questions that guide analysis from patient history to diagnosis, investigations, and treatment planning. Provide a numbered list.",
        "As an AI Doctor Assistant, list 25 insightful questions that help doctors structure decision-making: diagnostics, risk/benefit assessment, treatment pathways, and patient safety. Return as a numbered list."
    ]
    import random
    prompt = random.choice(templates)
    response = conversation_rag_chain.invoke({"chat_history": [], "input": prompt})
    raw = response.get("answer", "")
    lines = raw.split("\n")
    qs = [re.sub(r"^[\s•\-\d\.\)]+", "", ln).strip() for ln in lines if ln.strip()]
    return jsonify({"suggested_questions": qs[:25]})

# -------------------------------------------------------------------
# Second opinion (structured JSON first, then narrative) — streaming
# -------------------------------------------------------------------
@app.route("/case_second_opinion_stream", methods=["POST", "OPTIONS"])
def case_second_opinion_stream():
    if request.method == "OPTIONS":
        return make_response(("", 204))
    data = request.get_json(silent=True) or {}
    context = (data.get("context") or "").strip()
    session_id = data.get("session_id", str(uuid4()))
    if not context:
        return jsonify({"error": "No context provided"}), 400

    chat_sessions.setdefault(session_id, [])

    def _clean_transcript(t: str) -> str:
        t = re.sub(r"\[\d{1,2}:\d{2}(?::\d{2})?\]", " ", t)
        t = re.sub(r"\([^\)]*?(noise|inaudible|laughter)[^\)]*\)", " ", t, flags=re.I)
        return re.sub(r"\s+", " ", t).strip()

    structured_instruction = (
        "SECOND OPINION CASE ANALYSIS.\n"
        "Begin with a single fenced JSON block exactly as:\n"
        "```json\n"
        "{\n"
        '  "primary_diagnosis": {"name": "STRING", "icd10": "STRING or null"},\n'
        '  "differential_diagnosis": [{"name": "STRING", "probability_percent": 35, "icd10": "STRING or null"}],\n'
        '  "recommended_labs": ["..."],\n'
        '  "imaging": ["..."],\n'
        '  "prescriptions": ["..."],\n'
        '  "recommendations": ["..."],\n'
        '  "treatment_plan": ["..."],\n'
        '  "services": ["..."]\n'
        "}\n"
        "```\n"
        "Then continue with these headings in order:\n"
        "The diagnosis:\n"
        "The differential diagnosis:\n"
        "The recommended lab test and investigation:\n"
        "Drug prescriptions:\n"
        "Recommendations to The Doctor:\n"
        "Treatment plan:\n"
        "Append an optional Mermaid flow at the end."
    )

    rag_input = (
        f"{structured_instruction}\n\n"
        "Patient consultation transcript (cleaned):\n"
        f"{_clean_transcript(context)}\n"
    )

    def gen():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream({
                "chat_history": chat_sessions.get(session_id, []),
                "input": rag_input
            }):
                token = chunk.get("answer", "")
                if not token:
                    continue
                acc += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"
        chat_sessions[session_id].append({"role": "user", "content": "[Voice Transcript Submitted]"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    resp = Response(stream_with_context(gen()), mimetype="text/plain; charset=utf-8")
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# -------------------------------------------------------------------
# Dosage helpers + endpoints (plain and with context) — stream + single
# -------------------------------------------------------------------
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

def _build_dosage_prompt(drug, age, weight, condition):
    return (
        "CLINICAL DOSAGE CALCULATION REQUEST (ENGLISH ONLY).\n"
        "Use ONLY knowledge retrieved by the RAG chain. Consider adult vs pediatric dosing, renal/hepatic adjustments, and indication.\n"
        "Return STRICT JSON with EXACT keys: dosage, regimen, notes.\n"
        "{\n"
        '  "dosage": "e.g., 500 mg every 8 hours",\n'
        '  "regimen": "e.g., Oral for 7 days",\n'
        '  "notes": "safety/monitoring/adjustments"\n'
        "}\n\n"
        f"Patient:\n- Drug: {drug}\n- Age: {age} years\n- Weight: {weight} kg\n- Condition: {condition}\n"
    )

@app.route("/calculate-dosage-stream", methods=["POST"])
def calculate_dosage_stream():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    err = _validate_dosage_payload(data)
    if err: return jsonify({"error": err}), 400
    chat_sessions.setdefault(session_id, [])

    prompt = _build_dosage_prompt(data["drug"], float(data["age"]), float(data["weight"]), data["condition"])

    def gen():
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
            "content": f"[Dosage Request] {data['drug']} / {data['age']}y / {data['weight']}kg / {data['condition']}"
        })
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(gen()), content_type="text/plain")

@app.route("/calculate-dosage", methods=["POST"])
def calculate_dosage():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    err = _validate_dosage_payload(data)
    if err: return jsonify({"error": err}), 400
    chat_sessions.setdefault(session_id, [])

    prompt = _build_dosage_prompt(data["drug"], float(data["age"]), float(data["weight"]), data["condition"])
    try:
        response = conversation_rag_chain.invoke({"chat_history": chat_sessions[session_id], "input": prompt})
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw)
        if not parsed or not isinstance(parsed, dict):
            return jsonify({"error": "The model did not return valid JSON.", "raw": raw[:2000]}), 502
        dosage = str(parsed.get("dosage", "")).strip()
        regimen = str(parsed.get("regimen", "")).strip()
        notes = str(parsed.get("notes", "")).strip()
        if not (dosage and regimen):
            return jsonify({"error": "Incomplete dosage JSON from model.", "raw": raw[:2000]}), 502

        chat_sessions[session_id].append({
            "role": "user",
            "content": f"[Dosage Request] {data['drug']} / {data['age']}y / {data['weight']}kg / {data['condition']}"
        })
        chat_sessions[session_id].append({"role": "assistant", "content": raw})
        return jsonify({"dosage": dosage, "regimen": regimen, "notes": notes, "session_id": session_id}), 200
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

# -------------------------------------------------------------------
# STRICT CONTEXT extraction (single definitive set_context)
# -------------------------------------------------------------------
def _extract_numbers_fallback(transcript: str):
    if not transcript:
        return {}
    t = transcript.lower()
    age = None
    weight = None
    for pat in [r'age\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)', r'(\d{1,3}(?:\.\d+)?)\s*(?:years?|yrs?|y/o)\b']:
        m = re.search(pat, t)
        if m: age = _coerce_float(m.group(1)); break
    for pat in [r'weight\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*kg', r'wt\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*kg', r'\b(\d{1,3}(?:\.\d+)?)\s*kg\b']:
        m = re.search(pat, t)
        if m: weight = _coerce_float(m.group(1)); break
    return {"age_years": age, "weight_kg": weight}

def _build_context_extraction_prompt_strict(transcript: str, topn: int = 12) -> str:
    return (
        "You are a clinical information extractor. Return STRICT JSON ONLY.\n"
        "{\n"
        '  "condition": "short primary condition/working diagnosis in English (no ICD code)",\n'
        '  "description": "one short sentence summary in English",\n'
        '  "age_years": number | null,\n'
        '  "weight_kg": number | null,\n'
        f'  "drug_suggestions": ["top {topn} plausible generic drugs (lowercase generic names)"]\n'
        "}\n"
        "Use null when unknown; do NOT invent values. Items must be unique.\n\n"
        f"Transcript:\n{transcript}\n"
    )

def _strict_llm_json(prompt: str):
    try:
        response = conversation_rag_chain.invoke({"chat_history": [], "input": prompt})
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}

def _extract_case_fields_strict(transcript: str, topn: int = 12):
    data = _strict_llm_json(_build_context_extraction_prompt_strict(transcript, topn=topn)) or {}
    condition = (data.get("condition") or "").strip() or None
    description = (data.get("description") or "").strip() or None
    age_years = _coerce_float(data.get("age_years"))
    weight_kg = _coerce_float(data.get("weight_kg"))
    drug_suggestions = list(dict.fromkeys([*(data.get("drug_suggestions") or [])]))
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
    ctx = session_context.get(session_id, {})
    return {
        "drug": (data.get("drug") or "").strip() or None,
        "age": _coerce_float(data.get("age")) if data.get("age") not in (None, "") else ctx.get("age_years"),
        "weight": _coerce_float(data.get("weight")) if data.get("weight") not in (None, "") else ctx.get("weight_kg"),
        "condition": (data.get("condition") or ctx.get("condition") or None),
    }

def _ensure_context(session_id: str, transcript: str = None, topn: int = 12):
    ctx = session_context.get(session_id, {})
    need_extract = (
        not ctx or ctx.get("condition") in (None, "") or
        ctx.get("age_years") is None or ctx.get("weight_kg") is None or
        not ctx.get("drug_suggestions")
    )
    if need_extract and (transcript or ctx.get("transcript")):
        src = transcript or ctx.get("transcript")
        new_ctx = _extract_case_fields_strict(src, topn=topn)
        merged = {**ctx, **{k: v for k, v in new_ctx.items() if v not in (None, "", [])}}
        session_context[session_id] = merged
        return merged
    session_context.setdefault(session_id, ctx)
    return session_context[session_id]

@app.route("/set-context", methods=["POST"])
def set_context():
    """Single canonical set-context endpoint (deduplicated)."""
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
    session_id = request.args.get("session_id", "")
    ctx = session_context.get(session_id)
    if not session_id or not ctx:
        return jsonify({"exists": False}), 200
    return jsonify({"exists": True, "session_id": session_id, **ctx}), 200

@app.route("/context-ensure", methods=["POST"])
def context_ensure():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    transcript = (data.get("transcript") or "").strip() or None
    ctx = _ensure_context(session_id, transcript=transcript)
    return jsonify({"session_id": session_id, **ctx, "exists": bool(ctx)}), 200

# Auto-context dosage
@app.route("/calculate-dosage-with-context", methods=["POST"])
def calculate_dosage_with_context():
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
    try:
        prompt = _build_dosage_prompt(
            str(merged["drug"]).strip(), float(merged["age"]),
            float(merged["weight"]), str(merged["condition"]).strip()
        )
        response = conversation_rag_chain.invoke({"chat_history": chat_sessions.get(session_id, []), "input": prompt})
        raw = (response.get("answer") or "").strip()
        parsed = _extract_json_dict(raw)
        if not parsed or not isinstance(parsed, dict):
            return jsonify({"error": "The model did not return valid JSON.", "raw": raw[:2000]}), 502
        dosage = str(parsed.get("dosage", "")).strip()
        regimen = str(parsed.get("regimen", "")).strip()
        notes = str(parsed.get("notes", "")).strip()
        if not (dosage and regimen):
            return jsonify({"error": "Incomplete dosage JSON from model.", "raw": raw[:2000]}), 502
        chat_sessions.setdefault(session_id, [])
        chat_sessions[session_id].append({"role": "user", "content": f"[Dosage+Ctx] {merged}"})
        chat_sessions[session_id].append({"role": "assistant", "content": raw})
        return jsonify({"dosage": dosage, "regimen": regimen, "notes": notes, "session_id": session_id}), 200
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

@app.route("/calculate-dosage-stream-with-context", methods=["POST"])
def calculate_dosage_stream_with_context():
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

    chat_sessions.setdefault(session_id, [])
    prompt = _build_dosage_prompt(
        str(merged["drug"]).strip(), float(merged["age"]),
        float(merged["weight"]), str(merged["condition"]).strip()
    )

    def gen():
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

    return Response(stream_with_context(gen()), content_type="text/plain")

# -------------------------------------------------------------------
# Specialty template: generate / activate / deactivate / active
# -------------------------------------------------------------------
def _build_specialty_template_prompt(specialty: str) -> str:
    return (
        "You are a clinical template designer. RETURN STRICT JSON ONLY.\n"
        "{\n"
        '  "specialty": "lowercase specialty name",\n'
        '  "sections": [\n'
        '     {"title":"Subjective","fields":["..."]},\n'
        '     {"title":"Objective","fields":["..."]},\n'
        '     {"title":"Assessment","fields":["..."]},\n'
        '     {"title":"Plan","fields":["..."]}\n'
        "  ],\n"
        '  "follow_up_questions":["short, direct clinician prompts..."],\n'
        '  "style":{"tone":"concise, clinical","bullets":true,"icd_cpt_suggestions":true}\n'
        "}\n"
        f"- Specialty: {specialty}\n"
    )

def _safe_json_dict(text: str):
    try:
        return json.loads(re.sub(r"```json|```", "", (text or "").strip(), flags=re.I))
    except Exception:
        m = re.search(r"\{[\s\S]*\}", text or "")
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return None

@app.route("/specialty-template/generate", methods=["POST"])
def specialty_template_generate():
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
    except Exception:
        doc = None
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
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    user_input = (data.get("message") or "").strip()
    if not user_input:
        return jsonify({"error": "No input message"}), 400

    active = ACTIVE_TEMPLATES.get(session_id)
    chat_sessions.setdefault(session_id, [])

    if not active:
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
            chat_sessions[session_id].append({"role": "user", "content": user_input})
            chat_sessions[session_id].append({"role": "assistant", "content": answer})
        return Response(stream_with_context(passthrough()), content_type="text/plain")

    template = active["template"]
    instruction = (
        "ADAPTIVE SPECIALTY TEMPLATE MODE (STRICT):\n"
        "- Use the TEMPLATE_JSON sections order and field names to structure the note.\n"
        "- Fill known items; list **Missing** fields and ask <=2 targeted follow-ups from template.follow_up_questions.\n"
        "- Tone: concise, clinical; prefer bullets; add ICD/CPT hints at the end if appropriate.\n"
        f"TEMPLATE_JSON:\n{json.dumps(template, ensure_ascii=False)}\n\n"
        f"USER_MESSAGE:\n{user_input}\n"
    )

    def gen():
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

    return Response(stream_with_context(gen()), content_type="text/plain")

# -------------------------------------------------------------------
# Analyze form case (stream)
# -------------------------------------------------------------------
@app.post("/analyze-form-case-stream")
def analyze_form_case_stream():
    data = request.get_json() or {}
    session_id = str(data.get("session_id") or "")
    specialty = str(data.get("specialty") or "").strip()
    form = data.get("form") or data.get("answers") or {}
    if not specialty:
        return jsonify({"error": "specialty is required"}), 400

    lines = []
    for k, v in form.items():
        if v in (None, "", []): continue
        key = str(k).replace("_", " ").title()
        val = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
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
    chat_sessions.setdefault(session_id, [])

    def gen():
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
        chat_sessions[session_id].append({"role": "user", "content": f"[Form:{specialty}] {form_text}"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(gen()), content_type="text/plain")

# -------------------------------------------------------------------
# Prompt Formatter + Form Report Stream (anti-dup)
# -------------------------------------------------------------------
@app.post("/prompt-formatter")
def prompt_formatter():
    data = request.get_json() or {}
    session_id = data.get("session_id", str(uuid4()))
    specialty = (data.get("specialty") or "").strip()
    raw_text = (data.get("raw") or "").strip()
    form = data.get("form") or data.get("answers") or {}

    def dict_to_bullets(d: dict) -> str:
        lines = []
        for k, v in (d or {}).items():
            if v in (None, "", []): continue
            key = str(k).replace("_", " ").title()
            val = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
            lines.append(f"- **{key}:** {val}")
        return "\n".join(lines) if lines else "_No details provided_"

    form_md = raw_text or dict_to_bullets(form)
    formatter_instruction = (
        "You are PromptFormatter. Convert the following clinical case details into clean, concise **Markdown** with "
        "EXACTLY these headings once each:\n"
        "## Patient Summary\n"
        "## Key Findings\n"
        "## Risks/Red Flags\n"
        "## Questions to Clarify (max 3)\n"
        "Rules:\n"
        "- English only. No treatment advice. No duplication. No filler.\n"
        "- Short bullet points. Clinically neutral.\n"
    )
    user_payload = (
        f"{formatter_instruction}\n\n"
        f"**Specialty:** {specialty or 'general'}\n\n"
        f"**Raw Case Details:**\n{form_md}\n\n"
        "Return only the four sections in Markdown."
    )
    try:
        resp = conversation_rag_chain.invoke({"chat_history": [], "input": user_payload})
        formatted_case_md = (resp.get("answer") or "").strip()
    except Exception:
        formatted_case_md = (
            f"## Patient Summary\n- Specialty: {specialty or 'general'}\n\n"
            f"## Key Findings\n{form_md}\n\n"
            f"## Risks/Red Flags\n_None_\n\n"
            f"## Questions to Clarify (max 3)\n- _None_"
        )

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
        "- Base your answer only on the Case Summary below.\n"
    )
    formatted_prompt = f"{downstream_instructions}\n---\n### Case Summary\n{formatted_case_md}\n"
    return jsonify({"session_id": session_id, "formatted_prompt": formatted_prompt}), 200

@app.post("/form-report-stream")
def form_report_stream():
    data = request.get_json() or {}
    session_id  = data.get("session_id", str(uuid4()))
    specialty   = (data.get("specialty") or "").strip() or "general"
    form        = data.get("form") or data.get("answers") or {}
    chat_sessions.setdefault(session_id, [])

    def dict_to_md(d: dict) -> str:
        lines = []
        for k, v in (d or {}).items():
            if v in (None, "", []): continue
            label = str(k).replace("_", " ").title()
            val = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
            lines.append(f"- **{label}:** {val}")
        return "\n".join(lines) if lines else "_No details provided_"

    case_md = dict_to_md(form)
    instruction = (
        "You are a clinical assistant. Output strictly in **Markdown** using these EXACT headings once each:\n"
        "## Assessment\n"
        "## Differential Diagnoses\n"
        "## Recommended Tests\n"
        "## Initial Management\n"
        "## Patient Advice & Safety-Net\n"
        "## Follow-up Question (one line)\n"
        "Rules:\n"
        "- English only\n"
        "- Do **not** echo the input. Do **not** repeat words or lines.\n"
        "- If information is missing, write _Unknown_.\n"
        "- No JSON. No code blocks other than Markdown lists.\n"
        f"\n### Specialty\n- {specialty}\n"
        f"\n### Case Details\n{case_md}\n"
    )

    import re
    acc, buf = [], ""
    RE_WORD_REPEAT = re.compile(r"\b(\w+)(\s+\1){1,}\b", flags=re.IGNORECASE)

    def sanitize_and_diff(new_text: str, old_clean: str) -> str:
        cleaned = RE_WORD_REPEAT.sub(r"\1", new_text)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        lines = cleaned.splitlines()
        out_lines, prev_norm = [], None
        for ln in lines:
            norm = re.sub(r"\s+", " ", ln.strip().lower())
            if norm == prev_norm:
                continue
            out_lines.append(ln); prev_norm = norm
        cleaned = "\n".join(out_lines)
        if cleaned.startswith(old_clean): return cleaned[len(old_clean):]
        return cleaned[-max(0, len(cleaned) - len(old_clean)):]  # tail

    def gen():
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
        chat_sessions[session_id].append({"role": "user", "content": f"[Form:{specialty}] (structured submission)"})
        chat_sessions[session_id].append({"role": "assistant", "content": "".join(acc)})

    return Response(stream_with_context(gen()), content_type="text/plain")

# -------------------------------------------------------------------
# WebRTC transcription intent SDP exchange (single canonical endpoint)
# -------------------------------------------------------------------
@app.post("/api/rtc-transcribe-connect")
def rtc_transcribe_connect():
    offer_sdp = request.get_data()
    if not offer_sdp:
        return Response(b"No SDP provided", status=400, mimetype="text/plain")

    # 1) Create ephemeral transcription session
    session_payload = {
        "input_audio_transcription": {"model": "gpt-4o-transcribe"},
        "turn_detection": {"type": "server_vad","threshold": 0.5,"prefix_padding_ms": 300,"silence_duration_ms": 500},
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
        return Response(b"Missing client_secret", status=502, mimetype="text/plain")

    # 2) Exchange SDP with Realtime endpoint using ephemeral secret
    sdp_headers = {
        "Authorization": f"Bearer {client_secret}",
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
        "Cache-Control": "no-cache",
    }
    try:
        ans = requests.post(
            f"{OAI_BASE}/realtime",
            params={"intent": "transcription"},
            headers=sdp_headers,
            data=offer_sdp,
            timeout=30
        )
    except Exception as e:
        log.exception("SDP exchange error")
        return Response(f"SDP exchange error: {e}".encode(), status=502, mimetype="text/plain")
    if not ans.ok:
        return Response(ans.content or b"SDP exchange failed",
                        status=ans.status_code,
                        mimetype=ans.headers.get("Content-Type", "text/plain"))
    answer_bytes = ans.content or b""
    if not answer_bytes.startswith(b"v="):
        return Response(answer_bytes, status=502, mimetype="text/plain")
    resp = Response(answer_bytes, status=200, mimetype="application/sdp")
    resp.headers["Content-Disposition"] = "inline; filename=answer.sdp"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# -------------------------------------------------------------------
# Notes: structure from transcript (stream) + second opinion (stream)
# -------------------------------------------------------------------
def _openai_chat_stream(messages, model=os.environ.get("STRUCTURE_MODEL","gpt-4o-mini"), temperature=0.2, timeout=180):
    url = f"{OAI_BASE}/chat/completions"
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    payload = {"model": model, "temperature": temperature, "stream": True, "messages": messages}
    with requests.post(url, headers=headers, data=json.dumps(payload), stream=True, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if not line: continue
            if line.startswith("data: "):
                data = line[len("data: "):]
                if data == "[DONE]": break
                try:
                    delta = json.loads(data)
                    chunk = delta.get("choices", [{}])[0].get("delta", {}).get("content")
                    if chunk: yield chunk
                except Exception:
                    continue

@app.post("/api/notes-structure-stream")
def notes_structure_stream():
    data = request.get_json() or {}
    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return Response("No transcript provided", status=400, mimetype="text/plain")
    system = (
        "You are a clinical scribe. Convert dialogue into succinct clinical notes in Markdown with THESE headings:\n"
        "## Reason for Visit\n## History of Present Illness\n## Past Medical History\n## Medications\n## Allergies\n"
        "## Physical Examination\n## Labs & Imaging (available)\n## Recommended Tests & Investigations\n## Assessment & Plan\n"
        "- Use short, factual bullet points; write '—' if unknown."
    )
    user = f"Dialogue transcript (may be partial):\n\n{transcript}"

    def gen():
        yield ""
        for chunk in _openai_chat_stream(
            messages=[{"role":"system","content":system},{"role":"user","content":user}],
            model=os.environ.get("STRUCTURE_MODEL","gpt-4o-mini"), temperature=0.1
        ):
            yield chunk
    return Response(gen(), mimetype="text/plain")

@app.post("/api/notes-second-opinion-stream")
def notes_second_opinion_stream():
    data = request.get_json() or {}
    note_md = (data.get("note_markdown") or "").strip()
    if not note_md:
        return Response("No note provided", status=400, mimetype="text/plain")
    system = (
        "You are a senior clinician generating a concise second opinion.\n"
        "Provide:\n### Differential Diagnoses (ranked)\n### Red Flags\n### Recommended Next Steps\n### Patient-Friendly Summary\n"
        "Bullet points only."
    )
    def gen():
        yield ""
        for chunk in _openai_chat_stream(
            messages=[{"role":"system","content":system},{"role":"user","content": f"Clinical note:\n\n{note_md}"}],
            model=os.environ.get("SECOND_OPINION_MODEL","gpt-4o-mini"), temperature=0.2
        ):
            yield chunk
    return Response(gen(), mimetype="text/plain")

# -------------------------------------------------------------------
# OCR endpoints (single function, two routes) + helpers
# -------------------------------------------------------------------
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

ALLOWED_EXTS = {"pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif", "heic", "heif"}
REJECTED_PREFIXES = ("video/", "audio/")

def _guess_mimetype(filename: str, fallback: str = None) -> str:
    ext = (os.path.splitext(filename)[1] or "").lower()
    if not ext:
        return fallback or "application/octet-stream"
    mime, _ = mimetypes.guess_type(filename)
    return mime or fallback or "application/octet-stream"

def _post_ocr_space(file_storage, filename, ext, language, overlay, engine, is_table=None, scale=None, detect_orientation=None):
    forced_name = secure_filename(filename or f"upload.{ext or 'bin'}")
    forced_mime = file_storage.mimetype or _guess_mimetype(forced_name, "application/octet-stream")
    data = {
        "apikey": OCR_SPACE_API_KEY,
        "language": language,
        "isOverlayRequired": overlay,
        "OCREngine": engine,
    }
    if is_table is not None: data["isTable"] = is_table
    if scale is not None: data["scale"] = scale
    if detect_orientation is not None: data["detectOrientation"] = detect_orientation

    resp = requests.post(
        "https://api.ocr.space/parse/image",
        files={"file": (forced_name, file_storage.stream, forced_mime)},
        data=data,
        timeout=180,
        headers={"Accept": "application/json"},
    )
    try:
        result = resp.json()
    except ValueError:
        snippet = (resp.text or "").strip()[:300]
        raise RuntimeError(
            f"OCR provider returned non-JSON (status {resp.status_code}, ct {resp.headers.get('Content-Type','')}). "
            f"Snippet: {snippet}"
        )
    return result, forced_mime

def _aggregate_parsed_text(result_json):
    if result_json.get("IsErroredOnProcessing") or "ParsedResults" not in result_json:
        return None, 0
    pages = result_json.get("ParsedResults") or []
    texts = []
    for p in pages:
        t = (p or {}).get("ParsedText", "")
        if t: texts.append(t)
    return ("\n\n".join(texts).strip(), len(pages))

@app.route("/ocr", methods=["POST"])
@app.route("/api/ocr", methods=["POST"])
def ocr_from_image():
    if not OCR_SPACE_API_KEY:
        return jsonify({"error": "OCR_SPACE_API_KEY is not configured"}), 500

    session_id = (
        (request.form.get("session_id") or "").strip()
        or (request.headers.get("X-Session-Id") or "").strip()
        or str(uuid4())
    )
    attach_flag = (request.form.get("attach", "true").strip().lower() != "false")
    attach_role = (request.form.get("role") or "user").strip().lower()
    if attach_role not in ("user", "assistant"): attach_role = "user"
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

    f = request.files.get("image") or request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded. Use form field 'image' or 'file'."}), 400

    filename = secure_filename(f.filename or "upload")
    ext = (os.path.splitext(filename)[1].lstrip(".") or "").lower()

    if f.mimetype and f.mimetype.startswith(REJECTED_PREFIXES):
        return jsonify({"error": "Video/audio files are not supported by OCR."}), 400

    looks_image_or_pdf = ((f.mimetype or "").startswith("image/") or (f.mimetype == "application/pdf"))
    if ext and ext not in ALLOWED_EXTS and not looks_image_or_pdf:
        return jsonify({"error": "Unsupported file type. Only PDF or images are supported.", "allowed": sorted(ALLOWED_EXTS)}), 400

    if request.content_length and request.content_length > MAX_BYTES:
        return jsonify({"error": f"File too large for server cap (> {MAX_BYTES // (1024 * 1024)}MB)."}), 413

    provider_limit = PROVIDER_LIMIT_MB * 1024 * 1024
    if request.content_length and request.content_length > provider_limit:
        return jsonify({
            "error": f"File exceeds your OCR plan limit ({PROVIDER_LIMIT_MB}MB). "
                     "Please compress the file or upgrade your OCR plan."
        }), 413

    language = request.form.get("language", "eng")
    overlay  = request.form.get("overlay", "false")
    engine   = request.form.get("engine", "2")
    is_table = request.form.get("isTable")
    scale    = request.form.get("scale")
    detect_orientation = request.form.get("detectOrientation")

    try:
        result, forced_mime = _post_ocr_space(
            f, filename, ext, language, overlay, engine,
            is_table=is_table, scale=scale, detect_orientation=detect_orientation
        )
    except requests.exceptions.RequestException as e:
        log.exception("OCR provider network error")
        return jsonify({"error": "OCR request failed", "detail": str(e)}), 502
    except RuntimeError as e:
        log.error("OCR provider returned non-JSON/HTML error: %s", e)
        return jsonify({"error": str(e)}), 502

    text, pages = _aggregate_parsed_text(result)
    if text is None:
        return jsonify({
            "error": "OCR failed",
            "message": result.get("ErrorMessage", "No detailed message"),
            "details": result
        }), 400
    if not text:
        return jsonify({"error": "OCR succeeded but returned no text", "provider": result}), 502

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
            f"- Mimetype: {forced_mime}\n---\n"
        )
        content = text
        if len(content) > max_chars_req:
            content = content[:max_chars_req]
            truncated = True
        message_text = header + content + ("\n[...truncated...]" if truncated else "")
        chat_sessions[session_id].append({"role": attach_role, "content": message_text})
        attached = True
        chars_saved = len(content)

    return jsonify({
        "text": text,
        "meta": {"filename": filename, "mimetype": forced_mime, "pages": pages, "language": language, "engine": engine},
        "session_id": session_id,
        "attached": attached,
        "chars_saved": chars_saved,
        "truncated": truncated
    }), 200

# -------------------------------------------------------------------
# Labs parse/classify
# -------------------------------------------------------------------
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
    for item in DEFAULT_LAB_RANGES:
        if t == item["name"] or t in item["aliases"]:
            return item["name"]
    t2 = re.sub(r"\(.*?\)$", "", t).strip()
    for item in DEFAULT_LAB_RANGES:
        if t2 == item["name"] or t2 in item["aliases"]:
            return item["name"]
    return t

def _default_range_for(name: str):
    n = _canon_name(name)
    for item in DEFAULT_LAB_RANGES:
        if item["name"] == n:
            return {"low": item["low"], "high": item["high"], "unit": item["unit"], "canonical": n}
    return None

def _to_num(x):
    if isinstance(x, (int, float)): return float(x)
    if isinstance(x, str):
        t = x.strip().replace(",", ".")
        m = re.match(r"^[-+]?\d+(?:\.\d+)?$", t)
        if m:
            try: return float(m.group(0))
            except Exception: return None
    return None

def _classify(value, low, high, band_frac=0.075):
    v = _to_num(value); lo = _to_num(low); hi = _to_num(high)
    if v is None or lo is None or hi is None or hi <= lo:
        return {"status": None, "direction": None}
    if v < lo or v > hi:
        return {"status": "abnormal", "direction": "low" if v < lo else "high"}
    band = max((hi - lo) * band_frac, 1e-9)
    if abs(v - lo) <= band or abs(v - hi) <= band:
        return {"status": "borderline", "direction": None}
    return {"status": "normal", "direction": None}

@app.post("/labs/parse")
def labs_parse():
    payload = request.get_json(silent=True) or {}
    raw_text = (payload.get("text") or "").strip()
    if not raw_text:
        return jsonify({"labs": []}), 200

    system = (
        "Extract laboratory results from text and return STRICT JSON with key 'labs' as an array. "
        "Each item: {name, value, unit, low, high}."
    )
    user = f"Text:\n{raw_text[:12000]}"
    llm_labs = []
    try:
        resp = client.chat.completions.create(
            model=os.environ.get("STRUCTURE_MODEL","gpt-4o-mini"),
            temperature=0.2,
            messages=[{"role":"system","content":system},{"role":"user","content":user}],
        )
        content = (resp.choices[0].message.content or "").strip()
        content = re.sub(r"```json|```", "", content, flags=re.I).strip()
        doc = json.loads(content) if content.startswith("{") else {}
        if isinstance(doc, dict) and isinstance(doc.get("labs"), list):
            llm_labs = doc["labs"]
    except Exception:
        llm_labs = []

    out, seen = [], set()
    for item in llm_labs:
        name = str(item.get("name") or "").strip()
        value = _to_num(item.get("value"))
        unit  = (item.get("unit") or "").strip()
        low   = _to_num(item.get("low"))
        high  = _to_num(item.get("high"))
        if not name or value is None:
            continue
        if low is None or high is None or (high is not None and low is not None and high <= low):
            d = _default_range_for(name)
            if d:
                if not unit: unit = d["unit"]
                if low is None: low = d["low"]
                if high is None: high = d["high"]
        canon = _canon_name(name)
        key = (canon, value, unit, low, high)
        if key in seen: continue
        seen.add(key)
        cls = _classify(value, low, high)
        out.append({
            "name": name, "value": value, "unit": unit,
            "low": low, "high": high, "status": cls["status"], "direction": cls["direction"]
        })

    if not out:
        lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
        rx = re.compile(
            r"^([A-Za-z][A-Za-z0-9\s\(\)\/\+\-%\.]+?)\s*[:\-]?\s*(-?\d+(?:[.,]\d+)?)\s*([A-Za-zµ%\/\^\d\.\-]*)\s*"
            r"(?:\(\s*(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?)\s*\)|"
            r"(?:ref(?:erence)?|range|normal)\s*:?[^0-9\-]*(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?)\s*)?",
            re.I
        )
        for ln in lines:
            m = rx.match(ln)
            if not m: continue
            name = m.group(1).strip()
            v    = _to_num(m.group(2))
            unit = (m.group(3) or "").strip()
            lo   = _to_num(m.group(4) or m.group(6))
            hi   = _to_num(m.group(5) or m.group(7))
            if v is None: continue
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

    filtered = []
    for r in out:
        if r.get("value") is None: continue
        if (r.get("low") is None or r.get("high") is None) and r.get("status") is None: continue
        filtered.append(r)

    return jsonify({"labs": filtered}), 200

# -------------------------------------------------------------------
# Medication parsing / canonicalization / interactions
# -------------------------------------------------------------------
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
    if not m: return None
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

@app.route("/meds/parse", methods=["POST", "OPTIONS"])
def meds_parse():
    if request.method == "OPTIONS": return ("", 204)
    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    meds = []
    for ln in _normalize_lines(text):
        m = _parse_line(ln)
        if m and m.get("name"):
            meds.append(m)
    return jsonify({"meds": meds})

# Dedicated drug RAG chain
def get_drug_context_retriever_chain():
    llm = ChatOpenAI(model=os.environ.get("DRUG_QUERY_MODEL", "gpt-4o-mini"))
    retriever = vector_store.as_retriever()
    query_prompt = ChatPromptTemplate.from_messages([
        MessagesPlaceholder("chat_history"),
        ("user", "{input}"),
        ("user", "Generate one focused query for authoritative medication/interaction sources (generic names, classes, mechanisms like CYP/UGT/P-gp, contraindications, dosing).")
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

def _rag_map_meds(meds: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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
    instruction = (
        "CANONICALIZE MEDICATION LINES.\n"
        "Return STRICT JSON ONLY as:\n"
        '{ "mapped": [ {"index": <int>, "generic": <string|null>, "strength": <string|null>, "unit": <string|null>, "form": <string|null>, "route": <string|null>, "frequency": <string|null>, "prn": <bool|null> } ... ] }\n'
        "Rules: generic = lowercase INN; do not invent values; align by 'index'; no markdown.\n\n"
        "Input lines:\n" + "\n".join(lines)
    )
    try:
        resp = conversation_rag_chain.invoke({"chat_history": [], "input": instruction})
        raw = (resp.get("answer") or "").strip()
        doc = _extract_json_dict(raw) or {}
        out = doc.get("mapped") or []
        norm = []
        for it in out:
            if not isinstance(it, dict): continue
            idx = it.get("index")
            if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(meds): continue
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
        return []

def _slugify_generic(name: str) -> str:
    if not name: return ""
    x = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    x = re.sub(r"[^a-z0-9]+", "-", x.lower()).strip("-")
    if not x:
        x = hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]
    return x

@app.post("/meds/map")
def meds_map():
    data = request.get_json(silent=True) or {}
    meds = data.get("meds") or []
    if not isinstance(meds, list):
        return jsonify({"error": "meds must be a list"}), 400
    rag = _rag_map_meds(meds)
    merged: List[Dict[str, Any]] = []
    rag_by_idx = {it["index"]: it for it in rag}

    for i, m in enumerate(meds):
        r = rag_by_idx.get(i, {})
        generic = (r.get("generic") or (m.get("name") or "").strip().lower()) or None
        rxcui = _slugify_generic(generic or (m.get("name") or ""))
        merged.append({
            "name": m.get("name"),
            "strength": r.get("strength") if r.get("strength") is not None else m.get("strength"),
            "unit": r.get("unit") if r.get("unit") is not None else m.get("unit"),
            "form": r.get("form") if r.get("form") is not None else m.get("form"),
            "route": r.get("route") if r.get("route") is not None else m.get("route"),
            "frequency": r.get("frequency") if r.get("frequency") is not None else m.get("frequency"),
            "prn": r.get("prn") if r.get("prn") is not None else bool(m.get("prn")),
            "raw": m.get("raw") or m.get("name"),
            "rxnorm": {"rxcui": rxcui or None, "name": generic or m.get("name")},
        })

    bucket: Dict[str, List[int]] = {}
    for idx, m in enumerate(merged):
        key = (m.get("rxnorm") or {}).get("rxcui") or ""
        if not key: continue
        bucket.setdefault(key, []).append(idx)
    for idxs in bucket.values():
        if len(idxs) > 1:
            for i in idxs:
                merged[i]["dup"] = True

    return jsonify({"mapped": merged}), 200

def _rag_interaction_discovery(generics: List[str]) -> dict:
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

@app.route("/meds/check", methods=["POST", "OPTIONS"])
def meds_check():
    if request.method == "OPTIONS": return ("", 204)
    data = request.get_json(silent=True) or {}
    drugs = data.get("drugs") or []
    if not drugs:
        mapped = data.get("mapped") or []
        if mapped:
            drugs = [(m.get("generic") or "").strip().lower() for m in mapped if (m.get("generic") or "").strip()]
    if not drugs:
        drugs = [(x or "").strip().lower() for x in (data.get("rxcuis") or [])]
    seen, generics = set(), []
    for d in drugs:
        d = (d or "").strip().lower()
        if d and d not in seen:
            seen.add(d); generics.append(d)
    return jsonify(_rag_interaction_discovery(generics))

@app.route("/meds/analyze-stream", methods=["POST", "OPTIONS"])
def meds_analyze_stream():
    if request.method == "OPTIONS": return ("", 204)
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
    def gen():
        for chunk in re.findall(r".{1,600}", narrative_text, flags=re.S):
            yield chunk
    return Response(stream_with_context(gen()), content_type="text/plain")

# -------------------------------------------------------------------
# Error handlers (JSON-only)
# -------------------------------------------------------------------
@app.errorhandler(RequestEntityTooLarge)
def handle_413(e):
    return jsonify({"error": "File too large", "limit_mb": app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)}), 413

@app.errorhandler(HTTPException)
def handle_http_exception(e: HTTPException):
    return jsonify({"error": e.name, "code": e.code, "description": e.description}), e.code

@app.errorhandler(Exception)
def handle_uncaught(e: Exception):
    log.exception("Unhandled error")
    return jsonify({"error": "Internal server error"}), 500

# (No if __name__ == '__main__' guard is required on Render)
# ============================== Medical Vision ==============================
# In-memory caches (swap to Redis/DB in production)
VISION_CACHE = {}  # image_id -> {"data_url": str, "meta": {...}, "session_id": str}
VISION_ANALYSES = {}  # image_id -> {"summary": str, "findings": [...], "raw": str}


def _is_data_url(s: str) -> bool:
    return bool(re.match(r"^data:image\/[a-zA-Z0-9.+-]+;base64,", (s or "").strip()))


def _normalize_data_url(s: str) -> str | None:
    """
    Accepts either:
      - a full data URL: data:image/png;base64,AAAA...
      - a bare base64 string (we'll wrap as image/png data URL)
    Returns a valid data URL or None if invalid.
    """
    t = (s or "").strip()
    if not t:
        return None
    if _is_data_url(t):
        return t
    # Try bare base64
    try:
        # Validate it's base64 decodable
        base64.b64decode(t, validate=True)
        return f"data:image/png;base64,{t}"
    except Exception:
        return None


@app.route("/vision/analyze", methods=["POST", "OPTIONS"])
def vision_analyze():
    """
    Body (JSON):
      {
        "image_id": "optional stable id",
        "data_url": "data:image/png;base64,...  (or bare base64)",
        "question": "optional question or task to focus the analysis",
        "session_id": "optional"
      }

    Returns:
      {
        "image_id": "...",
        "summary": "short plain-English overview",
        "findings": ["bullet", "points"],
        "raw": "full model text",
        "cached": bool
      }
    """
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
    session_id = payload.get("session_id") or str(uuid4())
    image_id = (payload.get("image_id") or str(uuid4())).strip()
    data_url = _normalize_data_url(payload.get("data_url") or "")
    question = (payload.get("question") or "").strip()

    if not data_url:
        return jsonify({"error": "Missing or invalid data_url"}), 400

    # Cache the image (idempotent)
    VISION_CACHE[image_id] = {
        "data_url": data_url,
        "meta": {"filename": f"{image_id}.png"},
        "session_id": session_id,
    }

    # If we already analyzed this image with the same question, return cached
    cached = VISION_ANALYSES.get(image_id)
    if cached and cached.get("question") == question:
        return jsonify({
            "image_id": image_id,
            "summary": cached.get("summary"),
            "findings": cached.get("findings") or [],
            "raw": cached.get("raw"),
            "cached": True
        }), 200

    # Build a careful prompt
    system_prompt = (
        "You are a clinical vision assistant. Analyze the image and return:\n"
        "1) A 1–2 sentence concise summary.\n"
        "2) 5–10 specific findings as short bullets.\n"
        "Use plain English. If uncertain, say so."
    )
    if question:
        system_prompt += f"\nFocus on: {question}"

    # OpenAI Vision call (gpt-4o family)
    try:
        msg = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": question or "Analyze this image clinically."},
                    {"type": "input_image", "image_url": data_url},
                ],
            },
        ]
        # Using Responses API via client.chat.completions for broad compatibility
        comp = client.chat.completions.create(
            model=os.environ.get("VISION_MODEL", "gpt-4o"),
            temperature=0.2,
            messages=msg,
        )
        raw_text = (comp.choices[0].message.content or "").strip()
    except Exception as e:
        return jsonify({"error": f"Vision analysis failed: {e}"}), 502

    # Light post-processing: split summary + findings
    summary = ""
    findings = []
    lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
    # Heuristic: first one or two lines form summary until a bullet-like line appears
    collected_summary = []
    for ln in lines:
        if re.match(r"^[\-\*\u2022]\s+", ln) or re.match(r"^\d+\.\s+", ln):
            # switch to findings mode
            break
        collected_summary.append(ln)
    if collected_summary:
        # Collapse to 1–2 sentences
        summary = re.sub(r"\s+", " ", " ".join(collected_summary))
        # Trim after ~2 sentences
        parts = re.split(r"(?<=[.!?])\s+", summary)
        summary = " ".join(parts[:2]).strip()

    # Collect bullets
    for ln in lines:
        if re.match(r"^[\-\*\u2022]\s+", ln) or re.match(r"^\d+\.\s+", ln):
            ln = re.sub(r"^[\-\*\u2022]|\d+\.\s*", "", ln).strip()
            if ln:
                findings.append(ln)

    if not summary:
        # fallback: first 1–2 lines of raw
        summary = " ".join(lines[:2]) if lines else raw_text[:200]

    VISION_ANALYSES[image_id] = {
        "summary": summary,
        "findings": findings[:10],
        "raw": raw_text,
        "question": question,
        "session_id": session_id,
    }

    return jsonify({
        "image_id": image_id,
        "summary": summary,
        "findings": findings[:10],
        "raw": raw_text,
        "cached": False
    }), 200


# ============================== Lab Agent (RTC + Suggestions) ==============================

@app.route("/lab-agent/rtc-connect", methods=["POST"])
def lab_agent_rtc_connect():
    """
    Browser sends an SDP offer (bytes). We exchange it with OpenAI Realtime
    (conversation intent) using an ephemeral client_secret, then return the SDP answer.

    NOTE: mirrors the transcription RTC flow but sets a general conversation intent.
    """
    offer_sdp = request.get_data()
    if not offer_sdp:
        return Response(b"No SDP provided", status=400, mimetype="text/plain")

    # Create a short-lived realtime session (conversation)
    session_payload = {
        # Keep transcription available so users can speak; model may ignore if unused.
        "input_audio_transcription": {"model": "gpt-4o-transcribe"},
        "turn_detection": {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500},
        "input_audio_noise_reduction": {"type": "near_field"},
        "voice": None,
        "instructions": (
            "You are LabAgent, a concise assistant for ordering and interpreting lab tests. "
            "Be specific, cautious, and evidence-aware."
        ),
    }

    try:
        sess = requests.post(
            f"{OAI_BASE}/realtime/transcription_sessions",  # using the same endpoint for ephemeral secret
            headers=COMMON_JSON_HEADERS,
            data=json.dumps(session_payload),
            timeout=20,
        )
    except Exception as e:
        log.exception("Failed to create realtime session (LabAgent)")
        return Response(f"Session error: {e}".encode(), status=502, mimetype="text/plain")

    if not sess.ok:
        log.error("LabAgent session create failed (%s): %s", sess.status_code, sess.text)
        return Response(sess.content or b"Failed to create session", status=sess.status_code, mimetype="text/plain")

    client_secret = (sess.json().get("client_secret") or {}).get("value")
    if not client_secret:
        return Response(b"Missing client_secret", status=502, mimetype="text/plain")

    sdp_headers = {
        "Authorization": f"Bearer {client_secret}",
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
        "Cache-Control": "no-cache",
    }

    try:
        ans = requests.post(
            f"{OAI_BASE}/realtime",
            params={"intent": "conversation"},
            headers=sdp_headers,
            data=offer_sdp,
            timeout=30,
        )
    except Exception as e:
        log.exception("SDP exchange error (LabAgent)")
        return Response(f"SDP exchange error: {e}".encode(), status=502, mimetype="text/plain")

    if not ans.ok:
        return Response(ans.content or b"SDP exchange failed", status=ans.status_code,
                        mimetype=ans.headers.get("Content-Type", "text/plain"))

    answer_bytes = ans.content or b""
    if not answer_bytes.startswith(b"v="):
        # Not SDP; surface body for debugging
        return Response(answer_bytes, status=502, mimetype="text/plain")

    resp = Response(answer_bytes, status=200, mimetype="application/sdp")
    resp.headers["Content-Disposition"] = "inline; filename=answer.sdp"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/lab-agent/suggest-stream", methods=["POST", "OPTIONS"])
def lab_agent_suggest_stream():
    """
    Body:
      {
        "session_id": "optional",
        "complaint": "e.g., fatigue, weight loss...",
        "history": "free text",
        "exam": "free text",
        "known_conditions": ["diabetes", "CKD"]  (optional)
      }

    Streams a concise Markdown with:
      - Initial Lab Panel
      - Consider Adding
      - Rationale (brief)
      - One Follow-up Question
    """
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id") or str(uuid4())

    def bullets_from(key: str) -> str:
        v = data.get(key)
        if not v:
            return ""
        if isinstance(v, list):
            return ", ".join(str(x) for x in v)
        return str(v)

    complaint = (data.get("complaint") or "").strip()
    hx = (data.get("history") or "").strip()
    exam = (data.get("exam") or "").strip()
    conds = bullets_from("known_conditions")

    instruction = (
        "ROLE: LabAgent (concise, evidence-aware).\n"
        "OUTPUT STRICTLY IN MARKDOWN with EXACT sections:\n"
        "## Initial Lab Panel\n"
        "## Consider Adding\n"
        "## Rationale\n"
        "## Follow-up Question (one line)\n"
        "Rules:\n"
        "- Use short bullets.\n"
        "- If information is insufficient, ask for one targeted clarification.\n"
        "- English only. No JSON, no code blocks other than Markdown.\n"
        f"\n### Presenting Complaint\n- {complaint or 'Unknown'}"
        f"\n### History\n{hx or '- Unknown'}"
        f"\n### Examination\n{exam or '- Unknown'}"
        f"\n### Known Conditions\n- {conds or 'None'}\n"
    )

    if session_id not in chat_sessions:
        chat_sessions[session_id] = []

    def generate():
        acc = ""
        try:
            for chunk in conversation_rag_chain.stream(
                {"chat_history": chat_sessions[session_id], "input": instruction}
            ):
                token = chunk.get("answer", "")
                acc += token
                yield token
        except Exception as e:
            yield f"\n[Vector error: {str(e)}]"

        chat_sessions[session_id].append({"role": "user", "content": f"[LabAgent] {complaint or 'No complaint'}"})
        chat_sessions[session_id].append({"role": "assistant", "content": acc})

    return Response(stream_with_context(generate()), content_type="text/plain")


# ============================== END OF FILE ==============================
# (No if __name__ == '__main__' needed for Render/Gunicorn)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
