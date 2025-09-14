/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import { useReactMediaRecorder } from "react-media-recorder"; // UX/status only
import "../styles/MicClinicalNotesButton.css";

const BACKEND_BASE =
  process.env.REACT_APP_BACKEND_BASE ||
  "https://ai-doctor-assistant-backend-server.onrender.com";

const STRUCTURE_URL = `${BACKEND_BASE}/api/notes-structure-stream`;
const SECOND_OPINION_URL = `${BACKEND_BASE}/api/notes-second-opinion-stream`;
const RTC_URL = `${BACKEND_BASE}/api/rtc-transcribe-nodes-connect`; // <-- renamed

// debounce helper
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
  showInlineTranscript = true,
}) {
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [noteMarkdown, setNoteMarkdown] = useState("");

  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);

  // UX only (LED/pulse); audio actually goes via WebRTC
  const { status, startRecording, stopRecording, clearBlobUrl } =
    useReactMediaRecorder({
      audio: true,
      onStart: () => clearBlobUrl(),
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

  const debouncedStructure = useRef(
    debounce(streamStructuredNotes, 800)
  ).current;

  // WebRTC start/stop (transcription intent)
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

      // Data channel for JSON events (transcripts, etc.)
      const channel = pc.createDataChannel("notes");
      dataChannelRef.current = channel;

      let rolling = "";

      channel.onopen = () => setConnected(true);
      channel.onclose = () => setConnected(false);
      channel.onerror = () => setConnected(false);

      channel.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        // Original: model returns audio transcript deltas
        if (
          msg.type === "response.audio_transcript.delta" &&
          typeof msg.delta === "string"
        ) {
          rolling += msg.delta;
          setTranscript((prev) => prev + msg.delta);
          debouncedStructure(rolling);
          return;
        }

        // Also accept newer completion-style event if emitted
        if (
          msg.type === "conversation.item.input_audio_transcription.completed"
        ) {
          const t = (msg.transcript || "").trim();
          if (t) {
            rolling += (rolling ? " " : "") + t;
            setTranscript((prev) => (prev ? prev + " " : "") + t);
            debouncedStructure(rolling);
          }
          return;
        }
      };

      // Offer/Answer
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      const res = await fetch(
        `${RTC_URL}?session_id=${encodeURIComponent(sessionId || "")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
            "X-Session-Id": sessionId || "",
          },
          body: offer.sdp,
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("RTC connect failed", res.status, body);
        throw new Error(
          `RTC connect failed (${res.status}) ${body.slice(0, 200)}`
        );
      }
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      setConnecting(false);
    } catch (err) {
      setConnecting(false);
      cleanupRTC();
      console.error("RTC error:", err);
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

      // Final structure pass
      if (transcript.trim()) {
        await streamStructuredNotes(transcript);
      }
      // Optional: second opinion
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
    await startRecording(); // UX only
    await startWebRTC();
  };

  useEffect(() => () => cleanupRTC(), []);

  const isBusy = connecting;
  const isActive = recording || status === "recording" || connected;

  return (
    <>
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
        <span className="mic-pulse-ring" aria-hidden="true" />
        <span className="mic-core" aria-hidden="true">
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
          <span className="mic-led" />
        </span>
      </button>

      {showInlineTranscript && (
        <div
          className={`mic-transcript-hud ${isActive ? "show" : ""}`}
          aria-live="polite"
        >
          <div className="hud-title">
            {isActive ? "Listening…" : noteMarkdown ? "Last Note" : "Ready"}
          </div>
          <div className="hud-body">
            {isActive
              ? transcript || "Start speaking to generate notes…"
              : noteMarkdown || "Press the mic to begin."}
          </div>
        </div>
      )}
    </>
  );
}
