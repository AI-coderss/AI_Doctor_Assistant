import React, { useRef, useState } from "react";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/**
 * VoiceRecorderPanel
 * - Uses react-mic with your EXACT hard-coded props.
 * - Draggable glass panel (no resize while dragging).
 * - "Record The Case" launcher button fixed bottom-left (near chat input).
 * - On Stop => POST audio to transcribeUrl (multipart, {fileFieldName}).
 * - When transcript ready => calls onTranscriptReady(transcript) and shows "Analyze Case".
 * - "Analyze Case" streams from opinionUrl and forwards chunks to onOpinion.
 * - Transcript is kept in-memory only; never rendered.
 *
 * Props:
 *   transcribeUrl      : string
 *   opinionUrl         : string
 *   fileFieldName      : string   (e.g., "audio_data")
 *   anchorLeft         : number   initial X for the overlay (px)
 *   anchorBottom       : number   initial Y-from-bottom for the overlay (px)
 *   onOpinion          : (chunk: string, done?: boolean) => void
 *   onTranscriptReady  : (transcript: string) => void      <-- NEW
 */
const VoiceRecorderPanel = ({
  transcribeUrl = "/transcribe",
  opinionUrl = "/case-second-opinion-stream",
  fileFieldName = "audio_data",
  anchorLeft = 120,
  anchorBottom = 140,
  onOpinion,
  onTranscriptReady, // NEW
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

  // controls
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

      setLoading(true);
      const { data } = await axios.post(transcribeUrl, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const txt = String(data?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = Boolean(txt);
      setIsTranscriptReady(ready);

      // 🔔 NEW: notify parent (e.g., Chat.jsx) so WebRTC assistant can be primed
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

  // stream RAG second opinion
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;

    try {
      setLoading(true);
      const resp = await fetch(opinionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: transcriptRef.current }),
      });

      if (!resp.ok || !resp.body) {
        console.error("Stream request failed:", resp.status);
        setLoading(false);
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
          else console.log("[AI chunk]", chunk);
        }
      }
      if (typeof onOpinion === "function") onOpinion(aggregated, true);
    } catch (e) {
      console.error("Streaming error:", e);
    } finally {
      setLoading(false);
      setOpen(false); // optional close
    }
  };

  return (
    <>
      {/* Launcher (left, near chat input). */}
      <button
        className="record-case-btn-left"
        onClick={() => setOpen(true)}
        title="Record The Case"
      >
        <span className="shine-content">Record The Case</span>
      </button>

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
            <span className="badge">
              {isRecording ? "Voice Recorder • LIVE" : "Voice Recorder"}
            </span>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="wave-wrap">
            {/* >>>>>>>>>>> DO NOT CHANGE: your exact mic settings <<<<<<<<<<< */}
            <ReactMic
              record={isRecording}
              pause={isPaused}
              onStop={onStop}
              strokeColor="#007bff"
              visualSetting="frequencyBars"
              backgroundColor="#FFFFFF"
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
            <div className="loader">
              <div className="spinner" />
              <p>Processing…</p>
            </div>
          )}
        </motion.div>
      )}
    </>
  );
};

export default VoiceRecorderPanel;



