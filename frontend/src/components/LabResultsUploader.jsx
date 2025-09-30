/* eslint-disable no-loop-func */
// src/components/LabResultsUploader.jsx
import React, {
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import "../styles/LabResultsUploader.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

const OCR_URLS = [`${BACKEND_BASE}/ocr`, `${BACKEND_BASE}/api/ocr`];
const STREAM_URL = `${BACKEND_BASE}/stream`;
const PARSE_URL = `${BACKEND_BASE}/labs/parse`; // ⬅️ NEW

/** OCR.Space rough limits; adjust to your plan */
const PROVIDER_MAX_MB = 1;

const ACCEPTED = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
];
const REJECTED_PREFIXES = ["video/", "audio/"];

// ---------- Utilities ----------
function looksHtml(text) {
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
    const msg = looksHtml(txt)
      ? `Server returned an HTML error page (${res.status}). Snippet: ${snippet}`
      : `Unexpected non-JSON response (${res.status}). Snippet: ${snippet}`;
    const err = new Error(msg);
    err._rawText = txt;
    err._status = res.status;
    throw err;
  }
}

/** Downscale (best-effort) large images to fit provider MB */
async function downscaleImageIfNeeded(file, targetMB = 1) {
  const maxBytes = targetMB * 1024 * 1024;
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= maxBytes) return file;

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let { width, height } = bitmap;

  let quality = 0.85;
  let blob = file;

  for (let i = 0; i < 7; i++) {
    width = Math.max(800, Math.floor(width * 0.75));
    height = Math.max(800, Math.floor(height * 0.75));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0, width, height);

    blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob) break;
    if (blob.size <= maxBytes) break;
    quality = Math.max(0.5, quality - 0.1);
  }
  if (!blob || blob.size > maxBytes) return file;

  return new File([blob], (file.name || "image") + ".jpg", {
    type: "image/jpeg",
  });
}

