# voice.py — Realtime + Function-Calling contract for LabVoiceAgent & HelperAgent
from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS
import requests
import os
import json
import logging
from dotenv import load_dotenv

# ===== Optional RAG bits (kept from your original) =====
from langchain_openai import OpenAIEmbeddings
from langchain_qdrant import Qdrant
import qdrant_client

# ===== Boot =====
load_dotenv()
app = Flask(__name__)

CORS(app, resources={
    r"/api/*": {
        "origins": ["https://ai-doctor-assistant-app-dev.onrender.com", "http://localhost:3000"],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Session-Id"]
    },
    r"/lab-agent/*": {
        "origins": ["https://ai-doctor-assistant-app-dev.onrender.com", "http://localhost:3000"],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Session-Id"]
    },
    r"/helper-agent/*": {
        "origins": ["https://ai-doctor-assistant-app-dev.onrender.com", "http://localhost:3000"],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Session-Id"]
    },
})

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise EnvironmentError("OPENAI_API_KEY not set")

OPENAI_SESSION_URL = "https://api.openai.com/v1/realtime/sessions"
OPENAI_API_URL     = "https://api.openai.com/v1/realtime"
CHAT_API_URL       = "https://api.openai.com/v1/chat/completions"

# Realtime config
MODEL_ID = "gpt-4o-realtime-preview-2024-12-17"
VOICE    = "ballad"  # client can override to "alloy" via session.update

# Your global system prompt
from prompts.system_prompt import SYSTEM_PROMPT as DEFAULT_INSTRUCTIONS

# ===== RAG store (unchanged) =====
def get_vector_store():
    try:
        client = qdrant_client.QdrantClient(
            url=os.getenv("QDRANT_HOST"),
            api_key=os.getenv("QDRANT_API_KEY"),
        )
        embeddings = OpenAIEmbeddings()
        return Qdrant(
            client=client,
            collection_name=os.getenv("QDRANT_COLLECTION_NAME"),
            embeddings=embeddings,
        )
    except Exception as e:
        logger.warning(f"RAG init failed: {e}")
        return None

vector_store = get_vector_store()

# ===== Session-scoped context =====
SESSION_CONTEXTS = {}  # generic transcript
LAB_CONTEXTS     = {}  # lab agent context
HELPER_CONTEXTS  = {}  # helper agent context
CLINICAL_NOTES_DB = {}

# ===== Helper fns =====
def _rag_snippets(query: str, k: int = 3) -> str:
    if not query or not vector_store:
        return ""
    try:
        results = vector_store.similarity_search_with_score(query, k=k)
        lines = []
        for doc, score in results:
            t = (doc.page_content or "").strip().replace("\n", " ")
            if not t:
                continue
            if len(t) > 600:
                t = t[:600] + "…"
            lines.append(f"- {t}")
        return "\n".join(lines)
    except Exception as e:
        logger.warning(f"RAG error: {e}")
        return ""

def build_context_instructions(transcript: str, k: int = 3) -> str:
    transcript = (transcript or "").strip()
    if not transcript:
        return ""
    rag_block = _rag_snippets(transcript, k) or "• No high-confidence context retrieved."
    return f"""
---
### Current Case Transcript (English only)
{transcript}

### Retrieved Context (short snippets)
{rag_block}

### Behavior
- Treat the transcript as the user's latest input context.
- Start the discussion immediately about the case using concise medical reasoning.
- Keep answers in English and structured (Diagnosis, Differential, Labs/Investigations, Treatment Plan, Doctor Recommendations, Pathway with Mermaid).
- Be precise, evidence-informed, and clinically helpful.
---
""".strip()

def _create_realtime_session(merged_instructions: str) -> str:
    """
    Create a Realtime session and return an ephemeral client_secret value.
    Tools are registered later by the browser via datachannel session.update.
    """
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": MODEL_ID,
        "voice": VOICE,
        "instructions": merged_instructions or DEFAULT_INSTRUCTIONS
        # (You *can* also pass 'turn_detection' or 'tools' here if you want the server to own it.)
    }
    r = requests.post(OPENAI_SESSION_URL, headers=headers, json=payload, timeout=30)
    if not r.ok:
        logger.error(f"Realtime session create failed: {r.text}")
        return ""
    data = r.json()
    return data.get("client_secret", {}).get("value", "")

def _exchange_sdp(ephemeral_token: str, client_sdp: str) -> requests.Response:
    """
    Complete the SDP exchange. After this, the browser talks directly to OpenAI
    over WebRTC (audio + datachannel). Function calls are delivered over that
    datachannel and executed client-side.
    """
    headers = {"Authorization": f"Bearer {ephemeral_token}", "Content-Type": "application/sdp"}
    return requests.post(
        OPENAI_API_URL,
        headers=headers,
        params={"model": MODEL_ID, "voice": VOICE},
        data=client_sdp,
        timeout=60
    )

# ===== Health =====
@app.route("/")
def home():
    return "Flask API is running!"

