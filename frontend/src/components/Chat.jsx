/* eslint-disable no-useless-escape */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable no-loop-func */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useState, useEffect, useRef } from "react";
import ChatInputWidget from "./ChatInputWidget.jsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid.jsx";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt } from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import "../styles/chat.css";
import { encodeWAV } from "./pcmToWav.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";
import VoiceRecorderPanel from "./VoiceRecorderPanel";
import useLiveTranscriptStore from "../store/useLiveTranscriptStore";
import LabResultsUploader from "./LabResultsUploader";

import { Howl } from "howler";

let localStream;
const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

/** === Simple end-of-stream Markdown normalization ===
 * - Remove exact consecutive duplicate lines
 * - Collapse >1 blank line to a single blank line
 * - Normalize list bullets and numbered items
 */
function normalizeMarkdown(input = "") {
  const lines = String(input).split(/\r?\n/);

  const out = [];
  let prev = "";
  for (let raw of lines) {
    let line = raw.replace(/\s+$/g, ""); // rtrim
    // Normalize bullets: 1) -> 1. , * -> - , • -> -
    line = line
      .replace(/^(\s*)\d+\)\s+/g, "$11. ")
      .replace(/^(\s*)[\*\u2022]\s+/g, "$1- ");
    // Drop consecutive duplicate lines (case/space-insensitive)
    if (line.trim().toLowerCase() === prev.trim().toLowerCase()) continue;
    out.push(line);
    prev = line;
  }

  // Collapse multiple blank lines → single blank
  const collapsed = [];
  let blank = false;
  for (const l of out) {
    if (l.trim() === "") {
      if (!blank) collapsed.push("");
      blank = true;
    } else {
      collapsed.push(l);
      blank = false;
    }
  }

  // If the model forgot headings, we leave as-is; we already asked backend to enforce them.
  return collapsed.join("\n").trim();
}

