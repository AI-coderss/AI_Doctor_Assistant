// src/components/LabResultsUploader.jsx
import React, {
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import "../styles/LabResultsUploader.css";

const BACKEND_BASE = process.env.REACT_APP_BACKEND_BASE;
const OCR_URL = `${BACKEND_BASE}/ocr`;
const STREAM_URL = `${BACKEND_BASE}/stream`;

const ACCEPTED = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
];

const LabResultsUploader = forwardRef(function LabResultsUploader(
  {
    autoSend = true,
    ocrLanguage = "eng",
    engine = "2",
    overlay = false,
    maxSizeMB = 20,
    onBeforeSendToAI, // (text, meta) => string
    onAIResponse, // (payload, { text, meta })
    onExtracted, // (text, meta)
    onAIStreamToken, // (tokenChunk)
  },
  ref
) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("idle"); // idle|extracting|streaming|done|error
  const [error, setError] = useState("");
  const [fileMeta, setFileMeta] = useState(null);
  const [extractedText, setExtractedText] = useState("");

  // Expose an imperative API for opening the file dialog
  useImperativeHandle(ref, () => ({
    open: () => inputRef.current?.click(),
  }));

  const validate = (file) => {
    if (!file) return "No file selected";
    if (
      !ACCEPTED.includes(file.type) &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return "Only PDF or image files are supported.";
    }
    const max = maxSizeMB * 1024 * 1024;
    if (file.size > max) return `File too large. Max ${maxSizeMB}MB.`;
    return "";
  };

  async function postToStream(text, meta) {
    setStatus("streaming");
    const payload = {
      input: text,
      mode: "lab_results",
      source: meta?.filename || "unknown",
    };

    try {
      const res = await fetch(STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const ct = res.headers.get("content-type") || "";
      if (
        !res.body ||
        (!ct.includes("text/event-stream") &&
          !ct.includes("application/octet-stream"))
      ) {
        const data = ct.includes("application/json")
          ? await res.json()
          : { text: await res.text() };
        onAIResponse?.(data, { text: extractedText, meta: fileMeta });
        setStatus("done");
        return;
      }

      // Streaming read
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

  async function handleFile(file) {
    const err = validate(file);
    if (err) {
      setError(err);
      setStatus("error");
      return;
    }

    setError("");
    setStatus("extracting");

    const form = new FormData();
    form.append("image", file); // must be 'image' to match backend
    form.append("language", ocrLanguage);
    form.append("engine", engine);
    form.append("overlay", overlay ? "true" : "false");

    try {
      const res = await fetch(OCR_URL, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "OCR failed");

      const text = data?.text || "";
      const meta = data?.meta || {
        filename: file.name,
        mimetype: file.type,
        size: file.size,
      };
      setExtractedText(text);
      setFileMeta(meta);
      onExtracted?.(text, meta);

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

  return (
    <div className="lab-uploader">
      <div
        className={`dropzone ${dragOver ? "drag-over" : ""}`}
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
        role="button"
        tabIndex={0}
        onKeyDown={(e) =>
          (e.key === "Enter" || e.key === " ") && inputRef.current?.click()
        }
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
          <div
            className={`loader ${
              ["extracting", "streaming"].includes(status) ? "show" : ""
            }`}
          >
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
          <div className="status-label">
            {status === "idle" && "Drop PDF/image or click to choose"}
            {status === "extracting" && "Extracting text…"}
            {status === "streaming" && "Generating interpretation…"}
            {status === "done" && "Done"}
            {status === "error" && (error || "Error")}
          </div>
          <div className="hint">
            PDF, PNG, JPG, WEBP, TIFF (≤ {maxSizeMB}MB)
          </div>
        </div>
      </div>

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

      {status === "error" && error && <div className="error">{error}</div>}
    </div>
  );
});

export default LabResultsUploader;
