# ocr_routes.py
from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename
import requests, os, os.path

ocr_bp = Blueprint("ocr", __name__)

# ENV:
#   OCR_SPACE_API_KEY=your_key
#   OCR_PROVIDER_LIMIT_MB=1   (Free=1, PRO=5, PRO PDF=100+)
#   OCR_MAX_BYTES=20971520    (server request cap; default 20 MB)
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY")
PROVIDER_LIMIT_MB = int(os.getenv("OCR_PROVIDER_LIMIT_MB", "1"))
ALLOWED_EXTS = {"pdf", "png", "jpg", "jpeg", "tif", "tiff", "webp"}
MAX_BYTES = int(os.getenv("OCR_MAX_BYTES", 20 * 1024 * 1024))  # Flask cap

def _json_error(message, status=400, **extra):
    payload = {"error": message}
    if extra:
        payload.update(extra)
    return jsonify(payload), status

@ocr_bp.route("/ocr", methods=["POST"])
def ocr_from_image():
    if not OCR_SPACE_API_KEY:
        return _json_error("OCR_SPACE_API_KEY is not configured", 500)

    # Accept 'image' or 'file'
    f = request.files.get("image") or request.files.get("file")
    if not f:
        return _json_error("No image file uploaded. Use form field 'image'", 400)

    filename = secure_filename(f.filename or "upload")
    ext = (os.path.splitext(filename)[1].lstrip(".") or "png").lower()

    # MIME/extension guards
    if ext not in ALLOWED_EXTS:
        return _json_error(
            "Unsupported file type. Only PDF or images are supported.",
            400, allowed=sorted(ALLOWED_EXTS)
        )
    if f.mimetype and (f.mimetype.startswith("video/") or f.mimetype.startswith("audio/")):
        return _json_error("Video/audio files are not supported by OCR.Space.", 400)

    # Server-side request size guard (may be bypassed by proxy; see nginx note)
    if request.content_length and request.content_length > MAX_BYTES:
        return _json_error(
            f"File too large for server cap (> {MAX_BYTES // (1024*1024)}MB).",
            413, limit_mb=MAX_BYTES // (1024*1024)
        )

    # Provider plan guard (docs: Free=1MB, PRO=5MB, PRO PDF=100MB+)
    # We cannot know exact file.size reliably from Werkzeug stream without reading it,
    # so we rely on client_length (if present) + let provider enforce the rest.
    provider_limit = PROVIDER_LIMIT_MB * 1024 * 1024
    if request.content_length and request.content_length > provider_limit:
        return _json_error(
            f"File exceeds your OCR plan limit ({PROVIDER_LIMIT_MB}MB). "
            f"Compress the file or upgrade your OCR.Space plan.",
            413, provider_limit_mb=PROVIDER_LIMIT_MB
        )

    language = request.form.get("language", "eng")   # e.g., "eng", "ara"
    overlay  = request.form.get("overlay", "false")  # "true"/"false"
    engine   = request.form.get("engine", "2")       # "1" | "2"  (per docs)
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
        # Optional:
        # "isTable": True,
        # "scale": True,
        # "detectOrientation": True,
    }
    if is_table is not None: data["isTable"] = is_table
    if scale is not None: data["scale"] = scale
    if detect_orientation is not None: data["detectOrientation"] = detect_orientation

    try:
        resp = requests.post(
            "https://api.ocr.space/parse/image",
            files={"file": (forced_name, f.stream, forced_mime)},
            data=data,
            timeout=180,
            headers={"Accept": "application/json"},
        )
        text_ct = resp.headers.get("Content-Type", "")
        try:
            result = resp.json()
        except ValueError:
            snippet = (resp.text or "").strip()[:300]
            return _json_error(
                "OCR provider returned non-JSON response",
                502, provider_status=resp.status_code, provider_ct=text_ct, snippet=snippet
            )
    except requests.exceptions.RequestException as e:
        return _json_error("OCR request failed", 502, detail=str(e))

    # Success path
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
        details=result
    )