# ===== Generic transcript (unchanged) =====
@app.route("/api/session-context", methods=["POST"])
def set_session_context():
    data = request.get_json(force=True, silent=False) or {}
    sid = data.get("session_id")
    transcript = (data.get("transcript") or "").strip()
    metadata = data.get("metadata") or {}
    if not sid:       return jsonify({"error": "session_id is required"}), 400
    if not transcript:return jsonify({"error": "transcript is required"}), 400
    SESSION_CONTEXTS[sid] = {"transcript": transcript, "metadata": metadata}
    return jsonify({"ok": True})

# ===== Generic Realtime (kept for backward compat) =====
@app.route("/api/rtc-connect", methods=["POST"])
def connect_rtc():
    client_sdp = request.get_data(as_text=True)
    if not client_sdp:
        return Response("No SDP provided", status=400)

    sid = request.args.get("session_id") or request.headers.get("X-Session-Id")
    extra = ""
    if sid and sid in SESSION_CONTEXTS:
        extra = build_context_instructions(SESSION_CONTEXTS[sid].get("transcript", ""))

    merged = DEFAULT_INSTRUCTIONS + ("\n" + extra if extra else "")
    token = _create_realtime_session(merged)
    if not token:
        return Response("Failed to create realtime session", status=500)

    sdp_resp = _exchange_sdp(token, client_sdp)
    if not sdp_resp.ok:
        logger.error(f"SDP exchange failed: {sdp_resp.text}")
        return Response("SDP exchange error", status=500)

    return Response(sdp_resp.content, status=200, mimetype="application/sdp")

# ===== RAG quick search =====
@app.route("/api/search", methods=["POST"])
def search():
    data = request.get_json(force=True, silent=False) or {}
    query = data.get("query")
    if not query:
        return jsonify({"error": "No query provided"}), 400
    if not vector_store:
        return jsonify({"results": []})
    res = vector_store.similarity_search_with_score(query, k=3)
    out = [{
        "content": doc.page_content,
        "metadata": doc.metadata,
        "relevance_score": float(score)
    } for doc, score in res]
    return jsonify({"results": out})

# ======================================================================
# LAB AGENT (existing) — context + RTC
# ======================================================================
@app.route("/lab-agent/context", methods=["POST"])
def lab_context():
    data = request.get_json(force=True) or {}
    sid = data.get("session_id")
    ctx = (data.get("context") or "").strip()
    if not sid:
        return jsonify({"error": "session_id is required"}), 400
    LAB_CONTEXTS[sid] = {"context": ctx}
    return jsonify({"ok": True})

@app.route("/lab-agent/rtc-connect", methods=["POST"])
def lab_rtc():
    client_sdp = request.get_data(as_text=True)
    if not client_sdp:
        return Response("No SDP provided", status=400)

    sid = request.args.get("session_id") or request.headers.get("X-Session-Id")
    extra = ""
    if sid and sid in LAB_CONTEXTS:
        extra = f"""
You are a clinical lab assistant. Be concise. Confirm changes via explicit tool calls only.
Context (short):
{(LAB_CONTEXTS[sid].get('context') or '')[:1600]}
""".strip()

    merged = DEFAULT_INSTRUCTIONS + ("\n" + extra if extra else "")
    token = _create_realtime_session(merged)
    if not token:
        return Response("Failed to create realtime session", status=500)

    sdp_resp = _exchange_sdp(token, client_sdp)
    if not sdp_resp.ok:
        logger.error(f"LAB SDP exchange failed: {sdp_resp.text}")
        return Response("SDP exchange error", status=500)

    return Response(sdp_resp.content, status=200, mimetype="application/sdp")

# ======================================================================
# HELPER AGENT — function calling contract made explicit
# ======================================================================

# 1) Single source of truth for CN tools (matches HelperAgent.jsx CN_TOOLS)
CN_TOOLS = [
    {
        "name": "cn_add_section",
        "description": "Add a new section to clinical notes.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "description": "Section title"},
                "key": {"type": "string", "description": "Slug key (lowercase_with_underscores). Optional"},
                "text": {"type": "string", "description": "Default text content", "default": ""},
                "position": {"type": "string", "enum": ["before", "after", "end"], "default": "after"},
                "anchor_key": {"type": "string", "description": "Place relative to this key (required for before/after)"}
            },
            "required": ["title"]
        }
    },
    {
        "name": "cn_remove_section",
        "description": "Remove a section by key.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"key": {"type": "string"}},
            "required": ["key"]
        }
    },
    {
        "name": "cn_update_section",
        "description": "Set or append text for a section.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "key": {"type": "string"},
                "text": {"type": "string"},
                "append": {"type": "boolean", "default": False}
            },
            "required": ["key", "text"]
        }
    },
    {
        "name": "cn_rename_section",
        "description": "Rename a section (and optionally change its key).",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "key": {"type": "string"},
                "new_title": {"type": "string"},
                "new_key": {"type": "string"}
            },
            "required": ["key", "new_title"]
        }
    },
    {
        "name": "cn_apply_markdown",
        "description": "Replace entire note with a full Markdown string (SOAP or organized).",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"markdown": {"type": "string"}},
            "required": ["markdown"]
        }
    },
    {
        "name": "cn_save",
        "description": "Ask UI to approve & save current clinical notes.",
        "parameters": {"type": "object", "additionalProperties": False, "properties": {}}
    },
    {
        "name": "cn_preview",
        "description": "Open preview tab for the clinical notes.",
        "parameters": {"type": "object", "additionalProperties": False, "properties": {}}
    }
]

