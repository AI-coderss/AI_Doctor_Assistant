/* eslint-disable no-unused-vars */
// VoiceRecorderPanel.jsx
import React, { useRef, useState, useEffect } from "react";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/**
 * VoiceRecorderPanel
 * - Uses react-mic with your EXACT props.
 * - Draggable glass panel (no resize while dragging).
 * - "Record The Case" launcher fixed bottom-left, turns into a timer while recording.
 * - On Stop => POST audio to transcribeUrl (multipart, {fileFieldName}).
 * - When transcript ready => calls onTranscriptReady(transcript) + shows "Analyze Case".
 * - "Analyze Case" streams from opinionUrl and forwards chunks to onOpinion.
 * - Sends session_id to backend.
 *
 * Props:
 *   transcribeUrl      : string  (absolute or relative; default points to Flask /transcribe)
 *   opinionUrl         : string  (absolute or relative; default points to Flask /case-second-opinion-stream)
 *   fileFieldName      : string  (e.g., "audio_data")
 *   anchorLeft         : number
 *   anchorBottom       : number
 *   onOpinion          : (chunk: string, done?: boolean) => void
 *   onTranscriptReady  : (transcript: string) => void
 */

// ---- Backend base fallback (env → prop → hardcoded) ----
const ENV_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_BACKEND_BASE) ||
  (typeof process !== "undefined" && process.env?.REACT_APP_BACKEND_BASE) ||
  "";

const DEFAULT_BACKEND_BASE =
  ENV_BASE?.trim() ||
  "https://ai-doctor-assistant-backend-server.onrender.com";

const isAbsolute = (u) => /^https?:\/\//i.test(u || "");

