import os, json, base64, logging, uuid
from typing import Dict, List
from flask import Flask, request, jsonify
from flask_cors import CORS
from google.cloud import aiplatform
from google.protobuf import json_format
from google.protobuf.struct_pb2 import Value
import requests
from dotenv import load_dotenv

# ============== Env & logging ==============
load_dotenv()
PROJECT_ID  = os.environ["PROJECT_ID"]
LOCATION    = os.environ.get("LOCATION", "us-central1")
ENDPOINT_ID = os.environ["ENDPOINT_ID"]

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("medgemma-backend")

# ============== Vertex client ==============
client = aiplatform.gapic.PredictionServiceClient(
    client_options={"api_endpoint": f"{LOCATION}-aiplatform.googleapis.com"}
)
endpoint_path = client.endpoint_path(PROJECT_ID, LOCATION, ENDPOINT_ID)

# ============== Flask app ==================
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
# In-memory sessions: { session_id: {image_b64, mime, modality, body_region, report_json, history:[...] } }
SESSIONS: Dict[str, Dict] = {}

# ============== Prompt templates ===========
BASE_SCHEMA = {
  "indication": "",
  "technique": "",
  "findings": [{"system":"thorax|derm|ophtho|path|other", "detail":""}],
  "impression": [{"statement":"", "priority":"high|medium|low"}],
  "follow_up": [{"recommendation":"", "urgency_hours":0}],
  "limitations": ""
}

SYSTEM_REPORT = """You are a medical imaging report assistant for {modality}.
Return ONLY valid minified JSON using this schema exactly:
{schema}
Rules:
- Be concise, neutral, evidence-based.
- Cite visible visual evidence (e.g., "right upper lobe opacity").
- No clinical advice, no markdown, no extra text—JSON only.
"""

SYSTEM_CHAT = """You are a medical imaging assistant continuing a discussion about ONE image and a prior auto-generated report.
Answer the user's follow-up question directly and concisely. Reference findings/impression when helpful.
Do NOT provide clinical advice or treatment plans. If unsure, say so."""

def system_report_prompt(modality:str)->str:
    return SYSTEM_REPORT.format(
        modality=modality,
        schema=json.dumps(BASE_SCHEMA, separators=(",",":"))
    )

def image_to_b64_from_url(url: str) -> str:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return base64.b64encode(r.content).decode("utf-8")

def image_to_b64_from_fs(fs) -> str:
    return base64.b64encode(fs.read()).decode("utf-8")

def predict(instance: Dict) -> str:
    value = json_format.Parse(json.dumps(instance), Value())
    resp = client.predict(endpoint=endpoint_path, instances=[value])
    pred = resp.predictions[0]
    if isinstance(pred, dict) and "content" in pred:
        return pred["content"]
    return pred if isinstance(pred, str) else json.dumps(pred)

def parse_json_or_wrap(text: str):
    try:
        return json.loads(text)
    except Exception:
        return {"raw_text": text}

def build_gen_instance(prompt:str, img_b64:str, mime:str, max_t=1200, temp=0.2, top_p=0.95):
    return {
        "prompt": prompt,
        "images": [{"mimeType": mime, "bytesBase64Encoded": img_b64}],
        "maxTokens": max_t,
        "temperature": temp,
        "topP": top_p
    }

# ============== Routes =====================

@app.get("/health")
def health():
    return jsonify({"status":"ok","project":PROJECT_ID,"region":LOCATION,"endpoint_id":ENDPOINT_ID})

@app.post("/api/medimg/analyze")
def analyze():
    """
    multipart/form-data:
      - image (file), optional: modality, body_region, notes
    or JSON:
      - image_url (string), optional: modality, body_region, notes
    """
    try:
        modality = (request.form.get("modality") or (request.json or {}).get("modality") or "radiology").lower()
        body_region = (request.form.get("body_region") or (request.json or {}).get("body_region") or "chest").lower()
        notes = (request.form.get("notes") or (request.json or {}).get("notes") or "").strip()

        mime = "image/png"
        if "image" in request.files:
            img_file = request.files["image"]
            mime = img_file.mimetype or mime
            img_b64 = image_to_b64_from_fs(img_file)
        else:
            body = request.get_json(silent=True) or {}
            url = body.get("image_url")
            if not url:
                return jsonify({"error":"Provide multipart 'image' file or JSON {'image_url': ...}"}), 400
            url_l = url.lower()
            if url_l.endswith(".jpg") or url_l.endswith(".jpeg"): mime = "image/jpeg"
            img_b64 = image_to_b64_from_url(url)

        # Build report prompt
        sys_prompt = system_report_prompt(modality)
        clin = f"Clinical notes: {notes}" if notes else "Clinical notes: (none)"
        full_prompt = f"{sys_prompt}\n{clin}\nRegion: {body_region}\nJSON only."
        instance = build_gen_instance(full_prompt, img_b64, mime)

        text = predict(instance)
        report = parse_json_or_wrap(text)

        # Create session
        sid = uuid.uuid4().hex
        SESSIONS[sid] = {
            "image_b64": img_b64,
            "mime": mime,
            "modality": modality,
            "body_region": body_region,
            "report_json": report,
            "history": []  # will store [{"role":"user","text":...},{"role":"assistant","text":...}]
        }

        return jsonify({
            "session_id": sid,
            "result": report,
            "meta": {
                "modality": modality,
                "bodyRegion": body_region,
                "modelVersion": "google/medgemma-4b-it",
            }
        })
    except requests.HTTPError as e:
        log.exception("Image fetch failed")
        return jsonify({"error":"Failed to fetch image_url","details":str(e)}), 400
    except Exception as e:
        log.exception("Analyze failed")
        return jsonify({"error":"Internal error","details":str(e)}), 500

@app.post("/api/medimg/chat")
def chat():
    """
    JSON: { session_id: string, text: string }
    Uses stored image + prior report and minimal chat history to answer follow-up questions.
    """
    try:
        body = request.get_json(force=True)
        sid = body.get("session_id")
        user_text = (body.get("text") or "").strip()
        if not sid or not user_text:
            return jsonify({"error":"Provide 'session_id' and 'text'"}), 400
        sess = SESSIONS.get(sid)
        if not sess:
            return jsonify({"error":"Unknown session_id"}), 404

        # Compose a single-turn prompt that includes prior context (since Basic endpoint is stateless).
        context = json.dumps(sess["report_json"], separators=(",",":"))
        history_lines = []
        for m in sess["history"][-6:]:  # keep last 3 Q/A pairs
            history_lines.append(f"{m['role'].capitalize()}: {m['text']}")
        history_text = "\n".join(history_lines)

        prompt = (
            f"{SYSTEM_CHAT}\n\n"
            f"Modality: {sess['modality']}; Region: {sess['body_region']}\n"
            f"Prior structured report JSON:\n{context}\n\n"
            f"{history_text}\n"
            f"User: {user_text}\nAssistant:"
        )

        instance = build_gen_instance(prompt, sess["image_b64"], sess["mime"],
                                      max_t=800, temp=0.2, top_p=0.95)
        text = predict(instance)

        # Record history
        sess["history"].append({"role":"user","text":user_text})
        sess["history"].append({"role":"assistant","text":text})

        return jsonify({"session_id": sid, "answer": text})
    except Exception as e:
        log.exception("Chat failed")
        return jsonify({"error":"Internal error","details":str(e)}), 500

if __name__ == "__main__":
    # For production run behind gunicorn, debug only locally:
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
