/* eslint-disable no-loop-func */
// src/components/MedicationChecker.jsx
import React, {
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import "../styles/MedicationChecker.css"; // distinct styling (not reusing LabResultsUploader.css)

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

// Endpoints (Flask in your app.py)
const OCR_URLS = [`${BACKEND_BASE}/ocr`, `${BACKEND_BASE}/api/ocr`]; // reuse your existing OCR
const PARSE_MEDS_URL = `${BACKEND_BASE}/meds/parse`;
const MAP_MEDS_URL = `${BACKEND_BASE}/meds/map`;
const CHECK_MEDS_URL = `${BACKEND_BASE}/meds/check`;
const ANALYZE_STREAM_URL = `${BACKEND_BASE}/meds/analyze-stream`;

// OCR provider rough limits
const PROVIDER_MAX_MB = 1;

const ACCEPTED = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
];
const REJECTED_PREFIXES = ["video/", "audio/"];

/* ---------------- Utilities ---------------- */
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

/* ---------------- Component ---------------- */
const MedicationChecker = forwardRef(function MedicationChecker(
  {
    ocrLanguage = "eng",
    engine = "2",
    overlay = false,
    autoSend = true,            // if true, stream the AI narrative after checks
    onAIStreamToken,            // (chunk)
    onAIResponse,               // (finalText, { meds, mapped, interactions, meta })
    onStructuredResult,         // ({ meds, mapped, interactions, meta })
    className = "",
    dense = false,
  },
  ref
) {
  const inputRef = useRef(null);

  const [dragOver, setDragOver] = useState(false);
  const [hover, setHover] = useState(false);
  const [hasFile, setHasFile] = useState(false);

  const [status, setStatus] = useState("idle"); // idle|extracting|parsing|checking|streaming|done|error
  const [error, setError] = useState("");
  const [meta, setMeta] = useState(null);
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
    if (!file.type.startsWith("image/") && file.size > PROVIDER_MAX_MB * 1024 * 1024) {
      return `This file is larger than your OCR plan limit (${PROVIDER_MAX_MB}MB). Compress or upgrade plan.`;
    }
    return "";
  };

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

  async function parseMeds(text) {
    setStatus("parsing");
    const res = await fetch(PARSE_MEDS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || `Parse failed (${res.status})`);
    return data?.meds || [];
  }

  async function mapMeds(meds) {
    const res = await fetch(MAP_MEDS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meds }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || `Map failed (${res.status})`);
    return data?.mapped || [];
  }

  async function checkInteractions(mapped) {
    setStatus("checking");
    const rxcuis = mapped
      .map((m) => m?.rxnorm?.rxcui)
      .filter(Boolean)
      .map(String);

    const res = await fetch(CHECK_MEDS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rxcuis }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || `Check failed (${res.status})`);
    return data?.interactions || [];
  }

  async function streamAnalysis({ text, meds, mapped, interactions }) {
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

    const payload = {
      session_id: sessionId,
      text: text || extractedText,
      meds,
      mapped,
      interactions,
    };

    const res = await fetch(ANALYZE_STREAM_URL, {
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

    // stream raw chunks (compatible with your chat app)
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
      onAIResponse?.(full, { meds, mapped, interactions, meta });
      setStatus("done");
      return;
    }

    // fallback (no streaming)
    const data = ct.includes("application/json")
      ? await res.json()
      : { text: await res.text() };
    const full = data?.text || "";
    onAIResponse?.(full, { meds, mapped, interactions, meta });
    setStatus("done");
  }

  async function handleFile(file) {
    setError("");
    setHasFile(!!file);
    const invalid = validate(file);
    if (invalid) {
      setStatus("error");
      setError(invalid);
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
      const m =
        data?.meta || {
          filename: sendFile.name,
          mimetype: sendFile.type,
          size: sendFile.size,
          urlTried,
        };
      if (!text.trim()) throw new Error("OCR returned empty text");

      setExtractedText(text);
      setMeta(m);

      // 1) parse -> meds
      const meds = await parseMeds(text);
      // 2) map -> RxNorm
      const mapped = await mapMeds(meds);
      // 3) interactions
      const interactions = await checkInteractions(mapped);

      // bubble structured result up (so chat can render <MedPanel/>)
      onStructuredResult?.({ meds, mapped, interactions, meta: m });

      if (!autoSend) {
        setStatus("done");
        return;
      }

      // 4) stream a concise narrative
      await streamAnalysis({ text, meds, mapped, interactions });
    } catch (e) {
      setError(e.message || String(e));
      setStatus("error");
    }
  }

  const glyph = (() => {
    if (["extracting", "parsing", "checking", "streaming"].includes(status)) return "";
    if (!hasFile) return "💊";
    return hover ? "⭯" : "✓";
  })();

  const statusText =
    status === "idle"
      ? "Drop prescriptions or click"
      : status === "extracting"
      ? "Extracting text…"
      : status === "parsing"
      ? "Parsing meds…"
      : status === "checking"
      ? "Checking interactions…"
      : status === "streaming"
      ? "Generating summary…"
      : status === "done"
      ? "Done"
      : status === "error"
      ? (error || "Error")
      : "";

  const containerClass = [
    "meds-dropzone",
    dragOver ? "dragOver" : "",
    hasFile ? "uploaded" : "",
    status === "extracting" ? "is-extracting" : "",
    status === "parsing" ? "is-parsing" : "",
    status === "checking" ? "is-checking" : "",
    status === "streaming" ? "is-streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`meds-uploader ${dense ? "dense" : ""} ${className || ""}`}>
      <div className="meds-upload-card">
        <div className="meds-upload-head">
          <div className="meds-pill-icon" aria-hidden="true" />
          <div className="meds-upload-title">Medication Intelligence</div>
          <div className="meds-upload-sub">Reconciliation · Duplicates · Interactions</div>
        </div>

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
          aria-label="Upload prescription image or PDF"
        >
          {["extracting", "parsing", "checking", "streaming"].includes(status) ? (
            <div className="meds-spinner" aria-hidden="true" />
          ) : (
            <span className="meds-glyph">{glyph}</span>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,image/*"
          className="meds-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />

        <div
          className={[
            "meds-status",
            status === "extracting" ? "s-extracting" : "",
            status === "parsing" ? "s-parsing" : "",
            status === "checking" ? "s-checking" : "",
            status === "streaming" ? "s-streaming" : "",
            status === "error" ? "s-error" : "",
            status === "done" ? "s-done" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-live="polite"
        >
          <span className="meds-status-text">{statusText}</span>
          {["extracting", "parsing", "checking", "streaming"].includes(status) && (
            <span className="meds-dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>

        {status === "error" && error && (
          <div className="meds-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
});

export default MedicationChecker;

/* ===== Medication Results Panel (to show inside chat) ===== */
export function MedPanel({ mapped = [], interactions = [], meta }) {
  const nameByRxcui = {};
  mapped.forEach((m) => {
    const rxcui = m?.rxnorm?.rxcui;
    if (rxcui) nameByRxcui[rxcui] = m?.rxnorm?.name || m?.name;
  });

  const groupByPair = {};
  (interactions || []).forEach((it) => {
    const key = it.pair?.slice().sort().join("|") || Math.random().toString(36);
    if (!groupByPair[key]) groupByPair[key] = [];
    groupByPair[key].push(it);
  });

  const severityClass = (sev = "") => {
    const s = String(sev).toLowerCase();
    if (s.includes("contra") || s.includes("major")) return "sev--major";
    if (s.includes("moderate")) return "sev--moderate";
    if (s.includes("minor")) return "sev--minor";
    return "sev--unknown";
  };

  return (
    <div className="meds-panel">
      <div className="meds-panel__header">
        <div>
          <div className="meds-panel__title">Medication Review</div>
          {meta?.filename && (
            <div className="meds-panel__meta">Source: {meta.filename}</div>
          )}
        </div>
        <div className="meds-panel__legend">
          <span className="legend-badge sev--major" /> Major
          <span className="legend-badge sev--moderate" /> Moderate
          <span className="legend-badge sev--minor" /> Minor
        </div>
      </div>

      <div className="meds-panel__body">
        <div className="meds-section">
          <div className="meds-section__title">Recognized Medications</div>
          <ul className="meds-list">
            {mapped.map((m, idx) => (
              <li key={idx} className="meds-list__item">
                <div className="meds-list__name">
                  {m?.rxnorm?.name || m?.name || "Unknown"}
                </div>
                <div className="meds-list__rx">
                  {[m.strength, m.unit].filter(Boolean).join(" ")}{" "}
                  {m.form || ""} {m.route ? `• ${m.route}` : ""}{" "}
                  {m.frequency ? `• ${m.frequency}` : ""}
                  {m.dup ? <span className="dup-badge">Duplicate</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="meds-section">
          <div className="meds-section__title">Drug–Drug Interactions</div>
          {Object.keys(groupByPair).length === 0 ? (
            <div className="no-interactions">No known interactions found.</div>
          ) : (
            <div className="interactions">
              {Object.entries(groupByPair).map(([key, arr]) => {
                const pair = arr[0]?.pair || [];
                const a = nameByRxcui[pair[0]] || pair[0];
                const b = nameByRxcui[pair[1]] || pair[1];
                const worst =
                  arr.find((x) =>
                    /contraindicated|major/i.test(x?.severity || "")
                  ) ||
                  arr.find((x) => /moderate/i.test(x?.severity || "")) ||
                  arr[0];

                return (
                  <div key={key} className="interaction-card">
                    <div className="interaction-card__head">
                      <div className={`sev-badge ${severityClass(worst?.severity)}`}>
                        {worst?.severity || "Unknown"}
                      </div>
                      <div className="interaction-card__title">
                        {a} ↔ {b}
                      </div>
                    </div>
                    <ul className="interaction-card__list">
                      {arr.map((it, i2) => (
                        <li key={i2}>
                          <div className="interaction-card__line">
                            <span className="interaction-card__desc">
                              {it.description || "Interaction detail unavailable."}
                            </span>
                            {it.sources?.length ? (
                              <span className="interaction-card__src">
                                {it.sources.join(", ")}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