const joinUrl = (base, path) =>
  `${base.replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;

const mimeToExt = (mime = "") => {
  const m = mime.toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg")) return "mp3"; // covers audio/mpeg
  if (m.includes("mp4")) return "mp4";
  return "wav"; // safest default for ReactMic
};

const looksLikeHtml404 = (axErr) => {
  const status = axErr?.response?.status;
  const data = axErr?.response?.data;
  return (
    status === 404 &&
    typeof data === "string" &&
    data.trim().toLowerCase().startsWith("<!doctype html")
  );
};

const friendlyAxiosError = (axErr) => {
  const st = axErr?.response?.status;
  const raw = axErr?.response?.data;

  let j;
  try {
    j = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    j = null;
  }

  if (st === 413) {
    const lim =
      j?.limit_mb || j?.provider_limit_mb
        ? ` (limit ${j.limit_mb || j.provider_limit_mb} MB)`
        : "";
    return `Upload too large${lim}. Try a shorter recording.`;
  }
  if (st === 400) {
    const detail =
      j?.error ||
      j?.message ||
      (typeof raw === "string" ? raw.slice(0, 160) : "Bad request");
    return `Bad request: ${detail}`;
  }
  if (st && st >= 500) return `Server error (${st}). Please retry.`;
  if (axErr?.code === "ERR_NETWORK") return "Network error to API. Check URL/CORS.";
  if (axErr?.code === "ECONNABORTED") return "Request timed out. Please try again.";
  if (looksLikeHtml404(axErr))
    return "Endpoint hit a static host (HTML 404). Check backend base/route.";
  return axErr?.message || "Unexpected error while uploading audio.";
};

const VoiceRecorderPanel = ({
  transcribeUrl = joinUrl(DEFAULT_BACKEND_BASE, "/transcribe"),
  opinionUrl = joinUrl(DEFAULT_BACKEND_BASE, "/case-second-opinion-stream"),
  fileFieldName = "audio_data",
  anchorLeft = 120,
  anchorBottom = 140,
  onOpinion,
  onTranscriptReady,
}) => {
  const [open, setOpen] = useState(false);

  // recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // flow state
  const [loading, setLoading] = useState(false);
  const [isTranscriptReady, setIsTranscriptReady] = useState(false);
  const [status, setStatus] = useState("");

  // keep transcript in memory (not rendered)
  const transcriptRef = useRef("");

  // session id (align with chat.jsx)
  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  // ---- TIMER (for launcher while recording) ----
  const [elapsedMs, setElapsedMs] = useState(0);
  const rafRef = useRef(null);
  const startAtRef = useRef(0);
  const pausedAccumRef = useRef(0);
  const wasRecordingRef = useRef(false);

  const formatTime = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(cs)}`;
  };

  const tick = () => {
    if (isRecording && !isPaused) {
      const now = performance.now();
      setElapsedMs(pausedAccumRef.current + (now - startAtRef.current));
      rafRef.current = requestAnimationFrame(tick);
    }
  };

  useEffect(() => {
    // recording started
    if (isRecording && !wasRecordingRef.current) {
      wasRecordingRef.current = true;
      pausedAccumRef.current = 0;
      startAtRef.current = performance.now();
      setElapsedMs(0);
      rafRef.current = requestAnimationFrame(tick);
    }

    // pause / resume
    if (isRecording && isPaused) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pausedAccumRef.current = elapsedMs;
    } else if (isRecording && !isPaused) {
      startAtRef.current = performance.now();
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    }

    // cleanup when stop
    if (!isRecording && wasRecordingRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      wasRecordingRef.current = false;
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, isPaused]);

  // ---- controls ----
  const startRecording = () => {
    transcriptRef.current = "";
    setIsPaused(false);
    setIsRecording(true);
    setIsTranscriptReady(false);
    setStatus("");
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
  };

  const togglePauseResume = () => {
    if (!isRecording) return;
    setIsPaused((p) => !p);
  };

  const resetRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    setIsTranscriptReady(false);
    transcriptRef.current = "";
    setElapsedMs(0);
    pausedAccumRef.current = 0;
    setStatus("");
  };

  // ---- POST helper with path fallback (/transcribe → /api/transcribe) ----
  const postTranscribeWithFallback = async (form) => {
    const makeCandidates = (u) => {
      // If absolute, keep host; else apply backend base.
      const resolved = isAbsolute(u) ? u : joinUrl(DEFAULT_BACKEND_BASE, u);
      const url = new URL(resolved);

      // First: /transcribe (or whatever exact path caller gave)
      const first = url.toString();

      // If the path already contains '/api/', swap to non-api; else add '/api' prefix.
      const alt =url.pathname.startsWith("/api/")
          ? url.toString().replace("/api/", "/")
          : url.toString().replace(url.pathname, joinUrl("/", `/api${url.pathname}`).replace(/https?:\/\/[^/]+/,""));

      // Ensure a proper absolute alt (handle the replacement above)
      const altAbs = url.pathname.startsWith("/api/")
        ? first.replace("/api/", "/")
        : first.replace(url.pathname, `/api${url.pathname}`);

      return [first, altAbs];
    };

    const candidates = makeCandidates(transcribeUrl);
    let lastErr = null;

    for (const u of candidates) {
      try {
        const { data } = await axios.post(u, form, {
          // DO NOT set Content-Type; browser sets multipart boundary
          headers: {
            Accept: "application/json, text/plain, */*",
            "X-Session-Id": sessionId,
          },
          withCredentials: false,
          timeout: 60_000,
          transformResponse: (r) => r, // keep raw
          validateStatus: (s) => s >= 200 && s < 300,
        });

        let parsed;
        try {
          parsed = typeof data === "string" ? JSON.parse(data) : data;
        } catch {
          if (typeof data === "string" && data.startsWith("<!doctype html>")) {
            throw new Error("Received HTML body from API (wrong URL).");
          }
          throw new Error("Unexpected non-JSON response from API.");
        }
        return parsed;
      } catch (e) {
        lastErr = e;
        // If looks like SPA HTML 404, try the next candidate
        if (looksLikeHtml404(e)) continue;
        const st = e?.response?.status;
        if (st === 404) continue;
        break;
      }
    }
    throw lastErr || new Error("Failed to reach transcription endpoint.");
  };

  // ---- transcription (fires when recording stops) ----
  const onStop = async (recordedBlob) => {
    try {
      const b = recordedBlob?.blob;
      if (!b) return;

      // Respect actual MIME when available (ReactMic usually gives WAV).
      const mime = b.type || "audio/wav";
      const ext = mimeToExt(mime);
      const fileName = `recording-${Date.now()}.${ext}`;

      // Create a File that matches the blob bytes and MIME
      const audioFile = new File([b], fileName, { type: mime });

      const form = new FormData();
      form.append(fileFieldName, audioFile); // Flask expects "audio_data"
      form.append("session_id", sessionId);

      setLoading(true);
      setStatus("Uploading…");

      const json = await postTranscribeWithFallback(form);

      const txt = String(json?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = Boolean(txt);
      setIsTranscriptReady(ready);
      setStatus(ready ? "Transcribed ✅" : "No speech detected");

      if (ready && typeof onTranscriptReady === "function") {
        onTranscriptReady(txt);
      }
    } catch (e) {
      console.error("Transcription error:", e);
      setIsTranscriptReady(false);
      setStatus(friendlyAxiosError(e));
    } finally {
      setLoading(false);
    }
  };

  // ---- stream RAG second opinion ----
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;

    const payload = {
      context: transcriptRef.current,
      session_id: sessionId,
    };

    try {
      setLoading(true);
      setStatus("Analyzing…");

      const target = isAbsolute(opinionUrl)
        ? opinionUrl
        : joinUrl(DEFAULT_BACKEND_BASE, opinionUrl);

      const resp = await fetch(target, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/plain",
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });

      if (!resp.ok) {
        console.error("Stream request failed:", resp.status, resp.statusText);
        setStatus(`Analysis failed (${resp.status})`);
        setLoading(false);
        return;
      }
      if (!resp.body) {
        const text = await resp.text();
        if (typeof onOpinion === "function") onOpinion(text, true);
        setLoading(false);
        setOpen(false);
        setStatus("Analysis complete");
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      let aggregated = "";

      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          aggregated += chunk;
          if (typeof onOpinion === "function") onOpinion(chunk, false);
        }
      }
      if (typeof onOpinion === "function") onOpinion(aggregated, true);
      setStatus("Analysis complete");
    } catch (e) {
      console.error("Streaming error:", e);
      setStatus("Streaming error (check network/CORS)");
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  return (
    <>
      {/* Launcher area: button when idle; circular TIMER while recording */}
      {!isRecording ? (
        <button
          className="record-case-btn-left"
          onClick={() => setOpen(true)}
          title="Record The Case"
        >
          <span className="shine-content">Record The Case</span>
        </button>
      ) : (
        <div className="record-timer-fixed" aria-live="polite">
          <div className={`button-container ${isPaused ? "paused" : "running"}`}>
            <div className={`button ${isRecording ? "square" : ""}`} />
          </div>
          <h2 className={`timeroutput show`}>{formatTime(elapsedMs)}</h2>
        </div>
      )}

      {/* Draggable overlay panel */}
      {open && (
        <motion.div
          className="audio-recorder-overlay"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          drag
          dragMomentum={false}
          dragElastic={0.2}
          style={{ left: anchorLeft, bottom: anchorBottom, position: "fixed" }}
        >
          <div className="overlay-head" style={{ cursor: "move" }}>
            <span className={`badge ${isRecording ? "live" : ""}`}>
              {isRecording ? "Voice Recorder • LIVE" : "Voice Recorder"}
            </span>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="wave-wrap">
            {/* keep your exact mic settings */}
            <ReactMic
              record={isRecording}
              pause={isPaused}
              onStop={onStop}
              strokeColor="#6366f1"
              visualSetting="frequencyBars"
              backgroundColor="#FFFFFF"
              className="sound-wave"
            />
          </div>

          <div className="recorder-buttons">
            <button onClick={startRecording} disabled={isRecording && !isPaused}>
              <span className="shine-content">Start Recording</span>
            </button>
            <button onClick={stopRecording} disabled={!isRecording}>
              <span className="shine-content">Stop Recording</span>
            </button>
            <button onClick={togglePauseResume} disabled={!isRecording}>
              <span className="shine-content">
                {isPaused ? "Resume Recording" : "Pause Recording"}
              </span>
            </button>
            <button onClick={resetRecording} disabled={!isTranscriptReady}>
              <span className="shine-content">New Recording</span>
            </button>

            {isTranscriptReady && (
              <button className="analyze" onClick={analyzeCase}>
                <span className="shine-content">Analyze Case</span>
              </button>
            )}
          </div>

          {loading && (
            <div className="loaders">
              <div className="spinners" />
              <p>Processing…</p>
            </div>
          )}

          {status && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>{status}</div>
          )}
        </motion.div>
      )}
    </>
  );
};

export default VoiceRecorderPanel;





