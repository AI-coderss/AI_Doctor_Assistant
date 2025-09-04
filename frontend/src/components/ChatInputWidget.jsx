/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import StopIcon from "@mui/icons-material/Stop";
import "../styles/ChatInputWidget.css";

/** Backend */
const API_BASE = "https://ai-platform-dsah-backend-chatbot.onrender.com";
const SDP_URL = `${API_BASE}/api/rtc-transcribe-connect`;

/**
 * Siri-like behavior:
 * - Normal mode: compact textarea + round button on the right
 * - Voice mode: the entire widget morphs into a centered mic orb with a live visualizer
 * - Press again (or Enter) to stop → auto-send transcript → revert to normal mode
 */
const ChatInputWidget = ({ onSendMessage }) => {
  // UI modes
  const [mode, setMode] = useState("chat");         // "chat" | "voice"
  const [state, setState] = useState("idle");       // "idle" | "connecting" | "recording"

  // Text state
  const [inputText, setInputText] = useState("");

  // Refs
  const textAreaRef = useRef(null);
  const transcriptionRef = useRef("");
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const dcRef = useRef(null);

  // WebAudio visualizer
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const levelRAF = useRef(null);
  const levelRef = useRef(0);         // 0..1
  const orbRef = useRef(null);        // for CSS updates

  const isRecording = state === "recording" || state === "connecting";

  /** Autosize input */
  const adjustTextAreaHeight = (reset = false) => {
    if (!textAreaRef.current) return;
    textAreaRef.current.style.height = "auto";
    if (!reset) {
      textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
    }
  };
  useEffect(() => adjustTextAreaHeight(), []);

  /** Live visualizer from mic → CSS variable on the orb */
  const startVisualizer = (mediaStream) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;

      const source = audioCtx.createMediaStreamSource(mediaStream);
      source.connect(analyser);

      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const buf = new Uint8Array(analyser.frequencyBinCount);

      const loop = () => {
        analyser.getByteTimeDomainData(buf);
        // Compute RMS-ish level 0..1
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length); // 0..~0.5
        const level = Math.min(1, rms * 2.2); // boost a bit

        levelRef.current = level;
        if (orbRef.current) {
          orbRef.current.style.setProperty("--level", String(level));
        }

        levelRAF.current = requestAnimationFrame(loop);
      };
      levelRAF.current = requestAnimationFrame(loop);
    } catch (e) {
      // visualizer is optional; ignore failures gracefully
      console.warn("[voice-ui] Visualizer disabled:", e);
    }
  };

  const stopVisualizer = async () => {
    try { if (levelRAF.current) cancelAnimationFrame(levelRAF.current); } catch {}
    levelRAF.current = null;
    levelRef.current = 0;
    if (orbRef.current) {
      orbRef.current.style.setProperty("--level", "0");
    }
    try {
      await audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;
  };

  /** Wait for ICE gather */
  const waitForIceGatheringComplete = (pc) =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }, 3000);
    });

  /** Handle Realtime frames (update text) */
  const handleTranscriptEvent = (evt) => {
    try {
      const raw = typeof evt.data === "string" ? evt.data : "";
      if (!raw) return;
      const msg = JSON.parse(raw);

      // partials
      if (msg.type === "input_audio_transcription.delta" || msg.type === "transcription.delta") {
        const t = msg.delta?.text || msg.text || "";
        if (t) {
          const preview = (transcriptionRef.current + " " + t).trim();
          setInputText(preview);
          adjustTextAreaHeight();
        }
      }

      // completions
      if (
        msg.type === "input_audio_transcription.completed" ||
        msg.type === "transcription.completed" ||
        msg.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const t = msg.transcript?.text || msg.transcript || msg.text || "";
        if (t) {
          transcriptionRef.current = (transcriptionRef.current + " " + t).trim();
          setInputText(transcriptionRef.current);
          adjustTextAreaHeight();
        }
      }
    } catch { /* ignore non-JSON */ }
  };

  /** Start voice mode + WebRTC */
  const startLiveTranscription = async () => {
    if (state !== "idle") return;

    // Switch UI first (instant feedback)
    setMode("voice");
    setState("connecting");

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      });
      pcRef.current = pc;

      // Client data channel to ensure we get events
      const dc = pc.createDataChannel("oai-events", { ordered: true });
      dcRef.current = dc;
      dc.onmessage = handleTranscriptEvent;

      // Accept server-initiated too
      pc.ondatachannel = (event) => {
        if (event.channel?.label === "oai-events") {
          event.channel.onmessage = handleTranscriptEvent;
        }
      };

      // Mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // Visualizer
      startVisualizer(stream);

      // Single sender (sendonly)
      const [track] = stream.getAudioTracks();
      const tx = pc.addTransceiver("audio", { direction: "sendonly" });
      await tx.sender.replaceTrack(track);

      // SDP round-trip
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      const resp = await fetch(SDP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", "Cache-Control": "no-cache" },
        body: pc.localDescription.sdp,
      });

      const body = await resp.text();
      if (!resp.ok || !body.startsWith("v=")) {
        throw new Error("SDP exchange failed or non-SDP answer");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: body });
      setState("recording");
    } catch (err) {
      // Cleanup on failure and revert UI
      await teardownRTC();
      setMode("chat");
      setState("idle");
    }
  };

  /** Stop + auto-send + revert UI */
  const stopAndSend = async () => {
    // Grab transcript before teardown
    const text = (transcriptionRef.current || inputText || "").trim();

    await teardownRTC();

    // Reset UI
    setMode("chat");
    setState("idle");

    if (text) {
      onSendMessage?.({ text });
      setInputText("");
      transcriptionRef.current = "";
      adjustTextAreaHeight(true);
    }
  };

  /** RTC teardown */
  const teardownRTC = async () => {
    try { pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    try { dcRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    await stopVisualizer();
  };

  /** Input handlers (chat mode) */
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    adjustTextAreaHeight();
  };

  /** Enter behavior */
  const handleKeyDown = async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mode === "voice" && isRecording) {
        await stopAndSend();
      } else if (inputText.trim()) {
        onSendMessage?.({ text: inputText.trim() });
        setInputText("");
        transcriptionRef.current = "";
        adjustTextAreaHeight(true);
      } else if (mode === "chat" && state === "idle") {
        // nothing
      }
    }
  };

  /** Main button in chat mode */
  const handleIconClick = async () => {
    if (mode === "chat") {
      if (inputText.trim()) {
        onSendMessage?.({ text: inputText.trim() });
        setInputText("");
        transcriptionRef.current = "";
        adjustTextAreaHeight(true);
        return;
      }
      await startLiveTranscription();
    } else {
      // voice mode: tap to stop & auto-send
      await stopAndSend();
    }
  };

  /** Cleanup on unmount */
  useEffect(() => {
    return () => { teardownRTC(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** RENDER */
  if (mode === "voice") {
    // VOICE OVERLAY (replaces the input while active)
    return (
      <div className={`voice-overlay ${state}`} role="region" aria-label="Voice input">
        <button
          ref={orbRef}
          className={`voice-mic ${state}`}
          onClick={handleIconClick}
          aria-label="Stop and send"
          title="Stop and send"
        >
          {/* A single icon; orb animates by voice level */}
          <MicIcon className="voice-mic-icon" />
          {/* decorative rings */}
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="ring r3" />
        </button>
      </div>
    );
  }

  // CHAT MODE (default)
  return (
    <div className={`chat-container ${state}`}>
      <textarea
        ref={textAreaRef}
        className="chat-input"
        placeholder="Chat in text or start speaking..."
        value={inputText}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        rows={1}
        style={{ resize: "none", overflow: "hidden" }}
      />

      <button
        className={`icon-btn ${state} ${inputText.trim() ? "will-send" : ""}`}
        onClick={handleIconClick}
        aria-label={
          inputText.trim()
            ? "Send"
            : state === "connecting"
            ? "Connecting"
            : "Start recording"
        }
        title={
          inputText.trim()
            ? "Send"
            : state === "connecting"
            ? "Connecting"
            : "Start recording"
        }
      >
        {inputText.trim().length > 0 ? (
          <SendIcon className="icon i-send" />
        ) : state === "connecting" ? (
          <span className="spinner" aria-hidden />
        ) : (
          <MicIcon className="icon i-mic" />
        )}
      </button>
    </div>
  );
};

export default ChatInputWidget;
