// src/components/MicClinicalNotesButton.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import { useReactMediaRecorder } from "react-media-recorder"; // npm i react-media-recorder
import "../styles/MicClinicalNotesButton.css";

const BACKEND_BASE =
  process.env.REACT_APP_BACKEND_BASE ||
  "https://ai-doctor-assistant-backend-server.onrender.com";

const STRUCTURE_URL = `${BACKEND_BASE}/api/notes-structure-stream`;
const SECOND_OPINION_URL = `${BACKEND_BASE}/api/notes-second-opinion-stream`;
const RTC_URL = `${BACKEND_BASE}/api/rtc-notes-connect`;

// ——— Utility: debounce ———
const debounce = (fn, ms = 900) => {
  let t = null;
  function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }
  debounced.cancel = () => t && clearTimeout(t);
  return debounced;
};

export default function MicClinicalNotesButton({
  sessionId,
  onStream, // ({type:"start"|"chunk"|"done", data?})
  secondOpinion = true,
  showInlineTranscript = true, // small on-screen transcript preview
}) {
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [noteMarkdown, setNoteMarkdown] = useState("");

  // WebRTC refs
  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);

  // Media-recorder: for UX/status only (we stream via WebRTC)
  const { status, startRecording, stopRecording, clearBlobUrl } =
    useReactMediaRecorder({
      audio: true,
      onStart: () => {
        clearBlobUrl();
      },
    });

  const emitStart = () => onStream && onStream({ type: "start" });
  const emitChunk = (txt) => onStream && onStream({ type: "chunk", data: txt });
  const emitDone = () => onStream && onStream({ type: "done" });

  // Stream clinical notes (structured) from transcript
  const streamStructuredNotes = async (fullText) => {
    try {
      emitStart();
      const res = await fetch(STRUCTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: fullText }),
      });
      if (!res.ok || !res.body) {
        emitChunk("\n\n_Formatting service unavailable._");
        emitDone();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buff = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buff += chunk;
        emitChunk(chunk);
      }
      setNoteMarkdown(buff.trim());
      emitDone();
    } catch (e) {
      emitChunk(`\n\n_Error: ${e.message}_`);
      emitDone();
    }
  };

  const debouncedStructure = useRef(debounce(streamStructuredNotes, 800)).current;

  // WebRTC start/stop
  const startWebRTC = async () => {
    if (pcRef.current || connecting) return;
    setConnecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Attach mic
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // DataChannel (receive transcript deltas)
      const channel = pc.createDataChannel("notes");
      dataChannelRef.current = channel;

      let partial = "";

      channel.onopen = () => setConnected(true);
      channel.onclose = () => setConnected(false);
      channel.onerror = () => setConnected(false);
      channel.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          // Adjust the event types if your backend emits different ones
          if (
            msg.type === "response.audio_transcript.delta" &&
            typeof msg.delta === "string"
          ) {
            partial += msg.delta;
            setTranscript((prev) => prev + msg.delta);

            // Continuously re-structure the growing transcript
            debouncedStructure(partial);
          }
        } catch {
          // ignore non-JSON payloads
        }
      };

      // Offer/Answer
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      const res = await fetch(`${RTC_URL}?session_id=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          "X-Session-Id": sessionId || "",
        },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`RTC connect failed (${res.status})`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      setConnecting(false);
    } catch (err) {
      setConnecting(false);
      cleanupRTC();
      throw err;
    }
  };

  const cleanupRTC = () => {
    try {
      dataChannelRef.current?.close();
    } catch {}
    try {
      pcRef.current?.getSenders?.().forEach((s) => s.track?.stop());
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;
    dataChannelRef.current = null;

    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    localStreamRef.current = null;
    setConnected(false);
  };

  // Toggle handler (single circular button)
  const handleToggle = async () => {
    if (recording || status === "recording" || connected) {
      // STOP
      setRecording(false);
      stopRecording();
      // finalize: one last structure pass with full transcript
      if (transcript.trim()) {
        await streamStructuredNotes(transcript);
      }
      // optional: second opinion
      if (secondOpinion && noteMarkdown.trim()) {
        emitStart();
        try {
          const res = await fetch(SECOND_OPINION_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note_markdown: noteMarkdown }),
          });
          if (res.ok && res.body) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              emitChunk(decoder.decode(value, { stream: true }));
            }
          } else {
            emitChunk("\n\n_Second opinion service unavailable._");
          }
        } catch (e) {
          emitChunk(`\n\n_Error during second opinion: ${e.message}_`);
        } finally {
          emitDone();
        }
      }
      cleanupRTC();
      return;
    }

    // START
    setTranscript("");
    setNoteMarkdown("");
    setRecording(true);
    await startRecording();
    await startWebRTC();
  };

  // Cleanup on unmount
  useEffect(() => () => cleanupRTC(), []);

  const isBusy = connecting;
  const isActive = recording || status === "recording" || connected;

  return (
    <>
      {/* Floating mic circle button */}
      <button
        className={[
          "mic-notes-fab",
          isActive ? "is-recording" : "is-idle",
          isBusy ? "is-connecting" : "",
        ].join(" ")}
        aria-pressed={isActive}
        aria-label={isActive ? "Stop clinical notes" : "Start clinical notes"}
        onClick={handleToggle}
      >
        {/* Pulsing outer ring */}
        <span className="mic-pulse-ring" aria-hidden="true" />
        {/* Core circular surface */}
        <span className="mic-core" aria-hidden="true">
          {/* SVG mic icon */}
          <svg
            className="mic-icon"
            viewBox="0 0 24 24"
            role="img"
            aria-hidden="true"
          >
            <path
              d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"
              fill="currentColor"
            />
            <path
              d="M5 11a1 1 0 1 0-2 0 9 9 0 0 0 8 8v3H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-3a9 9 0 0 0 8-8 1 1 0 1 0-2 0 7 7 0 0 1-14 0Z"
              fill="currentColor"
              opacity="0.8"
            />
          </svg>
          {/* Recording LED dot */}
          <span className="mic-led" />
        </span>
      </button>

      {/* Optional tiny inline transcript HUD (can be hidden by prop) */}
      {showInlineTranscript && (
        <div className={`mic-transcript-hud ${isActive ? "show" : ""}`} aria-live="polite">
          <div className="hud-title">
            {isActive ? "Listening…" : noteMarkdown ? "Last Note" : "Ready"}
          </div>
          <div className="hud-body">
            {isActive
              ? (transcript || "Start speaking to generate notes…")
              : (noteMarkdown || "Press the mic to begin.")}
          </div>
        </div>
      )}
    </>
  );
}
