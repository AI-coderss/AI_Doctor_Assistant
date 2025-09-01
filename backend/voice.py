from flask import Flask, request, Response, jsonify
from flask_cors import CORS
import requests
import os
import json
import logging
from dotenv import load_dotenv
from langchain_openai import OpenAIEmbeddings
from langchain_qdrant import Qdrant
import qdrant_client
from prompts.system_prompt import SYSTEM_PROMPT

# Load environment variables from .env
load_dotenv()

app = Flask(__name__)

CORS(app, resources={
    r"/api/*": {
        "origins": "https://dsahdoctoraiassistantbot.onrender.com",
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Session-Id"]
    }
})

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY not set.")
    raise EnvironmentError("OPENAI_API_KEY environment variable not set.")

OPENAI_SESSION_URL = "https://api.openai.com/v1/realtime/sessions"
OPENAI_API_URL = "https://api.openai.com/v1/realtime"
MODEL_ID = "gpt-4o-realtime-preview-2024-12-17"
VOICE = "ballad"
DEFAULT_INSTRUCTIONS = SYSTEM_PROMPT

# ==========================
# Vector store (RAG)
# ==========================
def get_vector_store():
    client = qdrant_client.QdrantClient(
        url=os.getenv("QDRANT_HOST"),
        api_key=os.getenv("QDRANT_API_KEY"),
    )
    embeddings = OpenAIEmbeddings()
    vector_store = Qdrant(
        client=client,
        collection_name=os.getenv("QDRANT_COLLECTION_NAME"),
        embeddings=embeddings,
    )
    return vector_store

vector_store = get_vector_store()

# ==========================
# Session-scoped context
# ==========================
SESSION_CONTEXTS = {}  # { session_id: { "transcript": str, "metadata": dict } }

def build_context_instructions(transcript: str, k: int = 3) -> str:
    """
    Create an instruction suffix that includes the latest transcript (English)
    and short RAG snippets to prime the Realtime session at start.
    """
    transcript = (transcript or "").strip()
    if not transcript:
        return ""

    # RAG: pull a few short, high-signal snippets
    snippets = []
    try:
        results = vector_store.similarity_search_with_score(transcript, k=k)
        for doc, score in results:
            text = (doc.page_content or "").strip().replace("\n", " ")
            if text:
                # Trim long snippets for instructions
                if len(text) > 500:
                    text = text[:500] + "…"
                snippets.append(f"- {text}")
    except Exception as e:
        logger.warning(f"RAG error during build_context_instructions: {e}")

    rag_block = "\n".join(snippets) if snippets else "• No high-confidence context retrieved."

    # Concise, English-only case handoff
    suffix = f"""
---
### Current Case Transcript (English only)
{transcript}

### Retrieved Context (short snippets)
{rag_block}

### Behavior
- Treat the transcript as the user's latest input context.
- Start the discussion immediately about the case using concise medical reasoning.
- Keep answers in English and structured when appropriate (Diagnosis, Differential, Labs/Investigations, Treatment Plan, Doctor Recommendations, Pathway with Mermaid).
- Be precise, evidence-informed, and clinically helpful.
---
"""
    return suffix

@app.route('/')
def home():
    return "Flask API is running!"

# =========================================
# NEW: store transcript per session
# =========================================
@app.route('/api/session-context', methods=['POST'])
def set_session_context():
    """
    Body: { "session_id": "...", "transcript": "...", "metadata": {... optional ...} }
    """
    try:
        data = request.get_json(force=True, silent=False) or {}
        session_id = data.get("session_id")
        transcript = (data.get("transcript") or "").strip()
        metadata = data.get("metadata") or {}

        if not session_id:
            return jsonify({"error": "session_id is required"}), 400
        if not transcript:
            return jsonify({"error": "transcript is required"}), 400

        SESSION_CONTEXTS[session_id] = {
            "transcript": transcript,
            "metadata": metadata
        }
        return jsonify({"ok": True})
    except Exception as e:
        logger.exception("Failed to set session context")
        return jsonify({"error": str(e)}), 500

# =========================================
# Realtime connect (augmented with context)
# =========================================
@app.route('/api/rtc-connect', methods=['POST'])
def connect_rtc():
    try:
        client_sdp = request.get_data(as_text=True)
        if not client_sdp:
            return Response("No SDP provided", status=400)

        # Read session_id from query or header
        session_id = request.args.get("session_id") or request.headers.get("X-Session-Id")
        extra_instructions = ""
        if session_id and session_id in SESSION_CONTEXTS:
            transcript = SESSION_CONTEXTS[session_id].get("transcript", "")
            extra_instructions = build_context_instructions(transcript)

        # Step 1: Create Realtime session + merged instructions
        merged_instructions = DEFAULT_INSTRUCTIONS
        if extra_instructions:
            merged_instructions = f"{DEFAULT_INSTRUCTIONS}\n{extra_instructions}"

        session_payload = {
            "model": MODEL_ID,
            "voice": VOICE,
            "instructions": merged_instructions
        }
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json"
        }
        session_resp = requests.post(OPENAI_SESSION_URL, headers=headers, json=session_payload)
        if not session_resp.ok:
            logger.error(f"Session create failed: {session_resp.text}")
            return Response("Failed to create realtime session", status=500)

        token_data = session_resp.json()
        ephemeral_token = token_data.get("client_secret", {}).get("value")
        if not ephemeral_token:
            logger.error("Ephemeral token missing")
            return Response("Missing ephemeral token", status=500)

        # Step 2: SDP exchange
        sdp_headers = {
            "Authorization": f"Bearer {ephemeral_token}",
            "Content-Type": "application/sdp"
        }
        sdp_resp = requests.post(
            OPENAI_API_URL,
            headers=sdp_headers,
            params={
                "model": MODEL_ID,
                "voice": VOICE
                # Instructions already set in the session
            },
            data=client_sdp
        )
        if not sdp_resp.ok:
            logger.error(f"SDP exchange failed: {sdp_resp.text}")
            return Response("SDP exchange error", status=500)

        return Response(sdp_resp.content, status=200, mimetype='application/sdp')

    except Exception as e:
        logger.exception("RTC connection error")
        return Response(f"Error: {e}", status=500)

# =========================================
# Existing light RAG search (unchanged)
# =========================================
@app.route('/api/search', methods=['POST'])
def search():
    try:
        query = request.json.get('query')
        if not query:
            return jsonify({"error": "No query provided"}), 400

        logger.info(f"Searching for: {query}")
        results = vector_store.similarity_search_with_score(query, k=3)

        formatted = [{
            "content": doc.page_content,
            "metadata": doc.metadata,
            "relevance_score": float(score)
        } for doc, score in results]

        return jsonify({"results": formatted})

    except Exception as e:
        logger.error(f"Search error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=8813)
