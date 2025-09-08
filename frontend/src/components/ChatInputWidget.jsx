/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import "../styles/ChatInputWidget.css";
import useLiveTranscriptStore from "../store/useLiveTranscriptStore";

/** Backend */
const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const SDP_URL = `${API_BASE}/api/rtc-transcribe-connect`;

/**
 * Modes:
 *  - "chat": compact textarea + round button (bottom center)
 *  - "voice": Siri-like overlay with mic orb + canvas visualizer
 *
 * Behavior:
 *  - Live transcript is written only to the Zustand store (no text in overlay).
 *  - The RTC session STAYS OPEN while you are speaking; it will NOT auto-stop
 *    on interim `*.completed` events from the server.
 *  - An on-device VAD (RMS-based) detects sustained silence and FINALIZES the
 *    current utterance automatically, sending it via onSendMessage({ skipEcho:true }).
 *  - After sending, we reset the store for the next utterance and KEEP LISTENING.
 *  - You can still press the mic again to stop the session entirely.
 */
const ChatInputWidget = ({ onSendMessage }) => {
  // UI
  const [mode, setMode] = useState("chat");          // "chat" | "voice"
  const [state, setState] = useState("idle");        // "idle" | "connecting" | "recording"
  const isBusy = state === "recording" || state === "connecting";

  // Textarea for typed messages only
  const [inputText, setInputText] = useState("");

  // Store (live transcript to Chat.jsx)
  const liveStore = useLiveTranscriptStore();

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
    if (!reset) textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
  };
  useEffect(() => adjustTextAreaHeight(), []);

  // ===== Personalized Medicine Submit Guard (typed only) =====
  const isPmodeOn = () => {
    try { return localStorage.getItem("pmode") === "1"; } catch { return false; }
  };
  const guardedSend = (text) => {
    // Single place to honor PM toggle for typed messages.
    // Chat.jsx already enforces the full PM flow in handleNewMessage.
    onSendMessage?.({ text });
  };

  // ====== Voice visualization (AudioContext + Analyser + Canvas) + VAD ======
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const vizRAF = useRef(null);
  const orbRef = useRef(null);
  const canvasRef = useRef(null);
  const freqsRef = useRef(null);

  // VAD controls
  const lastVoiceTsRef = useRef(0);
  const speakingRef = useRef(false);
  const sentThisUtteranceRef = useRef(false); // prevents duplicate sends per utterance

  // Tunables (adjust as needed)
  const VAD_THRESHOLD_RMS = 0.03;   // speech if RMS >= this
  const VAD_MIN_SILENCE_MS = 1100;  // finalize if silence sustained this long
  const UTTERANCE_MIN_CHARS = 4;    // don't send super-short noise

  const vizOptsRef = useRef({
    smoothing: 0.6,
    fft: 9,
    minDecibels: -75,
    amp: 0.75,
    width: 32,
    shift: 18,
    fillOpacity: 0.50,
    lineWidth: 1,
    glow: 8,
    blend: "screen",
    color1: [45, 92, 240],
    color2: [24, 137, 218],
    color3: [41, 200, 192],
  });

  const finalizeAndSendUtterance = async () => {
    const finalText = String(useLiveTranscriptStore.getState().text || "").trim();
    if (finalText.length >= UTTERANCE_MIN_CHARS) {
      onSendMessage?.({ text: finalText, skipEcho: true }); // avoid duplicate "me" bubbles
    }
    // Prepare for next utterance without closing RTC
    transcriptionRef.current = "";
    sentThisUtteranceRef.current = true;   // block repeated sends until speech resumes
    liveStore.newUtterance();              // reset text & bump utterance sequence
  };

  const startVisualizer = (mediaStream) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(mediaStream);

      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;
      analyser.fftSize = Math.pow(2, vizOptsRef.current.fft);
      analyser.smoothingTimeConstant = vizOptsRef.current.smoothing;
      analyser.minDecibels = vizOptsRef.current.minDecibels;
      analyser.maxDecibels = 0;
      freqsRef.current = new Uint8Array(analyser.frequencyBinCount);
      const timeBuf = new Uint8Array(analyser.frequencyBinCount);

      const render = () => {
        const analyser = analyserRef.current;
        const canvas = canvasRef.current;
        if (!analyser || !canvas) {
          vizRAF.current = requestAnimationFrame(render);
          return;
        }

        // Responsive reduced canvas size
        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const W = Math.max(320, Math.min(parent.clientWidth - 24, 800));
        const H = Math.max(80, Math.min(120, Math.floor(W * 0.16)));

        if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          canvas.style.width = `${W}px`;
          canvas.style.height = `${H}px`;
        }

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        // Orb level + RMS for VAD
        analyser.getByteTimeDomainData(timeBuf);
        let sum = 0;
        for (let i = 0; i < timeBuf.length; i++) {
          const v = (timeBuf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / timeBuf.length);
        const level = Math.min(1, rms * 2);
        if (orbRef.current) orbRef.current.style.setProperty("--level", String(level));

        // === VAD logic ===
        const now = performance.now();
        if (rms >= VAD_THRESHOLD_RMS) {
          // voice detected
          speakingRef.current = true;
          lastVoiceTsRef.current = now;
          if (sentThisUtteranceRef.current) {
            // new utterance is starting (after a send)
            sentThisUtteranceRef.current = false;
          }
        } else {
          // possibly in silence
          const msSinceVoice = now - lastVoiceTsRef.current;
          if (
            speakingRef.current &&
            !sentThisUtteranceRef.current &&
            msSinceVoice >= VAD_MIN_SILENCE_MS &&
            useLiveTranscriptStore.getState().text.trim().length >= UTTERANCE_MIN_CHARS &&
            state === "recording"
          ) {
            // sustained silence after speaking -> finalize utterance
            finalizeAndSendUtterance();
            speakingRef.current = false; // reset; next speech will start a new utterance
          }
        }

        // Frequency curves (visual only)
        const freqs = freqsRef.current;
        analyser.getByteFrequencyData(freqs);

        const opts = vizOptsRef.current;
        const shuffle = [1, 3, 0, 4, 2];
        const mid = H / 2;

        const freqAt = (channel, i) => {
          const band = 2 * channel + shuffle[i] * 6;
          return freqs[Math.min(band, freqs.length - 1)];
        };
        const scaleAt = (i) => {
          const x = Math.abs(2 - i);
          const s = 3 - x;
          return (s / 3) * opts.amp;
        };

        const path = (channel) => {
          const color = opts[`color${channel + 1}`];
          const offset = (W - 15 * opts.width) / 2;
          const x = Array.from({ length: 15 }, (_, i) => offset + channel * opts.shift + i * opts.width);
          const y = Array.from({ length: 5 }, (_, i) => Math.max(0, mid - scaleAt(i) * freqAt(channel, i)));
          const h = 2 * mid;

          const ctx = canvas.getContext("2d");
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

        path(0); path(1); path(2);
        vizRAF.current = requestAnimationFrame(render);
      };

      vizRAF.current = requestAnimationFrame(render);
      const onResize = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const W = Math.max(320, Math.min(parent.clientWidth - 24, 800));
        const H = Math.max(80, Math.min(120, Math.floor(W * 0.16)));
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      };
      window.addEventListener("resize", onResize);
      onResize();
    } catch (e) {
      console.warn("[voice-ui] Visualizer/VAD unavailable:", e);
    }
  };

  const stopVisualizer = async () => {
    try { if (vizRAF.current) cancelAnimationFrame(vizRAF.current); } catch {}
    vizRAF.current = null;
    if (orbRef.current) orbRef.current.style.setProperty("--level", "0");
    try { await audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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

  // Manual stop (user presses mic again): send any residual text and teardown
  const manualStopAndSend = async () => {
    const text = String(useLiveTranscriptStore.getState().text || "").trim();
    await teardownRTC();
    useLiveTranscriptStore.getState().endSession(); // active=false
    setMode("chat");
    setState("idle");

    if (text) {
      onSendMessage?.({ text, skipEcho: true });
    }
    transcriptionRef.current = "";
    speakingRef.current = false;
    sentThisUtteranceRef.current = false;
  };

  // Realtime message handler — writes to the store for Chat.jsx
  const handleTranscriptEvent = (evt) => {
    try {
      const raw = typeof evt.data === "string" ? evt.data : "";
      if (!raw) return;
      const msg = JSON.parse(raw);

      // Deltas → append to store (Live bubble updates in Chat.jsx)
      if (msg.type === "input_audio_transcription.delta" || msg.type === "transcription.delta") {
        const t = msg.delta?.text || msg.text || "";
        if (t) {
          liveStore.appendDelta(t);
        }
      }

      // Completed utterances → merge into local rolling transcript (no stop)
      if (
        msg.type === "input_audio_transcription.completed" ||
        msg.type === "transcription.completed" ||
        msg.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const t = msg.transcript?.text || msg.transcript || msg.text || "";
        if (t) {
          transcriptionRef.current = (transcriptionRef.current + " " + t).trim();
          // Keep the UI showing the most complete text so far
          liveStore.setFull(transcriptionRef.current);
        }
      }
    } catch {
      /* ignore non-JSON frames */
    }
  };

  // Begin voice capture + realtime (stays active until manual stop; VAD auto-sends per utterance)
  const startLiveTranscription = async () => {
    if (isBusy) return;

    setMode("voice");
    setState("connecting");
    transcriptionRef.current = "";
    speakingRef.current = false;
    sentThisUtteranceRef.current = false;
    liveStore.startSession(); // active=true, text="", utteranceSeq reset/incremented

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      });
      pcRef.current = pc;

      // Set up app data channel (events from server)
      const dc = pc.createDataChannel("oai-events", { ordered: true });
      dcRef.current = dc;
      dc.onmessage = handleTranscriptEvent;
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

      // Visualizer + VAD loop
      startVisualizer(stream);

      // Sender
      const [track] = stream.getAudioTracks();
      const tx = pc.addTransceiver("audio", { direction: "sendonly" });
      await tx.sender.replaceTrack(track);

      // SDP
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
      setState("recording"); // stay recording; VAD handles utterance boundaries
    } catch (err) {
      await teardownRTC();
      liveStore.endSession();
      setMode("chat");
      setState("idle");
    }
  };

  // Stop → manual (button/Enter) only
  const stopOnly = async () => {
    await manualStopAndSend();
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

  // Chat input (typed) handlers — now routed via guardedSend
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    adjustTextAreaHeight();
  };

  const handleKeyDown = async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mode === "voice" && isBusy) {
        // In voice mode, Enter acts as manual stop → send residual text
        await stopOnly();
      } else if (inputText.trim()) {
        // Submit path uses guard (respects Personalized toggle)
        guardedSend(inputText.trim());
        setInputText("");
        adjustTextAreaHeight(true);
      }
    }
  };

  const handleIconClick = async () => {
    if (mode === "chat") {
      if (inputText.trim()) {
        // Submit path uses guard (respects Personalized toggle)
        guardedSend(inputText.trim());
        setInputText("");
        adjustTextAreaHeight(true);
        return;
      }
      await startLiveTranscription(); // start and STAY recording; VAD will auto-send utterances
    } else {
      // voice mode: tap → manual stop (finalize + send)
      await stopOnly();
    }
  };

  // Cleanup
  useEffect(() => {
    return () => { teardownRTC(); };
  }, []);

  // ====== RENDER ======
  if (mode === "voice") {
    return (
      <div className={`voice-overlay ${state}`} role="region" aria-label="Voice input">
        {/* Canvas visualization (reduced size) */}
        <canvas ref={canvasRef} className="voice-canvas" aria-hidden />

        {/* Overlay text shows status ONLY (no transcript here) */}
        <div className="voice-live-text" aria-live="polite">
          {state === "connecting" ? "Connecting…" : "Listening…"}
        </div>

        {/* Mic orb (voice level animates via --level) */}
        <button
          ref={orbRef}
          className={`voice-mic ${state}`}
          onClick={handleIconClick}
          aria-label="Stop"
          title="Stop"
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