const Chat = () => {
  const [chats, setChats] = useState([
    {
      msg: "Hi there! How can I assist you today with your Medical questions?",
      who: "bot",
    },
  ]);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [micStream, setMicStream] = useState(null);
  const [isMicActive, setIsMicActive] = useState(false);
  const [peerConnection, setPeerConnection] = useState(null);
  const [dataChannel, setDataChannel] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("idle");
  const [audioWave, setAudioWave] = useState(false);
  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const analyserRef = useRef(null);
  const { audioUrl, setAudioUrl, stopAudio } = useAudioStore();
  const { audioScale } = useAudioForVisualizerStore();

  const scrollAnchorRef = useRef(null);
  const audioPlayerRef = useRef(null);
  const toggleSfxRef = useRef(null);

  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  const liveText = useLiveTranscriptStore((s) => s.text);
  const isStreaming = useLiveTranscriptStore((s) => s.isStreaming);

  const liveIdxRef = useRef(null);
  const finalizeTimerRef = useRef(null);

  useEffect(() => {
    toggleSfxRef.current = new Howl({
      src: ["/assistant.mp3"], // from /public
      volume: 0.2, // reasonable volume
      preload: true, // prefetch for instant play
    });

    return () => {
      // cleanup when component unmounts
      try {
        toggleSfxRef.current?.unload();
      } catch {}
    };
  }, []);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chats, liveText, isStreaming]);

  useEffect(() => {
    return () => {
      micStream?.getTracks().forEach((track) => track.stop());
      peerConnection?.close();
      dataChannel?.close();
      setIsMicActive(false);
    };
  }, [dataChannel, micStream, peerConnection]);

  // live transcript bubbles (unchanged)
  useEffect(() => {
    if (isStreaming && finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }

    if (isStreaming && liveIdxRef.current === null) {
      setChats((prev) => [...prev, { msg: "", who: "me", live: true }]);
      liveIdxRef.current = chats.length;
    }

    if (isStreaming && liveIdxRef.current !== null) {
      setChats((prev) => {
        const arr = [...prev];
        arr[liveIdxRef.current] = {
          ...arr[liveIdxRef.current],
          msg: liveText || "",
        };
        return arr;
      });
    }

    if (
      !isStreaming &&
      liveIdxRef.current !== null &&
      !finalizeTimerRef.current
    ) {
      finalizeTimerRef.current = setTimeout(() => {
        setChats((prev) => {
          const arr = [...prev];
          const idx = liveIdxRef.current;
          if (arr[idx])
            arr[idx] = { msg: liveText || arr[idx].msg || "", who: "me" };
          return arr;
        });
        liveIdxRef.current = null;
        finalizeTimerRef.current = null;
      }, 900);
    }

    return () => {
      if (finalizeTimerRef.current) {
        clearTimeout(finalizeTimerRef.current);
        finalizeTimerRef.current = null;
      }
    };
  }, [isStreaming, liveText]);

  // Voice assistant (unchanged)
  const startWebRTC = async () => {
    if (peerConnection || connectionStatus === "connecting") return;
    setConnectionStatus("connecting");
    setIsMicActive(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { setAudioScale } = useAudioForVisualizerStore.getState();
      startVolumeMonitoring(stream, setAudioScale);
      localStream = stream;
      stream.getAudioTracks().forEach((track) => (track.enabled = true));
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!audioPlayerRef.current) return;
        audioPlayerRef.current.srcObject = stream;
        setAudioUrl(stream);
        audioPlayerRef.current
          .play()
          .catch((err) => console.error("live stream play failed:", err));
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          console.error("ICE connection failed.");
          pc.close();
          setConnectionStatus("error");
        }
      };
      pc.onicecandidateerror = (e) => console.error("ICE candidate error:", e);
      pc.onnegotiationneeded = () => {};
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "closed" ||
          pc.connectionState === "failed"
        ) {
          setConnectionStatus("error");
          setIsMicActive(false);
        }
      };

      if (!localStream)
        console.error("localStream undefined when adding track.");
      stream
        .getAudioTracks()
        .forEach((track) => pc.addTrack(track, localStream));

      const channel = pc.createDataChannel("response");
      channel.onopen = () => {
        setConnectionStatus("connected");
        setIsMicActive(true);
        channel.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hola" }],
            },
          })
        );
        channel.send(JSON.stringify({ type: "response.create" }));
        micStream?.getAudioTracks().forEach((track) => (track.enabled = true));
      };
      channel.onclose = () => {
        if (pc.connectionState !== "closed") {
          console.warn("Data channel closed unexpectedly.", pc.connectionState);
        }
        setConnectionStatus("idle");
        setIsMicActive(false);
      };
      channel.onerror = (error) => {
        console.error("Data channel error:", error);
        setConnectionStatus("error");
        setIsMicActive(false);
      };

      let pcmBuffer = new ArrayBuffer(0);
      channel.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "response.audio.delta": {
            const chunk = Uint8Array.from(atob(msg.delta), (c) =>
              c.charCodeAt(0)
            );
            const tmp = new Uint8Array(pcmBuffer.byteLength + chunk.byteLength);
            tmp.set(new Uint8Array(pcmBuffer), 0);
            tmp.set(chunk, pcmBuffer.byteLength);
            pcmBuffer = tmp.buffer;
            break;
          }
          case "response.audio.done": {
            const wav = encodeWAV(pcmBuffer, 24000, 1);
            const blob = new Blob([wav], { type: "audio/wav" });
            const url = URL.createObjectURL(blob);
            const el = audioPlayerRef.current;
            el.src = url;
            el.volume = 1;
            el.muted = false;
            if (!audioContextRef.current) {
              audioContextRef.current = new (window.AudioContext ||
                window.webkitAudioContext)();
            }
            if (!audioSourceRef.current) {
              audioSourceRef.current =
                audioContextRef.current.createMediaElementSource(el);
              analyserRef.current = audioContextRef.current.createAnalyser();
              audioSourceRef.current.connect(analyserRef.current);
              analyserRef.current.connect(audioContextRef.current.destination);
              analyserRef.current.smoothingTimeConstant = 0.8;
              analyserRef.current.fftSize = 256;
            }
            const analyser = analyserRef.current;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const { setAudioScale } = useAudioForVisualizerStore.getState();
            const monitorBotVolume = () => {
              analyser.getByteFrequencyData(dataArray);
              const avg =
                dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
              const normalized = Math.max(0.5, Math.min(2, avg / 50));
              setAudioScale(normalized);
              if (!el.paused && !el.ended)
                requestAnimationFrame(monitorBotVolume);
            };
            monitorBotVolume();
            setAudioWave(true);
            el.play().catch((err) =>
              console.error("play error:", err.name, err.message)
            );
            pcmBuffer = new ArrayBuffer(0);
            break;
          }
          case "response.audio_transcript.delta":
            break;
          case "output_audio_buffer.stopped":
            setAudioWave(false);
            stopAudio();
            break;
          default:
            console.warn("Unhandled message type:", msg.type);
        }
      };

      let offer;
      try {
        offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
        });
        const modifiedOffer = {
          ...offer,
          sdp: offer.sdp.replace(
            /a=rtpmap:\d+ opus\/48000\/2/g,
            "a=rtpmap:111 opus/48000/2\r\n" +
              "a=fmtp:111 minptime=10;useinbandfec=1"
          ),
        };
        await pc.setLocalDescription(modifiedOffer);
      } catch (e) {
        console.error("Failed to create/set offer:", e);
        pc.close();
        setPeerConnection(null);
        setDataChannel(null);
        if (localStream) {
          localStream.getTracks().forEach((track) => track.stop());
          localStream = null;
        }
        setConnectionStatus("error");
        throw e;
      }

      const res = await fetch(
        `https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/rtc-connect?session_id=${sessionId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
            "X-Session-Id": sessionId,
          },
          body: offer.sdp,
        }
      );
      if (!res.ok)
        throw new Error(`Server responded with status ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      console.error("WebRTC setup failed:", error);
      setConnectionStatus("error");
      setIsMicActive(false);
    }
  };

  const toggleMic = () => {
    if (connectionStatus === "idle" || connectionStatus === "error") {
      startWebRTC();
      return;
    }
    if (connectionStatus === "connected" && localStream) {
      const newMicState = !isMicActive;
      setIsMicActive(newMicState);
      localStream
        .getAudioTracks()
        .forEach((track) => (track.enabled = newMicState));
    }
  };

  const closeVoiceSession = () => {
    try {
      stopAudio?.();
    } catch {}
    try {
      const { setAudioScale } = useAudioForVisualizerStore.getState();
      setAudioScale(1);
    } catch {}
    if (audioPlayerRef.current) {
      try {
        audioPlayerRef.current.pause();
      } catch {}
      audioPlayerRef.current.srcObject = null;
      audioPlayerRef.current.src = "";
    }
    if (dataChannel && dataChannel.readyState !== "closed") {
      try {
        dataChannel.close();
      } catch {}
    }
    if (peerConnection) {
      try {
        peerConnection.getSenders?.().forEach((s) => s.track?.stop());
      } catch {}
      try {
        peerConnection.close();
      } catch {}
    }
    if (localStream) {
      try {
        localStream.getTracks().forEach((t) => t.stop());
      } catch {}
      localStream = null;
    }
    setDataChannel(null);
    setPeerConnection(null);
    setIsMicActive(false);
    setConnectionStatus("idle");
    setIsVoiceMode(false);
  };

  const handleEnterVoiceMode = () => {
    setIsVoiceMode(true);
    if (audioPlayerRef.current) {
      audioPlayerRef.current.muted = true;
      audioPlayerRef.current.play().catch(() => {});
    }
    // subtle click/toggle sound on mic start
    try {
      if (toggleSfxRef.current) {
        toggleSfxRef.current.stop(); // ensure fresh playback
        toggleSfxRef.current.play();
      }
    } catch {}
  };

  // === Classic text chat → backend /stream (unchanged except normalize at end) ===
  const handleNewMessage = async ({ text, skipEcho = false }) => {
    if (!text || !text.trim()) return;

    if (!skipEcho) setChats((prev) => [...prev, { msg: text, who: "me" }]);

    const res = await fetch(`${BACKEND_BASE}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session_id: sessionId }),
    });

    if (!res.ok || !res.body) {
      setChats((prev) => [
        ...prev,
        { msg: "Something went wrong.", who: "bot" },
      ]);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let message = "";
    let isFirstChunk = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      if (isFirstChunk) {
        setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
        isFirstChunk = false;
      }

      message += chunk;
      setChats((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].msg = message;
        return updated;
      });
    }

    setChats((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.streaming) {
        last.streaming = false;
        last.msg = normalizeMarkdown(last.msg);
      }
      return updated;
    });
  };

  // === Render Markdown (unchanged) ===
  const renderMessage = (message) => {
    const regex = /```mermaid([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(message))) {
      const before = message.slice(lastIndex, match.index);
      const code = match[1];
      if (before) parts.push({ type: "text", content: before });
      parts.push({ type: "mermaid", content: code });
      lastIndex = regex.lastIndex;
    }
    const after = message.slice(lastIndex);
    if (after) parts.push({ type: "text", content: after });

    return parts.map((part, idx) =>
      part.type === "mermaid" ? (
        <CollapsibleDiagram chart={part.content.trim()} key={idx} />
      ) : (
        <ReactMarkdown key={idx} remarkPlugins={[remarkGfm]}>
          {part.content}
        </ReactMarkdown>
      )
    );
  };

  // Opinion panel hooks (unchanged)
  const opinionBufferRef = useRef("");
  const opinionStreamingRef = useRef(false);
  const handleOpinionStream = (chunkOrFull, done = false) => {
    if (done) {
      opinionStreamingRef.current = false;
      return;
    }
    const chunk = String(chunkOrFull || "");
    if (!opinionStreamingRef.current) {
      opinionStreamingRef.current = true;
      opinionBufferRef.current = "";
      setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
    }
    opinionBufferRef.current += chunk;
    setChats((prev) => {
      const updated = [...prev];
      updated[updated.length - 1].msg = opinionBufferRef.current;
      return updated;
    });
  };

  const handleAssistantContextTranscript = async (transcript) => {
    try {
      if (!transcript || !transcript.trim()) return;
      await fetch(
        "https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/session-context",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, transcript }),
        }
      );
    } catch (e) {
      console.error(
        "Failed to send transcript context for voice assistant:",
        e
      );
    }
  };

  /** ====== SpecialtyFormSheet → streaming events (normalize at end) ====== */
  const handleFormStreamEvent = (evt) => {
    if (!evt || !evt.type) return;
    if (evt.type === "start") {
      setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
      return;
    }
    if (evt.type === "chunk") {
      const chunk = String(evt.data || "");
      setChats((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (!updated[lastIdx] || updated[lastIdx].who !== "bot") {
          updated.push({ msg: "", who: "bot", streaming: true });
        }
        updated[updated.length - 1].msg =
          (updated[updated.length - 1].msg || "") + chunk;
        return updated;
      });
      return;
    }
    if (evt.type === "done") {
      setChats((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last) {
          if (last.streaming) last.streaming = false;
          last.msg = normalizeMarkdown(last.msg);
        }
        return updated;
      });
    }
  };

  /* ===================== ADDED: Labs uploader integration ===================== */

  // Uploader ref to programmatically open the file chooser (fixed widget)
  const uploaderRef = useRef(null);

  // Stream buffer for OCR->AI analysis coming from either uploader (fixed or inline)
  const labsStreamingRef = useRef(false);
  const labsBufferRef = useRef("");

  // Heuristic: show a prompt card if the last completed bot message asks for labs
  const lastBotText = (() => {
    for (let i = chats.length - 1; i >= 0; i--) {
      const m = chats[i];
      if (m?.who === "bot" && !m.streaming) return m.msg || "";
    }
    return "";
  })();

  function wantsLabs(text) {
    const t = (text || "").toLowerCase();
    return (
      t.includes("upload lab") ||
      t.includes("attach lab") ||
      t.includes("upload the lab") ||
      t.includes("[request_labs]")
    );
  }

  /* =================== END ADDED: Labs uploader integration =================== */

  if (isVoiceMode) {
    return (
      <div className="voice-assistant-wrapper">
        <audio
          ref={audioPlayerRef}
          playsInline
          style={{ display: "none" }}
          controls={false}
          autoPlay
          onError={(e) => console.error("Audio error:", e.target.error)}
        />
        <div className="voice-stage-orb">
          <BaseOrb audioScale={audioScale} />
        </div>
        <div className="mic-controls">
          {connectionStatus === "connecting" && (
            <div className="connection-status connecting">🔄 Connecting...</div>
          )}
          <div>
            <button
              className={`mic-icon-btn ${isMicActive ? "active" : ""}`}
              onClick={toggleMic}
              disabled={connectionStatus === "connecting"}
            >
              <FaMicrophoneAlt />
            </button>
            <button className="closed-btn" onClick={closeVoiceSession}>
              ✖
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- NEW: render with inline uploader injection when backend sends [request_labs]
  const LABS_TOKEN_RE = /\[request_labs\]/i;
  const renderMessageRich = (message) => {
    if (!LABS_TOKEN_RE.test(message || "")) {
      return renderMessage(message);
    }
    const pieces = String(message).split(LABS_TOKEN_RE);

    const nodes = [];
    pieces.forEach((seg, idx) => {
      if (seg) {
        nodes.push(
          <div key={`seg-${idx}`}>{renderMessage(seg)}</div>
        );
      }
      // After each piece except the last, inject an inline uploader
      if (idx < pieces.length - 1) {
        nodes.push(
          <InlineLabsCard
            key={`labs-${idx}`}
            onStreamToken={(chunk) => {
              // stream into a fresh bot message
              if (!labsStreamingRef.current) {
                labsStreamingRef.current = true;
                labsBufferRef.current = "";
                setChats((prev) => [
                  ...prev,
                  { msg: "", who: "bot", streaming: true },
                ]);
              }
              labsBufferRef.current += String(chunk || "");
              setChats((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.streaming) last.msg = labsBufferRef.current;
                return updated;
              });
            }}
            onComplete={(fullText) => {
              setChats((prev) => {
                const updated = [...prev];
                if (labsStreamingRef.current) {
                  labsStreamingRef.current = false;
                  const last = updated[updated.length - 1];
                  if (last && last.streaming) {
                    last.streaming = false;
                    last.msg = normalizeMarkdown(fullText || "");
                    return updated;
                  }
                }
                return [
                  ...updated,
                  { msg: normalizeMarkdown(fullText || ""), who: "bot" },
                ];
              });
            }}
          />
        );
      }
    });
    return nodes;
  };

  return (
    <div className="chat-layout">
      <audio ref={audioPlayerRef} playsInline style={{ display: "none" }} />
      <div className="chat-content">
        {chats.map((chat, index) => (
          <div
            key={index}
            className={`chat-message ${chat.who} ${chat.live ? "live" : ""} ${
              chat.streaming ? "streaming" : ""
            }`}
          >
            {chat.who === "bot" && (
              <figure className="avatar">
                <img src="/av.gif" alt="avatar" />
              </figure>
            )}
            <div className="message-text">
              {/* ⬇️ swapped to inject inline uploader when token present */}
              {renderMessageRich(chat.msg)}
              {chat.streaming && <span className="typing-caret" />}
            </div>
          </div>
        ))}
        <div ref={scrollAnchorRef} />
      </div>

      <div className="chat-footer">
        <ChatInputWidget onSendMessage={handleNewMessage} />
      </div>

      <button className="voice-toggle-button" onClick={handleEnterVoiceMode}>
        🎙️
      </button>

      <VoiceRecorderPanel
        transcribeUrl={`${BACKEND_BASE}/transcribe`}
        opinionUrl={`${BACKEND_BASE}/case-second-opinion-stream`}
        fileFieldName="audio_data"
        anchorLeft={72}
        anchorBottom={96}
        onOpinion={handleOpinionStream}
        onTranscriptReady={handleAssistantContextTranscript}
      />

      {/* =================== Existing fixed bottom-left uploader & prompt =================== */}
      <div
        className="labs-uploader-fixed"
        style={{
          position: "fixed",
          zIndex: 60,
          display: "grid",
        }}
      >
        {wantsLabs(lastBotText) && (
          <div
            className="labs-prompt"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255, 235, 59, 0.12)",
              border: "1px solid rgba(255, 193, 7, 0.35)",
              boxShadow: "0 4px 16px rgba(0,0,0,.06)",
            }}
          >
            <div style={{ display: "grid", gap: 2 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                Lab results requested
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Attach a PDF/image to interpret instantly.
              </div>
            </div>
            <button
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: 0,
                cursor: "pointer",
                background: "#0a66c2",
                color: "#fff",
                fontWeight: 600,
              }}
              onClick={() => uploaderRef.current?.open()}
            >
              Upload
            </button>
          </div>
        )}

        <LabResultsUploader
          ref={uploaderRef}
          autoSend={true}
          ocrLanguage="eng"   // switch to "ara" for Arabic reports
          engine="2"
          onBeforeSendToAI={(text, meta) =>
            [
              "You are a clinical AI assistant.",
              "You are given OCR-extracted lab results below.",
              "Summarize abnormal values (with units), compare to provided normal ranges, flag critical values,",
              "and give a concise, guideline-aligned interpretation.",
              `SOURCE FILE: ${meta?.filename || "Unknown"}`,
              "",
              "=== LAB RESULTS (OCR) ===",
              text,
            ].join("\n")
          }
          onAIStreamToken={(chunk) => {
            // Start streaming a new bot message on first token
            if (!labsStreamingRef.current) {
              labsStreamingRef.current = true;
              labsBufferRef.current = "";
              setChats((prev) => [
                ...prev,
                { msg: "", who: "bot", streaming: true },
              ]);
            }
            labsBufferRef.current += String(chunk || "");
            setChats((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last && last.streaming) last.msg = labsBufferRef.current;
              return updated;
            });
          }}
          onAIResponse={(payload) => {
            const full =
              payload?.text ??
              (typeof payload === "string" ? payload : JSON.stringify(payload));
            setChats((prev) => {
              const updated = [...prev];
              if (labsStreamingRef.current) {
                labsStreamingRef.current = false;
                const last = updated[updated.length - 1];
                if (last && last.streaming) {
                  last.streaming = false;
                  last.msg = normalizeMarkdown(full || "");
                  return updated;
                }
              }
              // If no streaming occurred, just append a bot message
              return [
                ...updated,
                { msg: normalizeMarkdown(full || ""), who: "bot" },
              ];
            });
          }}
        />
      </div>
      {/* ================= END fixed uploader ================= */}
    </div>
  );
};

