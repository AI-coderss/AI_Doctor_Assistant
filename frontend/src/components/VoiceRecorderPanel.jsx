import React, { useRef, useState, useEffect } from "react";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/**
 * VoiceRecorderPanel
 * - Uses react-mic with your EXACT hard-coded props.
 * - Draggable glass panel (no resize while dragging).
 * - "Record The Case" launcher fixed bottom-left, turns into a timer while recording.
 * - On Stop => POST audio to transcribeUrl (multipart, {fileFieldName}).
 * - When transcript ready => calls onTranscriptReady(transcript) + shows "Analyze Case".
 * - "Analyze Case" streams from opinionUrl and forwards chunks to onOpinion.
 * - Now passes session_id to backend (aligned with chat.jsx).
 *
 * Props:
 *   transcribeUrl      : string
 *   opinionUrl         : string
 *   fileFieldName      : string   (e.g., "audio_data")
 *   anchorLeft         : number   initial X for the overlay (px)
 *   anchorBottom       : number   initial Y-from-bottom for the overlay (px)
 *   onOpinion          : (chunk: string, done?: boolean) => void
 *   onTranscriptReady  : (transcript: string) => void
 */
const VoiceRecorderPanel = ({
  transcribeUrl = "/transcribe",
  opinionUrl = "/case_second_opinion_stream",
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

  // manage timer lifecyle when recording/pause changes
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
  };

  // transcription (fires when recording stops)
  const onStop = async (recordedBlob) => {
    try {
      if (!recordedBlob?.blob) return;
      const audioFile = new File([recordedBlob.blob], "temp.wav", {
        type: "audio/wav",
      });
      const form = new FormData();
      form.append(fileFieldName, audioFile);
      form.append("session_id", sessionId); // optional, helps server correlate

      setLoading(true);
      const { data } = await axios.post(transcribeUrl, form, {
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: false,
      });

      const txt = String(data?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = Boolean(txt);
      setIsTranscriptReady(ready);

      if (ready && typeof onTranscriptReady === "function") {
        onTranscriptReady(txt);
      }
    } catch (err) {
      console.error("Transcription error:", err);
      setIsTranscriptReady(false);
    } finally {
      setLoading(false);
    }
  };

  // stream RAG second opinion (now includes session_id + tougher streaming)
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;

    const payload = {
      context: transcriptRef.current,
      session_id: sessionId,
    };

    try {
      setLoading(true);

      // IMPORTANT: explicit Accept to match backend text streaming
      const resp = await fetch(opinionUrl, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/plain",
        },
        body: JSON.stringify(payload),
        // keepalive can help if user navigates away mid-stream
        keepalive: true,
      });

      if (!resp.ok) {
        console.error("Stream request failed:", resp.status, resp.statusText);
        setLoading(false);
        return;
      }
      if (!resp.body) {
        console.error("Readable stream not available on this browser/host");
        // Fallback: read as text (non-streaming proxies)
        const text = await resp.text();
        if (typeof onOpinion === "function") {
          onOpinion(text, true);
        }
        setLoading(false);
        setOpen(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      let aggregated = "";

      // Push chunks to chat.jsx in real-time
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
    } catch (e) {
      // net::ERR_FAILED typically = CORS or network block
      console.error("Streaming error:", e);
    } finally {
      setLoading(false);
      setOpen(false); // optional close
    }
  };

  return (
    <>
      {/* Launcher area:
          - Normal button when idle
          - Converts into small circular TIMER while recording
      */}
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
            <button
              className="close-x"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="wave-wrap">
            {/* >>>>>>>>>>> DO NOT CHANGE: your exact mic settings <<<<<<<<<<< */}
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
        </motion.div>
      )}
    </>
  );
};

export default VoiceRecorderPanel;




