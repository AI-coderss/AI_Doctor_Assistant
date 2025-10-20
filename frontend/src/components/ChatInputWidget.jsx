/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState, useCallback } from "react";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import StopIcon from "@mui/icons-material/Stop";
import "../styles/ChatInputWidget.css";

// Your backend endpoint:
const BACKEND_TRANSCRIBE_URL =
  "https://ai-doctor-assistant-backend-server.onrender.com/transcribe";

// Keep this tiny: pick a sane MIME and map to an extension
const pickMime = () => {
  const prefs = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  for (const t of prefs) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return ""; // let browser choose
};

const mimeToExt = (m) => {
  const mime = (m || "").toLowerCase();
  if (mime.startsWith("audio/webm")) return "webm";
  if (mime === "audio/mp4" || mime === "video/mp4") return "mp4";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/ogg" || mime === "audio/oga") return "ogg";
  return "webm";
};

const ChatInputWidget = ({ onSendMessage, inputText, setInputText }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [err, setErr] = useState(null);

  const textAreaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const chosenMimeRef = useRef("");

  const adjustTextAreaHeight = (reset = false) => {
    if (!textAreaRef.current) return;
    textAreaRef.current.style.height = "auto";
    if (!reset)
      textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
  };

  useEffect(() => {
    adjustTextAreaHeight();
  }, []);

  const startRecording = useCallback(async () => {
    setErr(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      streamRef.current = stream;

      const mime = pickMime();
      chosenMimeRef.current = mime;
      const mr = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined
      );
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        try {
          const finalMime =
            mr.mimeType ||
            chosenMimeRef.current ||
            chunksRef.current[0]?.type ||
            "audio/webm";
          const blob = new Blob(chunksRef.current, { type: finalMime });
          chunksRef.current = [];
          const ext = mimeToExt(finalMime);
          await transcribeBlob(blob, ext);
        } catch (e) {
          setErr("Failed to process recording.");
        } finally {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          setIsRecording(false);
        }
      };

      mr.start(250);
      setIsRecording(true);
    } catch {
      setErr("Microphone permission denied or unavailable.");
      setIsRecording(false);
    }
  }, []);

  const stopRecording = useCallback(() => {
    try {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
    } catch {}
  }, []);

  const transcribeBlob = useCallback(
    async (blob, ext) => {
      setIsLoading(true);
      setErr(null);
      try {
        const form = new FormData();
        // FIELD NAME MUST BE 'audio_data' to match your backend
        form.append("audio_data", blob, `recording.${ext || "webm"}`);
        const res = await fetch(BACKEND_TRANSCRIBE_URL, {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        const newText = (data?.transcript || "").trim();
        setInputText((prev = "") => {
          const merged = prev
            ? `${prev}${prev.endsWith(" ") ? "" : " "}${newText}`
            : newText;
          requestAnimationFrame(adjustTextAreaHeight);
          return merged;
        });
      } catch (e) {
        setErr("Transcription failed. Please try again.");
      } finally {
        setIsLoading(false);
      }
    },
    [setInputText]
  );

  const handleSendMessage = () => {
    const val = (inputText || "").trim();
    if (val) {
      onSendMessage?.({ text: val });
      setInputText("");
      adjustTextAreaHeight(true);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if ((inputText || "").trim()) handleSendMessage();
    }
  };

  const handleIconClick = () => {
    if ((inputText || "").trim()) {
      handleSendMessage();
    } else {
      isRecording ? stopRecording() : startRecording();
    }
  };

  return (
    <div className="chat-container">
      {isLoading && (
        <div className="loader-overlay">
          <div className="loader-card">
            <div className="spinner" />
            <div className="loader-text">Transcribing…</div>
          </div>
        </div>
      )}

      <textarea
        ref={textAreaRef}
        className="chat-input"
        placeholder={
          isRecording
            ? "Recording… press stop when done"
            : "Chat in text or start speaking..."
        }
        value={inputText || ""}
        onChange={(e) => {
          setInputText(e.target.value);
          adjustTextAreaHeight();
        }}
        onKeyDown={handleKeyDown}
        rows={1}
        style={{ resize: "none", overflow: "hidden" }}
        disabled={isLoading}
      />

      <button
        className="icon-btn"
        onClick={handleIconClick}
        disabled={isLoading}
      >
        {(inputText || "").trim() ? (
          <SendIcon />
        ) : isRecording ? (
          <StopIcon />
        ) : (
          <MicIcon />
        )}
      </button>

      {err && <div className="chat-error">{err}</div>}
    </div>
  );
};

export default ChatInputWidget;

