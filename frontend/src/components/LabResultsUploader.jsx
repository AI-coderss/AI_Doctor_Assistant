/* eslint-disable no-loop-func */
// src/components/LabResultsUploader.jsx
import React, {
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import "../styles/LabResultsUploader.css";

/**
 * IMPORTANT:
 * - Set REACT_APP_BACKEND_BASE to your Flask origin (e.g. https://your-flask-app.onrender.com)
 * - This component first tries `${BACKEND_BASE}/ocr`, and if it gets a 404, it falls back to `${BACKEND_BASE}/api/ocr`.
 * - OCR.Space plan limits (per docs): Free=1MB, PRO=5MB, PRO PDF=100MB+
 *   We expose REACT_APP_OCR_PROVIDER_MAX_MB to control the client-side limit (default 1).
 */

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const OCR_URL_PRIMARY = `${BACKEND_BASE}/ocr`;
const OCR_URL_FALLBACK = `${BACKEND_BASE}/api/ocr`;
const STREAM_URL = `${BACKEND_BASE}/stream`;

/** Target max MB based on your OCR.Space plan (default: 1 MB for Free) */
const PROVIDER_MAX_MB = 1
   // 1=Free, 5=PRO, 100=PRO PDF

const ACCEPTED = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
];
const REJECTED_PREFIXES = ["video/", "audio/"];

// ---------- Utilities ----------
function isPossiblyHtml(text) {
  const s = (text || "").slice(0, 300).toLowerCase();
  return s.includes("<!doctype") || s.includes("<html");
}

async function readJsonSafe(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    const snippet = txt.slice(0, 300).replace(/\s+/g, " ");
    const msg = isPossiblyHtml(txt)
      ? `Server returned an HTML error page (${res.status}). Snippet: ${snippet}`
      : `Unexpected non-JSON response (${res.status}). Snippet: ${snippet}`;
    const err = new Error(msg);
    err._rawText = txt;
    err._status = res.status;
    throw err;
  }
}

/** Downscale an image file (PNG/JPEG/WebP) to stay under targetMB (best effort). */
async function downscaleImageIfNeeded(file, targetMB = 1) {
  const maxBytes = targetMB * 1024 * 1024;
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= maxBytes) return file;

  // Only process images (not PDFs)
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let { width, height } = bitmap;

  // Iteratively shrink until size fits or we hit a lower bound
  let quality = 0.85;
  let blob = file;

  for (let i = 0; i < 6; i++) {
    // Scale down by ~25% each iteration if still too big
    width = Math.max(800, Math.floor(width * 0.75));
    height = Math.max(800, Math.floor(height * 0.75));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Prefer JPEG for smaller byte sizes
    const type = "image/jpeg";
    blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, type, quality)
    );
    if (!blob) break;
    if (blob.size <= maxBytes) break;
    quality = Math.max(0.5, quality - 0.1);
  }

  if (!blob) return file;
  // If still too big, return original with a warning handled upstream
  if (blob.size > maxBytes) return file;

  return new File([blob], (file.name || "image") + ".jpg", { type: "image/jpeg" });
}