# 2) Helper context to prime model
@app.route("/helper-agent/context", methods=["POST"])
def helper_context():
    data = request.get_json(force=True) or {}
    sid = data.get("session_id")
    ctx = (data.get("context") or "").strip()
    if not sid:
        return jsonify({"error": "session_id is required"}), 400
    HELPER_CONTEXTS[sid] = {"context": ctx}
    return jsonify({"ok": True})

# 3) Tools schema endpoint — the browser fetches this and then sends session.update
@app.route("/helper-agent/tools", methods=["GET"])
def helper_tools():
    return jsonify({"tools": CN_TOOLS, "tool_choice": {"type": "auto"}})

# 4) WebRTC handshake for Helper Agent
@app.route("/helper-agent/rtc-connect", methods=["POST"])
def helper_rtc():
    client_sdp = request.get_data(as_text=True)
    if not client_sdp:
        return Response("No SDP provided", status=400)

    sid = request.args.get("session_id") or request.headers.get("X-Session-Id")
    extra = ""
    if sid and sid in HELPER_CONTEXTS:
        extra = HELPER_CONTEXTS[sid].get("context") or ""

    helper_instructions = f"""
You are a UI Helper Agent for editing Clinical Notes.
- Prefer function calls (tools) to modify the UI: add/remove/update/rename sections, apply markdown, save, preview.
- Be brief when speaking; do not claim UI changed unless the tool succeeded.
- If the user requests to review or export, call cn_preview or cn_save.
Short context:
{extra[:1600]}
""".strip()

    merged = DEFAULT_INSTRUCTIONS + "\n" + helper_instructions
    token = _create_realtime_session(merged)
    if not token:
        return Response("Failed to create realtime session", status=500)

    sdp_resp = _exchange_sdp(token, client_sdp)
    if not sdp_resp.ok:
        logger.error(f"HELPER SDP exchange failed: {sdp_resp.text}")
        return Response("SDP exchange error", status=500)

    return Response(sdp_resp.content, status=200, mimetype="application/sdp")

# 5) Optional audit hooks — the client can POST tool results it applied in the UI.
#    This is NOT required for function calling to work; it's for logging only.
@app.route("/helper-agent/tool-applied", methods=["POST"])
def helper_tool_applied():
    data = request.get_json(force=True) or {}
    logger.info(f"[helper-agent] tool_applied: {json.dumps(data)[:800]}")
    return jsonify({"ok": True})

# ======================================================================
# Clinical Notes API used by ClinicalNotes.jsx
# ======================================================================
def _soap_system_prompt(fmt: str = "markdown") -> str:
    if fmt == "json":
        return ("You generate concise clinical notes as strict JSON with keys: "
                "subjective, objective, assessment, plan. No markdown. No extra keys.")
    return ("You generate concise clinical notes in Markdown with sections:\n"
            "## Subjective\n## Objective\n## Assessment\n## Plan\n"
            "Use clear bullet points and clinical language.")

@app.route("/api/clinical-notes/soap-stream", methods=["POST"])
def clinical_notes_stream():
    """
    Body: { session_id, transcript, mode: 'markdown' | 'json' }
    Streams plain text chunks (NOT SSE) compatible with res.body.getReader().
    """
    data = request.get_json(force=True, silent=False) or {}
    sid   = data.get("session_id") or "default"
    text  = (data.get("transcript") or "").strip()
    mode  = (data.get("mode") or "markdown").lower()

    system = _soap_system_prompt(mode)
    rag_bits = _rag_snippets(text, k=3)

    user = (
        f"Patient transcript (English):\n{text}\n\n"
        f"Helpful context:\n{rag_bits or 'None'}\n\n"
        f"Write the clinical note in the requested format ({mode})."
    )

    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": "gpt-4o-mini",
        "stream": True,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    def sse_to_text():
        with requests.post(CHAT_API_URL, headers=headers, json=payload, stream=True, timeout=300) as r:
            r.raise_for_status()
            for line in r.iter_lines(decode_unicode=True):
                if not line:
                    continue
                if line.startswith("data: "):
                    chunk = line[len("data: "):].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        obj = json.loads(chunk)
                        delta = obj.get("choices", [{}])[0].get("delta", {}).get("content")
                        if delta:
                            yield delta
                    except Exception:
                        continue

    return Response(sse_to_text(), mimetype="text/plain")

@app.route("/api/clinical-notes/save", methods=["POST"])
def clinical_notes_save():
    data = request.get_json(force=True, silent=False) or {}
    sid = data.get("session_id") or "default"
    md  = (data.get("note_markdown") or "").strip()
    if not md:
        return jsonify({"error": "note_markdown required"}), 400
    CLINICAL_NOTES_DB[sid] = {
        "markdown": md,
        "updated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z"
    }
    return jsonify({"ok": True})

# ===== Run =====
if __name__ == "__main__":
    app.run(debug=True, port=8813)
