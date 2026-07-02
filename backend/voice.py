# voice.py — Realtime + Function-Calling contract for LabVoiceAgent & HelperAgent
import ast
from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS
import requests
import os
import json
import logging
from uuid import uuid4
from dotenv import load_dotenv
from openai import OpenAI

# ===== Optional RAG bits =====
from langchain_openai import OpenAIEmbeddings
from langchain_qdrant import QdrantVectorStore 
import qdrant_client

# ===== Boot =====
load_dotenv()
app = Flask(__name__)

CORS(app, resources={
    r"/api/*": {"origins": "*"},
    r"/lab-agent/*": {"origins": "*"},
    r"/helper-agent/*": {"origins": "*"}
})

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise EnvironmentError("OPENAI_API_KEY not set")

# GA Endpoints
OPENAI_SESSION_URL = "https://api.openai.com/v1/realtime/client_secrets"
OPENAI_API_URL     = "https://api.openai.com/v1/realtime"
CHAT_API_URL       = "https://api.openai.com/v1/chat/completions"
oai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Realtime config
MODEL_ID = "gpt-4o-realtime-preview-2024-12-17"
VOICE    = "ballad" 

from prompts.system_prompt import SYSTEM_PROMPT as DEFAULT_INSTRUCTIONS

# ===== RAG store =====
def get_vector_store():
    try:
        client = qdrant_client.QdrantClient(
            url=os.getenv("QDRANT_HOST"),
            api_key=os.getenv("QDRANT_API_KEY"),
        )
        embeddings = OpenAIEmbeddings()
        return QdrantVectorStore(
            client=client,
            collection_name=os.getenv("QDRANT_COLLECTION_NAME"),
            embedding=embeddings,
        )
    except Exception as e:
        logger.warning(f"RAG init failed: {e}")
        return None

vector_store = get_vector_store()

# ===== Global Contexts =====
SESSION_CONTEXTS = {}
LAB_CONTEXTS     = {}
HELPER_CONTEXTS  = {}
CLINICAL_NOTES_DB = {}

# ===== Helper fns =====
def _create_realtime_session(merged_instructions: str) -> str:
    """
    Create a Realtime session and return an ephemeral client_secret value.
    """
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}", 
        "Content-Type": "application/json"
    }
    
    # FIX: Included "type": "realtime" to satisfy GA requirements
    payload = {
        "session": {
            "type": "realtime", 
            "model": MODEL_ID,
            "voice": VOICE,
            "instructions": merged_instructions or DEFAULT_INSTRUCTIONS
        }
    }
    
    r = requests.post(OPENAI_SESSION_URL, headers=headers, json=payload, timeout=30)
    if not r.ok:
        logger.error(f"Realtime session create failed: {r.text}")
        return ""
    
    data = r.json()
    return data.get("client_secret", {}).get("value", "")

def _exchange_sdp(ephemeral_token: str, client_sdp: str) -> requests.Response:
    headers = {"Authorization": f"Bearer {ephemeral_token}", "Content-Type": "application/sdp"}
    return requests.post(
        OPENAI_API_URL,
        headers=headers,
        params={"model": MODEL_ID, "voice": VOICE},
        data=client_sdp,
        timeout=60
    )

# ===== API Endpoints =====
@app.route("/api/rtc-connect", methods=["POST"])
def connect_rtc():
    client_sdp = request.get_data(as_text=True)
    sid = request.args.get("session_id") or request.headers.get("X-Session-Id")
    
    # Simple context injection
    merged = DEFAULT_INSTRUCTIONS
    token = _create_realtime_session(merged)
    
    if not token:
        return Response("Failed to create realtime session", status=500)

    sdp_resp = _exchange_sdp(token, client_sdp)
    return Response(sdp_resp.content, status=200, mimetype="application/sdp")

# ... [Keep your existing clinical-notes, lab-agent, and helper-agent routes here] ...

if __name__ == "__main__":
    app.run(debug=True, port=8813)