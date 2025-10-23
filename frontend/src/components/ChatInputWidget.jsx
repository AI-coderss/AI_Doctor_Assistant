/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useReactMediaRecorder } from "react-media-recorder";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import "../styles/ChatInputWidget.css";
import WidgetWave from "../components/WidgetWave";
import Loader from "../components/Loader"; // ✅ Replaces ParticlesOrb loader

/** === Endpoint === */
const TRANSCRIBE_URL = "https://test-medic-transcriber-latest.onrender.com/transcribe";
const TRANSCRIBE_FIELD_NAME = "audio_data";

/** === MIME helpers === */
const MIME_PREFS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/wav",
];

const pickSupportedMime = () => {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  for (const t of MIME_PREFS) {
    try {
      if (window.MediaRecorder.isTypeSupported(t)) return t;
    } catch {}
  }
  return "";
};

const mimeToExt = (m) => {
  const x = (m || "").toLowerCase();
  if (x.startsWith("audio/webm")) return "webm";
  if (x === "audio/mp4" || x === "video/mp4") return "m4a";
  if (x === "audio/mpeg" || x === "audio/mp3") return "mp3";
  if (x === "audio/wav" || x === "audio/x-wav") return "wav";
  if (x === "audio/ogg" || x === "audio/oga") return "ogg";
  return "webm";
};

const hasAudio = (ms) => !!(ms && ms.getAudioTracks && ms.getAudioTracks().length > 0);