export default Chat;

/* ==== Helpers (unchanged) ==== */
const CollapsibleDiagram = ({ chart }) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="collapsible-diagram">
      <div
        className="collapsible-header"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="toggle-icon">{isOpen ? "–" : "+"}</span> View Diagram
      </div>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="content"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            className="collapsible-body"
          >
            <Mermaid chart={chart} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* ===== NEW: compact inline card with uploader for bot bubble ===== */
function InlineLabsCard({ onStreamToken, onComplete }) {
  const localRef = useRef(null);

  return (
    <div
      style={{
        margin: "10px 0",
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(10,102,194,0.08)",
        border: "1px solid rgba(10,102,194,0.25)",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
        Please upload the lab results (PDF/Image)
      </div>
      <LabResultsUploader
        ref={localRef}
        autoSend={true}
        ocrLanguage="eng"   // set "ara" for Arabic
        engine="2"
        // Make the inline widget dense/compact if your component supports it
        dense={true}
        onBeforeSendToAI={(text, meta) =>
          [
            "You are a clinical AI assistant.",
            "You are given OCR-extracted lab results below.",
            "Summarize abnormal values (with units), compare to provided normal ranges, flag critical values,",
            "and give a concise, guideline-aligned interpretation.",
            `SOURCE FILE: ${meta?.filename || "Unknown"}`,
            "",
            "=== LAB RESULTS (OCR) ===",
            text,
          ].join("\n")
        }
        onAIStreamToken={onStreamToken}
        onAIResponse={(payload) => {
          const full =
            payload?.text ??
            (typeof payload === "string" ? payload : JSON.stringify(payload));
          onComplete(full);
        }}
      />
    </div>
  );
}

