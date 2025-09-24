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


@ocr_bp.route("/ocr", methods=["POST"])
def ocr_from_image():
    if not OCR_SPACE_API_KEY:
        return jsonify({"error": "OCR_SPACE_API_KEY is not configured"}), 500

    # Accept 'image' (preferred) or 'file' as a fallback
    f = request.files.get("image") or request.files.get("file")
    if not f:
        return jsonify({"error": "No image file uploaded", "hint": "Use form field 'image'"}), 400

    filename = secure_filename(f.filename or "upload")
    ext = (os.path.splitext(filename)[1].lstrip(".") or "png").lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({"error": "Unsupported file type", "allowed": sorted(ALLOWED_EXTS)}), 400

    # Prevent huge uploads
    if request.content_length and request.content_length > MAX_BYTES:
        return jsonify({"error": f"File too large (> {MAX_BYTES // (1024*1024)}MB)"}), 413

    # Optional passthrough tuning (defaults work well)
    language = request.form.get("language", "eng")   # e.g., "eng", "ara"
    overlay  = request.form.get("overlay", "false")  # "true"/"false"
    engine   = request.form.get("engine", "2")       # "1" | "2" | "3" (per OCR.Space)
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
        resp = requests.post(
            "https://api.ocr.space/parse/image",
            files={"file": (forced_name, f.stream, forced_mime)},
            data=data,
            timeout=180,
        )
        resp.raise_for_status()
        result = resp.json()
    except requests.exceptions.RequestException as e:
        return jsonify({"error": "OCR request failed", "detail": str(e)}), 502
    except ValueError:
        return jsonify({"error": "OCR provider returned non-JSON response"}), 502

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
            return jsonify({"error": "OCR succeeded but returned no text", "details": result}), 502

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

    # Error from provider
    return jsonify({
        "error": "OCR failed",
        "message": result.get("ErrorMessage", "No detailed message"),
        "details": result,
    }), 400
