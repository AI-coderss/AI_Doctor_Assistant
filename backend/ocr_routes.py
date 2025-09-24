# ocr_routes.py
from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename
import requests, os, os.path

ocr_bp = Blueprint("ocr", __name__)

# ENV:
#   OCR_SPACE_API_KEY=your_api_key
#   OCR_MAX_BYTES=20971520   (optional; default 20MB)
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY")
ALLOWED_EXTS = {"pdf", "png", "jpg", "jpeg", "tif", "tiff", "webp"}
MAX_BYTES = int(os.getenv("OCR_MAX_BYTES", 20 * 1024 * 1024))  # 20MB

def _json_error(message, status=400, **extra):
  payload = {"error": message}
  if extra:
    payload.update(extra)
  return jsonify(payload), status

@ocr_bp.route("/ocr", methods=["POST"])
def ocr_from_image():
    if not OCR_SPACE_API_KEY:
        return _json_error("OCR_SPACE_API_KEY is not configured", 500)

    # Accept 'image' (preferred) or 'file' as a fallback
    f = request.files.get("image") or request.files.get("file")
    if not f:
        return _json_error("No image file uploaded. Use form field 'image'", 400)

    filename = secure_filename(f.filename or "upload")
    ext = (os.path.splitext(filename)[1].lstrip(".") or "png").lower()
    if ext not in ALLOWED_EXTS:
        return _json_error("Unsupported file type", 400, allowed=sorted(ALLOWED_EXTS))

    # Avoid huge uploads (proxy might still reject first; see NGINX note)
    if request.content_length and request.content_length > MAX_BYTES:
        return _json_error(f"File too large (> {MAX_BYTES // (1024*1024)}MB)", 413)

    # Tunables
    language = request.form.get("language", "eng")   # e.g., "eng", "ara"
    overlay  = request.form.get("overlay", "false")  # "true"/"false"
    engine   = request.form.get("engine", "2")       # "1"|"2"|"3"
    is_table = request.form.get("isTable")           # optional
    scale    = request.form.get("scale")             # optional
    detect_orientation = request.form.get("detectOrientation")  # optional

    forced_name = f"upload.{ext}"
    forced_mime = f.mimetype or ("application/pdf" if ext == "pdf" else "image/png")

    data = {
        "apikey": OCR_SPACE_API_KEY,
        "language": language,
        "isOverlayRequired": overlay,
        "OCREngine": engine,
    }
    if is_table is not None:
        data["isTable"] = is_table
    if scale is not None:
        data["scale"] = scale
    if detect_orientation is not None:
        data["detectOrientation"] = detect_orientation

    try:
        # NOTE: pass file stream; requests handles multipart
        resp = requests.post(
            "https://api.ocr.space/parse/image",
            files={"file": (forced_name, f.stream, forced_mime)},
            data=data,
            timeout=180,
            headers={"Accept": "application/json"},
        )
        # Some providers send 200 OK even for errors; don't assume status
        text_ct = resp.headers.get("Content-Type", "")
        # Try to read JSON either way
        try:
            result = resp.json()
        except ValueError:
            # Upstream returned non-JSON; bubble up text safely
            snippet = (resp.text or "").strip()[:300]
            return _json_error(
                "OCR provider returned non-JSON response",
                502,
                provider_status=resp.status_code,
                provider_ct=text_ct,
                snippet=snippet,
            )

    except requests.exceptions.RequestException as e:
        return _json_error("OCR request failed", 502, detail=str(e))

    # Success?
    if not result.get("IsErroredOnProcessing") and "ParsedResults" in result:
        pages = result.get("ParsedResults") or []
        texts = []
        for p in pages:
            t = (p or {}).get("ParsedText", "")
            if t:
                texts.append(t)
        parsed_text = "\n\n".join(texts).strip()

        if not parsed_text:
            return _json_error("OCR succeeded but returned no text", 502, provider=result)

        return jsonify({
            "text": parsed_text,
            "meta": {
                "filename": filename,
                "mimetype": forced_mime,
                "pages": len(pages),
                "language": language,
                "engine": engine,
            }
        })

    # Provider signaled an error
    return _json_error(
        "OCR failed",
        400,
        message=result.get("ErrorMessage", "No detailed message"),
        details=result,
    )
