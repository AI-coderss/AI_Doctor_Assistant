/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import "../styles/ChatInputWidget.css";

/** Backend */
const API_BASE = "https://ai-platform-dsah-backend-chatbot.onrender.com";
const SDP_URL = `${API_BASE}/api/rtc-transcribe-connect`;

/**
 * Modes:
 *  - "chat": compact textarea + round button (bottom center)
 *  - "voice": Siri-like overlay with mic orb + canvas visualizer + live transcript
 *
 * Behavior:
 *  - Live transcript renders while speaking (no timer)
 *  - Tap mic (or Enter) again => stop, auto-send transcript, revert to "chat"
 */
const ChatInputWidget = ({ onSendMessage }) => {
  // UI
  const [mode, setMode] = useState("chat");          // "chat" | "voice"
  const [state, setState] = useState("idle");        // "idle" | "connecting" | "recording"

  // Text
  const [inputText, setInputText] = useState("");    // used for both chat input and live transcript

  // WebRTC
  const transcriptionRef = useRef("");
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const dcRef = useRef(null);

  // Textarea autosize
  const textAreaRef = useRef(null);
  const adjustTextAreaHeight = (reset = false) => {
    if (!textAreaRef.current) return;
    textAreaRef.current.style.height = "auto";
    if (!reset) {
      textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
    }
  };
  useEffect(() => adjustTextAreaHeight(), []);

  // ====== Voice visualization (AudioContext + Analyser + Canvas) ======
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const levelRAF = useRef(null);
  const vizRAF = useRef(null);
  const orbRef = useRef(null);
  const canvasRef = useRef(null);
  const freqsRef = useRef(null);

  // Visualization options (adapted from your snippet; dat.GUI removed)
  const vizOptsRef = useRef({
    smoothing: 0.6,
    fft: 9,                // 2^9 = 512 bins (a bit smoother than 256)
    minDecibels: -70,
    amp: 1.2,
    width: 44,
    shift: 34,
    fillOpacity: 0.55,
    lineWidth: 1,
    glow: 12,
    blend: "screen",
    // Brand-aligned colors (you can tweak)
    color1: [45, 92, 240],   // brand blue
    color2: [24, 137, 218],  // lighter blue
    color3: [41, 200, 192],  // teal accent
  });

  // Create AudioContext + Analyser, hook to stream, and start loops
  const startVisualizer = (mediaStream) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(mediaStream);

      // Defaults; will be re-applied in the render loop to allow tweaks
      analyser.fftSize = Math.pow(2, vizOptsRef.current.fft);
      analyser.smoothingTimeConstant = vizOptsRef.current.smoothing;
      analyser.minDecibels = vizOptsRef.current.minDecibels;
      analyser.maxDecibels = 0;

      source.connect(analyser);

      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;
      freqsRef.current = new Uint8Array(analyser.frequencyBinCount);

      // One render loop that:
      // 1) computes a level for the orb scale (from time-domain)
      // 2) draws the canvas spectrum curves (from frequency-domain)
      const timeBuf = new Uint8Array(analyser.frequencyBinCount);

      const render = () => {
        const analyser = analyserRef.current;
        const canvas = canvasRef.current;
        if (!analyser || !canvas) {
          vizRAF.current = requestAnimationFrame(render);
          return;
        }

        // Update analyser params from opts (in case you change them)
        const opts = vizOptsRef.current;
        analyser.smoothingTimeConstant = opts.smoothing;
        analyser.fftSize = Math.pow(2, opts.fft);
        analyser.minDecibels = opts.minDecibels;
        analyser.maxDecibels = 0;

        // --- Level for orb (time domain RMS)
        analyser.getByteTimeDomainData(timeBuf);
        let sum = 0;
        for (let i = 0; i < timeBuf.length; i++) {
          const v = (timeBuf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / timeBuf.length); // ~0..0.5
        const level = Math.min(1, rms * 2.2);
        if (orbRef.current) {
          orbRef.current.style.setProperty("--level", String(level));
        }

        // --- Frequency data for the spectrum curves
        const freqs = freqsRef.current;
        analyser.getByteFrequencyData(freqs);

        // Resize canvas to container (responsive, high-DPI)
        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const W = Math.max(320, Math.min(parent.clientWidth - 24, 1000));
        const H = Math.max(100, Math.min(220, Math.floor(W * 0.22))); // aspect

        if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          canvas.style.width = `${W}px`;
          canvas.style.height = `${H}px`;
        }

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        // Draw three curves like your example
        const shuffle = [1, 3, 0, 4, 2];
        const mid = H / 2;

        const freqAt = (channel, i) => {
          const band = 2 * channel + shuffle[i] * 6;
          return freqs[Math.min(band, freqs.length - 1)];
        };
        const scaleAt = (i) => {
          const x = Math.abs(2 - i);      // 2,1,0,1,2
          const s = 3 - x;                // 1,2,3,2,1
          return (s / 3) * opts.amp;
        };

        const path = (channel) => {
          const color = opts[`color${channel + 1}`];
          const offset = (W - 15 * opts.width) / 2;
          const x = Array.from({ length: 15 }, (_, i) => offset + channel * opts.shift + i * opts.width);
          const y = Array.from({ length: 5 }, (_, i) => Math.max(0, mid - scaleAt(i) * freqAt(channel, i)));
          const h = 2 * mid;

          ctx.save();
          ctx.globalCompositeOperation = opts.blend;
          ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opts.fillOpacity})`;
          ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
          ctx.shadowColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
          ctx.lineWidth = opts.lineWidth;
          ctx.shadowBlur = opts.glow;

          ctx.beginPath();
          ctx.moveTo(0, mid);
          ctx.lineTo(x[0], mid + 1);

          ctx.bezierCurveTo(x[1], mid + 1, x[2], y[0], x[3], y[0]);
          ctx.bezierCurveTo(x[4], y[0], x[4], y[1], x[5], y[1]);
          ctx.bezierCurveTo(x[6], y[1], x[6], y[2], x[7], y[2]);
          ctx.bezierCurveTo(x[8], y[2], x[8], y[3], x[9], y[3]);
          ctx.bezierCurveTo(x[10], y[3], x[10], y[4], x[11], y[4]);

          ctx.bezierCurveTo(x[12], y[4], x[12], mid, x[13], mid);

          ctx.lineTo(W, mid + 1);
          ctx.lineTo(x[13], mid - 1);

          ctx.bezierCurveTo(x[12], mid, x[12], h - y[4], x[11], h - y[4]);
          ctx.bezierCurveTo(x[10], h - y[4], x[10], h - y[3], x[9], h - y[3]);
          ctx.bezierCurveTo(x[8], h - y[3], x[8], h - y[2], x[7], h - y[2]);
          ctx.bezierCurveTo(x[6], h - y[2], x[6], h - y[1], x[5], h - y[1]);
          ctx.bezierCurveTo(x[4], h - y[1], x[4], h - y[0], x[3], h - y[0]);
          ctx.bezierCurveTo(x[2], h - y[0], x[1], mid, x[0], mid);

          ctx.lineTo(0, mid);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        };

        path(0);
        path(1);
        path(2);

        vizRAF.current = requestAnimationFrame(render);
      };

      // kick off loop
      vizRAF.current = requestAnimationFrame(render);

      // handle resize
      const onResize = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        if (!parent) return;
        const W = Math.max(320, Math.min(parent.clientWidth - 24, 1000));
        const H = Math.max(100, Math.min(220, Math.floor(W * 0.22)));
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
      };
      window.addEventListener("resize", onResize);
      onResize();

    } catch (e) {
      console.warn("[voice-ui] Visualizer unavailable:", e);
    }
  };

  const stopVisualizer = async () => {
    try { if (vizRAF.current) cancelAnimationFrame(vizRAF.current); } catch {}
    vizRAF.current = null;
    try { if (levelRAF.current) cancelAnimationFrame(levelRAF.current); } catch {}
    levelRAF.current = null;
    if (orbRef.current) orbRef.current.style.setProperty("--level", "0");

    try { await audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;

    // clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
    }
  };

  // ====== WebRTC helpers ======
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

  // Realtime message handler — updates live transcript immediately
  const handleTranscriptEvent = (evt) => {
    try {
      const raw = typeof evt.data === "string" ? evt.data : "";
      if (!raw) return;
      const msg = JSON.parse(raw);

      if (msg.type === "input_audio_transcription.delta" || msg.type === "transcription.delta") {
        const t = msg.delta?.text || msg.text || "";
        if (t) {
          const preview = (transcriptionRef.current + " " + t).trim();
          setInputText(preview);          // LIVE render
        }
      }

      if (
        msg.type === "input_audio_transcription.completed" ||
        msg.type === "transcription.completed" ||
        msg.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const t = msg.transcript?.text || msg.transcript || msg.text || "";
        if (t) {
          transcriptionRef.current = (transcriptionRef.current + " " + t).trim();
          setInputText(transcriptionRef.current);    // LIVE render
        }
      }
    } catch {
      /* ignore non-JSON frames */
    }
  };

  // Begin voice capture + realtime
  const startLiveTranscription = async () => {
    if (state !== "idle") return;

    // Switch UI first (immediate feedback)
    setMode("voice");
    setState("connecting");
    setInputText("");
    transcriptionRef.current = "";

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      });
      pcRef.current = pc;

      // Client data channel for events
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

      // Start visualizer (uses same stream)
      startVisualizer(stream);

      // Single sender (sendonly)
      const [track] = stream.getAudioTracks();
      const tx = pc.addTransceiver("audio", { direction: "sendonly" });
      await tx.sender.replaceTrack(track);

      // SDP round trip
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
      await teardownRTC();
      setMode("chat");
      setState("idle");
    }
  };

  // Stop, auto-send, revert UI
  const stopAndSend = async () => {
    const text = (transcriptionRef.current || inputText || "").trim();
    await teardownRTC();
    setMode("chat");
    setState("idle");

    if (text) {
      onSendMessage?.({ text });
      setInputText("");
      transcriptionRef.current = "";
      adjustTextAreaHeight(true);
    }
  };

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

  // Chat input handlers
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    adjustTextAreaHeight();
  };

  const handleKeyDown = async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mode === "voice" && (state === "recording" || state === "connecting")) {
        await stopAndSend();
      } else if (inputText.trim()) {
        onSendMessage?.({ text: inputText.trim() });
        setInputText("");
        transcriptionRef.current = "";
        adjustTextAreaHeight(true);
      }
    }
  };

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

  // Cleanup on unmount
  useEffect(() => {
    return () => { teardownRTC(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ====== RENDER ======
  if (mode === "voice") {
    return (
      <div className={`voice-overlay ${state}`} role="region" aria-label="Voice input">
        {/* Canvas visualization (behind mic) */}
        <canvas ref={canvasRef} className="voice-canvas" aria-hidden />

        {/* Live transcript (updates continuously) */}
        <div className="voice-live-text" aria-live="polite">
          {inputText || "Listening…"}
        </div>

        {/* Mic orb (voice level animates via --level) */}
        <button
          ref={orbRef}
          className={`voice-mic ${state}`}
          onClick={handleIconClick}
          aria-label="Stop and send"
          title="Stop and send"
        >
          <MicIcon className="voice-mic-icon" />
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="ring r3" />
        </button>
      </div>
    );
  }

  // CHAT MODE
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