const ChatInputWidget = ({ onSendMessage }) => {
  /** ====== State management ====== */
  const [mode, setMode] = useState("chat"); // "chat" | "voice"
  const [phase, setPhase] = useState("idle"); // "idle" | "recording" | "transcribing"

  const [inputText, setInputText] = useState("");
  const textAreaRef = useRef(null);
  const adjustTextAreaHeight = (reset = false) => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (!reset) el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => adjustTextAreaHeight(), []);

  /** ====== Timer ====== */
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerIdRef = useRef(null);
  const timerStartRef = useRef(null);

  const startTimer = () => {
    stopTimer();
    timerStartRef.current = Date.now();
    setElapsedMs(0);
    timerIdRef.current = setInterval(() => setElapsedMs(Date.now() - timerStartRef.current), 1000);
  };

  const stopTimer = () => {
    try {
      clearInterval(timerIdRef.current);
    } catch {}
    timerIdRef.current = null;
  };

  const fmt = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  /** ====== Recorder ====== */
  const chosenMime = useMemo(() => pickSupportedMime(), []);
  const { status, startRecording, stopRecording, mediaBlobUrl, previewStream, clearBlobUrl, error } =
    useReactMediaRecorder({
      audio: true,
      mediaRecorderOptions: chosenMime ? { mimeType: chosenMime } : undefined,
    });

  const [vizStream, setVizStream] = useState(null);
  const orbRef = useRef(null);
  const sfxRef = useRef(null);

  useEffect(() => {
    const el = new Audio("/assistant.mb3");
    el.preload = "auto";
    el.volume = 0.6;
    sfxRef.current = el;
    return () => {
      try {
        el.pause();
      } catch {}
    };
  }, []);

  const activeStream = useMemo(() => {
    if (hasAudio(previewStream)) return previewStream;
    if (hasAudio(vizStream)) return vizStream;
    return null;
  }, [previewStream, vizStream]);

  /** ====== Start recording ====== */
  const handleStartRecording = useCallback(async () => {
    try {
      try {
        if (sfxRef.current) {
          sfxRef.current.currentTime = 0;
          await sfxRef.current.play();
        }
      } catch {
        const alt = new Audio("/assistant.mp3");
        alt.preload = "auto";
        alt.volume = 0.6;
        sfxRef.current = alt;
        alt.currentTime = 0;
        await alt.play();
      }

      setMode("voice");
      setPhase("recording");
      startTimer();

      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      setVizStream(s);

      await startRecording();
    } catch (e) {
      console.error("[record] start failed:", e);
      setPhase("idle");
      setMode("chat");
      stopTimer();
      try {
        vizStream?.getTracks().forEach((t) => t.stop());
      } catch {}
      setVizStream(null);
    }
  }, [startRecording]);

  /** ====== Stop recording ====== */
  const handleStopRecording = useCallback(async () => {
    try {
      setPhase("transcribing");
      stopTimer();
      await stopRecording();
    } catch (e) {
      console.error("[record] stop failed:", e);
      setPhase("idle");
      setMode("chat");
      try {
        vizStream?.getTracks().forEach((t) => t.stop());
      } catch {}
      setVizStream(null);
    }
  }, [stopRecording, vizStream]);

  /** ====== Upload to backend ====== */
  useEffect(() => {
    const go = async () => {
      if (!mediaBlobUrl || phase !== "transcribing") return;
      try {
        const blob = await (await fetch(mediaBlobUrl)).blob();
        const type = blob.type || chosenMime || "audio/webm";
        const ext = mimeToExt(type);
        const form = new FormData();
        form.append(TRANSCRIBE_FIELD_NAME, blob, `recording.${ext}`);

        const res = await fetch(TRANSCRIBE_URL, { method: "POST", body: form });
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) throw new Error(bodyText || `HTTP ${res.status}`);

        let transcript = "";
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const j = JSON.parse(bodyText);
            transcript = (j?.transcript || j?.text || "").trim();
          } else transcript = (bodyText || "").trim();
        } catch {
          transcript = (bodyText || "").trim();
        }

        if (transcript) {
          setInputText((prev) => {
            const merged =
              prev && !prev.endsWith(" ") ? `${prev} ${transcript}` : prev + transcript;
            requestAnimationFrame(adjustTextAreaHeight);
            return merged;
          });
        }
      } catch (e) {
        console.error("[transcribe error]", e);
      } finally {
        clearBlobUrl?.();
        try {
          vizStream?.getTracks().forEach((t) => t.stop());
        } catch {}
        setVizStream(null);
        setMode("chat");
        setPhase("idle");
      }
    };
    go();
  }, [mediaBlobUrl, phase, chosenMime, clearBlobUrl, vizStream]);

  /** ====== Keyboard + send ====== */
  const handleSend = () => {
    const v = (inputText || "").trim();
    if (!v) return;
    onSendMessage?.({ text: v });
    setInputText("");
    adjustTextAreaHeight(true);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if ((inputText || "").trim()) handleSend();
    }
  };

  const handleMicClick = async () => {
    if (mode === "chat") await handleStartRecording();
    else if (phase === "recording") await handleStopRecording();
  };

  /** ====== Cleanup ====== */
  useEffect(() => {
    return () => {
      stopTimer();
      try {
        vizStream?.getTracks().forEach((t) => t.stop());
      } catch {}
      setVizStream(null);
    };
  }, []);

  /* ======================= RENDER ======================= */
  if (mode === "voice") {
    const isRecording = phase === "recording";
    const isTranscribing = phase === "transcribing";

    return (
      <div className="voice-layer" role="region" aria-label="Voice input">
        <div
          className={`voice-card ${isRecording ? "recording" : ""}`}
          style={{
            display: "grid",
            gridTemplateRows: "auto auto auto",
            justifyItems: "center",
            gap: 8,
          }}
        >
          {isTranscribing ? (
            /** ✅ New Lottie loader centered */
            <div className="transcribe-loader-wrap">
              <Loader isLoading />
            </div>
          ) : (
            <>
              <button
                ref={orbRef}
                className={`voice-mic ${isRecording ? "recording" : ""}`}
                onClick={handleMicClick}
                aria-label={isRecording ? "Stop" : "Start"}
                title={isRecording ? "Stop" : "Start"}
                disabled={isTranscribing}
              >
                <MicIcon className="voice-mic-icon" />
                <span className="ring r1" />
                <span className="ring r2" />
                <span className="ring r3" />
              </button>

              <div
                className="wave-slot"
                style={{
                  width: "min(460px, 92%)",
                  height: 150,
                  marginTop: 4,
                  marginBottom: 6,
                  pointerEvents: "none",
                }}
              >
                <WidgetWave
                  stream={activeStream}
                  height={150}
                  layers={12}
                  sensitivity={4.2}
                  onLevel={(lvl) => {
                    const boosted = Math.min(1, (lvl || 0) * 1.6);
                    orbRef.current?.style.setProperty("--level", String(boosted));
                  }}
                />
              </div>

              <div className="voice-timer">
                {isRecording ? fmt(elapsedMs) : "00:00:00"}
                {isRecording && <span className="rec-dot" />}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /** ====== Chat mode ====== */
  return (
    <div className="chat-container">
      <textarea
        ref={textAreaRef}
        className="chat-input"
        placeholder="Type here or tap the mic…"
        value={inputText}
        onChange={(e) => {
          setInputText(e.target.value);
          adjustTextAreaHeight();
        }}
        onKeyDown={handleKeyDown}
        rows={1}
        style={{ resize: "none", overflow: "hidden" }}
      />
      <button
        className="icon-btn"
        onClick={() =>
          (inputText || "").trim() ? handleSend() : handleMicClick()
        }
      >
        {(inputText || "").trim() ? <SendIcon /> : <MicIcon />}
      </button>
    </div>
  );
};

export default ChatInputWidget;