const LabResultsUploader = forwardRef(function LabResultsUploader(
  {
    autoSend = true,
    ocrLanguage = "eng", // set "ara" for Arabic labs
    engine = "2",
    overlay = false,
    maxSizeMB = Math.max(PROVIDER_MAX_MB, 1), // UI hint; provider limit enforced too
    onBeforeSendToAI, // (text, meta) => string
    onAIResponse,     // (payload, { text, meta })
    onExtracted,      // (text, meta)
    onAIStreamToken,  // (tokenChunk)
  },
  ref
) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("idle"); // idle|extracting|streaming|done|error
  const [error, setError] = useState("");
  const [fileMeta, setFileMeta] = useState(null);
  const [extractedText, setExtractedText] = useState("");

  useImperativeHandle(ref, () => ({ open: () => inputRef.current?.click() }));

  const validate = (file) => {
    if (!file) return "No file selected.";
    if (REJECTED_PREFIXES.some((p) => file.type.startsWith(p))) {
      return "Video/audio files are not supported. Please upload a PDF or image.";
    }
    if (!ACCEPTED.includes(file.type) && !file.name.toLowerCase().endsWith(".pdf")) {
      return "Only PDF or image files are supported (PNG, JPG, WEBP, TIFF).";
    }
    // Provider-aware check
    if (file.size > PROVIDER_MAX_MB * 1024 * 1024 && !file.type.startsWith("image/")) {
      return `This file is larger than your plan’s limit (${PROVIDER_MAX_MB}MB). For PDFs, please compress the file or upgrade your OCR.Space plan.`;
    }
    return "";
  };

  async function postToStream(text, meta) {
    setStatus("streaming");
    const payload = { input: text, mode: "lab_results", source: meta?.filename || "unknown" };

    try {
      const res = await fetch(STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const ct = res.headers.get("content-type") || "";

      // Non-stream fallbacks
      if (!res.body || (!ct.includes("text/event-stream") && !ct.includes("application/octet-stream"))) {
        // Try JSON first; fall back to text
        let data;
        if (ct.includes("application/json")) data = await res.json();
        else data = { text: await res.text() };
        onAIResponse?.(data, { text: extractedText, meta: fileMeta });
        setStatus("done");
        return;
      }

      // Stream read (SSE/raw)
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let full = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        onAIStreamToken?.(chunk);
      }
      onAIResponse?.({ text: full }, { text: extractedText, meta: fileMeta });
      setStatus("done");
    } catch (err) {
      setError(err.message || String(err));
      setStatus("error");
    }
  }

  async function postToOcr(form) {
    // Try primary path, then fallback /api/ocr if 404 (Cannot POST /ocr)
    let res = await fetch(OCR_URL_PRIMARY, { method: "POST", body: form });
    if (res.status === 404) {
      res = await fetch(OCR_URL_FALLBACK, { method: "POST", body: form });
    }
    const data = await readJsonSafe(res); // throws on HTML
    return { res, data };
  }

  async function handleFile(file) {
    setError("");
    const err = validate(file);
    if (err) { setError(err); setStatus("error"); return; }

    // If over plan and image => try client-side downscale
    let sendFile = file;
    if (file.type.startsWith("image/") && file.size > PROVIDER_MAX_MB * 1024 * 1024) {
      try {
        sendFile = await downscaleImageIfNeeded(file, PROVIDER_MAX_MB);
        if (sendFile.size > PROVIDER_MAX_MB * 1024 * 1024) {
          setError(
            `Image remains larger than ${PROVIDER_MAX_MB}MB after compression. Please choose a smaller image or upgrade your OCR plan.`
          );
          setStatus("error");
          return;
        }
      } catch (e) {
        setError("Failed to compress image. Please upload a smaller image.");
        setStatus("error");
        return;
      }
    }

    setStatus("extracting");

    const form = new FormData();
    form.append("image", sendFile); // MUST be 'image'
    form.append("language", ocrLanguage);
    form.append("engine", engine);
    form.append("overlay", overlay ? "true" : "false");

    try {
      const { res, data } = await postToOcr(form);

      if (!res.ok) {
        const msg =
          data?.error ||
          data?.message ||
          data?.details?.ErrorMessage ||
          `OCR failed (${res.status})`;
        throw new Error(msg);
      }

      const text = data?.text || "";
      const meta = data?.meta || {
        filename: sendFile.name,
        mimetype: sendFile.type,
        size: sendFile.size,
      };

      if (!text.trim()) throw new Error("OCR returned empty text");

      setExtractedText(text);
      setFileMeta(meta);
      onExtracted?.(text, meta);

      if (!autoSend) { setStatus("done"); return; }
      const finalText = onBeforeSendToAI ? onBeforeSendToAI(text, meta) : text;
      await postToStream(finalText, meta);
    } catch (e) {
      setError(e.message || String(e));
      setStatus("error");
    }
  }

  return (
    <div className="lab-uploader">
      <div
        className={`dropzone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        aria-label="Upload lab result file"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />

        <div className="dz-inner">
          <div className={`loader ${["extracting","streaming"].includes(status) ? "show" : ""}`}>
            <span className="dot"/><span className="dot"/><span className="dot"/>
          </div>
          <div className="status-label">
            {status === "idle" && "Drop PDF/image or click to choose"}
            {status === "extracting" && "Extracting text…"}
            {status === "streaming" && "Generating interpretation…"}
            {status === "done" && "Done"}
            {status === "error" && (error || "Error")}
          </div>
          <div className="hint">
            PDF, PNG, JPG, WEBP, TIFF (≤ {Math.max(PROVIDER_MAX_MB, maxSizeMB)} MB)
          </div>
        </div>
      </div>

      {!autoSend && extractedText && (
        <div className="extracted">
          <div className="extracted-head">
            <strong>Extracted text</strong><span className="badge">Ready to send</span>
          </div>
          <textarea
            value={extractedText}
            onChange={(e) => setExtractedText(e.target.value)}
            spellCheck={false}
          />
          <button
            className="send-btn"
            onClick={() =>
              postToStream(
                onBeforeSendToAI ? onBeforeSendToAI(extractedText, fileMeta) : extractedText,
                fileMeta
              )
            }
          >
            Send to AI
          </button>
        </div>
      )}

      {status === "error" && error && <div className="error">{error}</div>}
    </div>
  );
});

export default LabResultsUploader;