const LabResultsUploader = forwardRef(function LabResultsUploader(
  {
    autoSend = true,
    ocrLanguage = "eng",
    engine = "2",
    overlay = false,
    maxSizeMB = PROVIDER_MAX_MB,
    onBeforeSendToAI, // (text, meta) => string
    onAIResponse,     // (payload, { text, meta })
    onExtracted,      // (text, meta)
    onAIStreamToken,  // (chunk)
    onParsedLabs,     // ⬅️ NEW: (labsArray, meta)
    className = "",
    dense = false,
  },
  ref
) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("idle"); // idle|extracting|streaming|done|error
  const [error, setError] = useState("");
  const [fileMeta, setFileMeta] = useState(null);
  const [extractedText, setExtractedText] = useState("");

  const [hasFile, setHasFile] = useState(false);
  const [hover, setHover] = useState(false);

  useImperativeHandle(ref, () => ({ open: () => inputRef.current?.click() }));

  const validate = (file) => {
    if (!file) return "No file selected.";
    if (REJECTED_PREFIXES.some((p) => file.type.startsWith(p))) {
      return "Video/audio files are not supported. Please upload a PDF or image.";
    }
    if (!ACCEPTED.includes(file.type) && !file.name.toLowerCase().endsWith(".pdf")) {
      return "Only PDF or image files are supported (PNG, JPG, WEBP, TIFF).";
    }
    if (!file.type.startsWith("image/") && file.size > PROVIDER_MAX_MB * 1024 * 1024) {
      return `This file is larger than your OCR plan limit (${PROVIDER_MAX_MB}MB). Compress or upgrade plan.`;
    }
    return "";
  };

  /** Send to chat stream */
  async function postToStream(text, meta) {
    setStatus("streaming");

    let sessionId = null;
    try {
      sessionId = localStorage.getItem("sessionId");
    } catch (_) {}
    if (!sessionId) {
      sessionId = crypto?.randomUUID?.() || String(Date.now());
      try {
        localStorage.setItem("sessionId", sessionId);
      } catch (_) {}
    }

    const payload = { message: text, session_id: sessionId };

    try {
      const res = await fetch(STREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json;q=0.9, */*;q=0.8",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const bodyTxt = await res.text().catch(() => "");
        throw new Error(
          `Stream ${res.status} ${res.statusText} — ${bodyTxt.slice(0, 300)}`
        );
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();

      if (res.body && (ct.includes("text/event-stream") || ct.includes("application/octet-stream"))) {
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
        return;
      }

      const data = ct.includes("application/json")
        ? await res.json()
        : { text: await res.text() };
      onAIResponse?.(data, { text: extractedText, meta: fileMeta });
      setStatus("done");
    } catch (err) {
      setError(err.message || String(err));
      setStatus("error");
    }
  }

  async function postToOcr(form) {
    let lastErr;
    for (const url of OCR_URLS) {
      try {
        const res = await fetch(url, { method: "POST", body: form });
        if (res.status === 404) {
          lastErr = new Error(`404 at ${url}`);
          continue;
        }
        const data = await readJsonSafe(res);
        return { res, data, urlTried: url };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("No OCR endpoint reachable.");
  }

  async function parseWithBackend(text) {
    try {
      const res = await fetch(PARSE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Parse ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data?.labs)) return data.labs;
    } catch (e) {
      // fallback locally
      return parseLabsHeuristics(text);
    }
    return parseLabsHeuristics(text);
  }

  /** Basic local regex fallback */
  function parseLabsHeuristics(text = "") {
    const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const labs = [];
    const num = (s) => {
      if (s == null) return NaN;
      const t = String(s).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      return t ? parseFloat(t[0]) : NaN;
    };

    const rx = new RegExp(
      String.raw`^([A-Za-z][A-Za-z0-9\s\(\)\/\+\-%\.]+?)\s*[:\-]?\s*` + // name
      String.raw`(-?\d+(?:[.,]\d+)?)\s*` +                              // value
      String.raw`([A-Za-zµ%\/\^\d\.\-]*)\s*` +                          // unit
      String.raw`(?:\(\s*(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?)\s*\)` + // (low-high)
      String.raw`|(?:ref(?:erence)?|range|normal)\s*:?[^0-9\-]*` +
      String.raw`(-?\d+(?:[.,]\d+)?)\s*[\-–]\s*(-?\d+(?:[.,]\d+)?))?` +
      String.raw`\s*(?:([HL])\b)?`, 'i'
    );

    for (const ln of lines) {
      const m = ln.match(rx);
      if (!m) continue;
      const name = m[1].replace(/\s+/g, " ").trim();
      const value = num(m[2]);
      const unit = (m[3] || "").trim();
      const low = num(m[4] || m[6]);
      const high = num(m[5] || m[7]);
      const flag = (m[8] || "").toUpperCase();
      labs.push({
        name,
        value: isFinite(value) ? value : null,
        unit,
        low: isFinite(low) ? low : null,
        high: isFinite(high) ? high : null,
        flag: flag || null,
      });
    }
    return labs;
  }

  async function handleFile(file) {
    setHasFile(!!file);
    setError("");
    const err = validate(file);
    if (err) {
      setError(err);
      setStatus("error");
      return;
    }

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
      } catch {
        setError("Failed to compress image. Please upload a smaller image.");
        setStatus("error");
        return;
      }
    }

    setStatus("extracting");

    const form = new FormData();
    form.append("image", sendFile);
    form.append("language", ocrLanguage);
    form.append("engine", engine);
    form.append("overlay", overlay ? "true" : "false");

    try {
      const { res, data, urlTried } = await postToOcr(form);

      if (!res.ok) {
        const msg =
          data?.error ||
          data?.message ||
          data?.details?.ErrorMessage ||
          `OCR failed (${res.status})`;
        throw new Error(msg);
      }

      const text = data?.text || "";
      const meta =
        data?.meta || {
          filename: sendFile.name,
          mimetype: sendFile.type,
          size: sendFile.size,
          urlTried,
        };
      if (!text.trim()) throw new Error("OCR returned empty text");

      setExtractedText(text);
      setFileMeta(meta);
      onExtracted?.(text, meta);

      // ⬅️ NEW: parse labs and notify chat to render visual bar
      try {
        const parsed = await parseWithBackend(text);
        if (Array.isArray(parsed) && parsed.length) {
          onParsedLabs?.(parsed, meta);
        }
      } catch {}

      if (!autoSend) {
        setStatus("done");
        return;
      }
      const finalText = onBeforeSendToAI ? onBeforeSendToAI(text, meta) : text;
      await postToStream(finalText, meta);
    } catch (e) {
      setError(e.message || String(e));
      setStatus("error");
    }
  }
  const glyph = (() => {
    if (status === "extracting" || status === "streaming") return ""; // spinner instead
    if (!hasFile) return "+";
    return hover ? "⭯" : "✓";
  })();

  const statusText =
    status === "idle"
      ? "Drop PDF/Image or click"
      : status === "extracting"
      ? "Extracting text…"
      : status === "streaming"
      ? "Interpreting result…"
      : status === "done"
      ? "Done"
      : status === "error"
      ? (error || "Error")
      : "";

  const containerClass = [
    "dropzone",
    dragOver ? "dragOver" : "",
    hasFile ? "uploaded" : "",
    status === "extracting" ? "is-extracting" : "",
    status === "streaming" ? "is-streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`lab-uploader ${dense ? "dense" : ""} ${className || ""}`}>
      <div className="file-upload">
        <p className="upload-label">
          <label>Please upload lab result</label>
        </p>

        {/* Square dashed dropzone */}
        <div
          className={containerClass}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) handleFile(f);
          }}
          onClick={() => inputRef.current?.click()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && inputRef.current?.click()
          }
          aria-label="Upload lab result file"
        >
          {(status === "extracting" || status === "streaming") ? (
            <div className="ring" aria-hidden="true" />
          ) : (
            <span className="glyph">{glyph}</span>
          )}
        </div>

        {/* Actual input (no visible native button) */}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,image/*"
          className="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            // allow re-selecting same file
            e.target.value = "";
          }}
        />

        {/* Animated status line */}
        <div
          className={[
            "status-line",
            status === "extracting" ? "s-extracting" : "",
            status === "streaming" ? "s-streaming" : "",
            status === "error" ? "s-error" : "",
            status === "done" ? "s-done" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-live="polite"
        >
          <span className="status-text">{statusText}</span>
          {(status === "extracting" || status === "streaming") && (
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>

        {status === "error" && error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Optional manual-send mode */}
      {!autoSend && extractedText && (
        <div className="extracted">
          <div className="extracted-head">
            <strong>Extracted text</strong>
            <span className="badge">Ready to send</span>
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
                onBeforeSendToAI
                  ? onBeforeSendToAI(extractedText, fileMeta)
                  : extractedText,
                fileMeta
              )
            }
          >
            Send to AI
          </button>
        </div>
      )}
    </div>
  );
});

export default LabResultsUploader;








