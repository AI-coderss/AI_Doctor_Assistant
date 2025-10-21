import React, { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/**
 * VoiceRecorderPanel — Left Dock (outside drawer, not draggable)
 *
 * Behavior:
 *  - Click "Record The Case" => opens left dock + closes drawer (no recording yet).
 *  - Inside dock: "Start Recording" is enabled.
 *  - When recording starts: small red indicator + timer appears BELOW controls (extra spacing).
 *  - Stop: timer disappears (dock stays until closed).
 *
 * Anti-flicker timer:
 *  - Updates at 50ms using setInterval.
 *  - Each digit is rendered in a fixed-width span to prevent layout jitter.
 */
const VoiceRecorderPanel = ({
  transcribeUrl = "/transcribe",
  opinionUrl = "/case_second_opinion_stream",
  fileFieldName = "audio_data",
  onOpinion,
  onTranscriptReady,
}) => {
  // Left dock visibility (portal into <body>)
  const [dockOpen, setDockOpen] = useState(false);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Flow state
  const [loading, setLoading] = useState(false);
  const [isTranscriptReady, setIsTranscriptReady] = useState(false);

  // Transcript storage
  const transcriptRef = useRef("");

  // Session ID aligned with chat.jsx
  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  /* ================= TIMER (anti-flicker) ================= */
  const [elapsedMs, setElapsedMs] = useState(0);
  const intervalRef = useRef(null);
  const startAtRef = useRef(0);
  const pausedAccumRef = useRef(0);

  const pad2 = (n) => (n < 10 ? "0" + n : String(n));

  const getParts = (ms) => {
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    const HH = pad2(hh), MM = pad2(mm), SS = pad2(ss), CS = pad2(cs);
    return { HH, MM, SS, CS, aria: `${HH}:${MM}:${SS}:${CS}` };
  };

  const startInterval = () => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setElapsedMs(pausedAccumRef.current + (performance.now() - startAtRef.current));
    }, 50); // 20fps is stable, smooth, and reduces flicker
  };

  const stopInterval = () => {
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  };

  useEffect(() => {
    return () => stopInterval(); // cleanup on unmount
  }, []);

  /* ================= Drawer coordination ================= */
  const closeDrawer = () => {
    try { window.dispatchEvent(new CustomEvent("tools:close")); } catch {}
  };

  /* ================= Controls ================= */
  const handleLauncherClick = () => {
    setDockOpen(true);
    closeDrawer();
  };

  const startRecording = () => {
    transcriptRef.current = "";
    setIsPaused(false);
    setIsTranscriptReady(false);

    // timer init
    pausedAccumRef.current = 0;
    startAtRef.current = performance.now();
    setElapsedMs(0);
    startInterval();

    setIsRecording(true);
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    stopInterval();
  };

  const togglePauseResume = () => {
    if (!isRecording) return;
    if (isPaused) {
      // resume
      startAtRef.current = performance.now();
      startInterval();
      setIsPaused(false);
    } else {
      // pause
      stopInterval();
      pausedAccumRef.current = elapsedMs;
      setIsPaused(true);
    }
  };

  const resetRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    setIsTranscriptReady(false);
    transcriptRef.current = "";
    setElapsedMs(0);
    pausedAccumRef.current = 0;
    stopInterval();
  };

  /* ================= Upload after stop => transcribe ================= */
  const onStop = async (recordedBlob) => {
    try {
      if (!recordedBlob?.blob) return;
      const audioFile = new File([recordedBlob.blob], "temp.wav", { type: "audio/wav" });
      const form = new FormData();
      form.append(fileFieldName, audioFile);
      form.append("session_id", sessionId);

      setLoading(true);
      const { data } = await axios.post(transcribeUrl, form, {
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: false,
      });

      const txt = String(data?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = Boolean(txt);
      setIsTranscriptReady(ready);
      if (ready && typeof onTranscriptReady === "function") onTranscriptReady(txt);
    } catch (err) {
      console.error("Transcription error:", err);
      setIsTranscriptReady(false);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Analyze Case (stream to chat) ================= */
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;
    closeDrawer();

    const payload = { context: transcriptRef.current, session_id: sessionId };
    try {
      setLoading(true);
      const resp = await fetch(opinionUrl, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!resp.ok) { console.error("Stream request failed:", resp.status, resp.statusText); setLoading(false); return; }
      if (!resp.body) {
        const text = await resp.text();
        if (typeof onOpinion === "function") onOpinion(text, true);
        setLoading(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false, aggregated = "";
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
      console.error("Streaming error:", e);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Launcher — preserved formatting ================= */
  const Launcher = (
    <button
      className="record-case-btn-left"
      onClick={handleLauncherClick}
      title="Record The Case"
    >
      <span className="shine-content">Record The Case</span>
    </button>
  );

  /* ================= Fixed-width digit renderer ================= */
  const Digits = ({ value }) => {
    // value is "00" etc.
    return (
      <span className="digits">
        <span className="digit">{value[0]}</span>
        <span className="digit">{value[1]}</span>
      </span>
    );
  };

  /* ================= Left dock (portal) ================= */
  const dockNode = !dockOpen ? null : createPortal(
    <motion.div
      className="vrp-dock"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      role="region"
      aria-label="Voice Recorder"
    >
      <div className="overlay-head">
        <span className={`badge ${isRecording ? "live" : ""}`}>
          {isRecording ? "Voice Recorder • LIVE" : "Voice Recorder"}
        </span>
        <button
          className="close-x"
          onClick={() => setDockOpen(false)}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="wave-wrap">
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
        {/* Start enabled initially; only disabled while already recording */}
        <button onClick={startRecording} disabled={isRecording}>
          <span className="shine-content">Start Recording</span>
        </button>
        <button onClick={stopRecording} disabled={!isRecording}>
          <span className="shine-content">Stop Recording</span>
        </button>
        <button onClick={togglePauseResume} disabled={!isRecording}>
          <span className="shine-content">{isPaused ? "Resume Recording" : "Pause Recording"}</span>
        </button>
        <button onClick={resetRecording} disabled={!isTranscriptReady}>
          <span className="shine-content">New Recording</span>
        </button>

        {isTranscriptReady && (
          <button className="analyze" onClick={analyzeCase} disabled={loading}>
            <span className="shine-content">Analyze Case</span>
          </button>
        )}
      </div>

      {/* TIMER — appears only while recording; pushed down below controls */}
      {isRecording && (() => {
        const t = getParts(elapsedMs);
        return (
          <div className="vrp-timer-block" aria-live="polite">
            {/* Small red status above digits */}
            <div className={`button-container ${isPaused ? "paused" : "running"}`}>
              <div className={`button ${isRecording ? "square" : ""}`} />
            </div>

            {/* Accessible full string (hidden) */}
            <h2 className="timeroutput sr-only" role="timer">{t.aria}</h2>

            {/* Fixed-width numeric groups (no flicker) */}
            <div className="timer-digits" aria-hidden="true">
              <div className="time-group t-hours">
                <Digits value={t.HH} />
                <span className="label">hrs</span>
              </div>
              <span className="colon">:</span>
              <div className="time-group t-mins">
                <Digits value={t.MM} />
                <span className="label">min</span>
              </div>
              <span className="colon">:</span>
              <div className="time-group t-secs">
                <Digits value={t.SS} />
                <span className="label">sec</span>
              </div>
              <span className="colon dim">:</span>
              <div className="time-group t-centis">
                <Digits value={t.CS} />
                <span className="label">cs</span>
              </div>
            </div>
          </div>
        );
      })()}

      {loading && (
        <div className="loaders">
          <div className="spinners" />
          <p>Processing…</p>
        </div>
      )}
    </motion.div>,
    document.body
  );

  return (
    <>
      {Launcher}
      {dockNode}
    </>
  );
};

export default VoiceRecorderPanel;










