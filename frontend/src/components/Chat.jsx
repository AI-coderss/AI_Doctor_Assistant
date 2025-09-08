/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable no-loop-func */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable no-loop-func */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable no-loop-func */
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

// Live transcript store
import useLiveTranscriptStore from "../store/useLiveTranscriptStore";

let localStream;

/** === Personalized Medicine endpoints === */
const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const NUDGE_NEXT_URL = `${API_BASE}/nudge-next`;
const NUDGE_ANSWER_URL = `${API_BASE}/nudge-answer`;

const Chat = () => {
  const [chats, setChats] = useState([
    {
      msg: "Hi there! How can I assist you today with your Medical questions?",
      who: "bot",
    },
  ]);
  const [suggestedQuestions, setSuggestedQuestions] = useState([]);
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

  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  // ===== Personalized Medicine (PM) toggle + state =====
  const [isPersonalized, setIsPersonalized] = useState(
    () => localStorage.getItem("pmode") === "1"
  );
  useEffect(() => {
    localStorage.setItem("pmode", isPersonalized ? "1" : "0");
  }, [isPersonalized]);

  const [intakeAnswers, setIntakeAnswers] = useState({
    age: null,
    sex: null,
    pregnancy: null,
    weight: null,
  });
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudgePayload, setNudgePayload] = useState(null); // server JSON (next_question/state/analysis)
  const nudgeHistoryRef = useRef([]); // [{questionId, answer}]
  const complaintRef = useRef(""); // first message that triggers PM

  const mapAnswerIntoIntake = (qid, answer) => {
    const key = String(qid || "").toLowerCase();
    setIntakeAnswers((prev) => {
      if (key === "age" || key === "age_years")
        return { ...prev, age: Number(answer) || answer };
      if (key === "sex" || key === "biological_sex")
        return { ...prev, sex: String(answer).toLowerCase() };
      if (key === "pregnancy" || key === "pregnancy_status")
        return { ...prev, pregnancy: String(answer).toLowerCase() };
      if (key === "weight" || key === "weight_kg")
        return { ...prev, weight: Number(answer) || answer };
      return prev;
    });
  };

  const fetchNudgeNext = async ({ complaint }) => {
    try {
      const res = await fetch(NUDGE_NEXT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          complaint,
          answers: intakeAnswers,
          history: nudgeHistoryRef.current,
        }),
      });
      const data = await res.json();
      setNudgePayload(data);
      setNudgeOpen(true);
      return data;
    } catch (e) {
      console.error("nudge-next error:", e);
      return null;
    }
  };

  const sendNudgeAnswer = async ({ question_id, answer }) => {
    try {
      mapAnswerIntoIntake(question_id, answer);
      nudgeHistoryRef.current.push({ questionId: question_id, answer });

      const res = await fetch(NUDGE_ANSWER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          complaint: complaintRef.current || "Consultation",
          question_id,
          answer,
        }),
      });
      const data = await res.json();
      setNudgePayload(data);
      if (
        data?.state === "complete" ||
        data?.state === "triage_urgent"
      ) {
        setNudgeOpen(false);
      }
      return data;
    } catch (e) {
      console.error("nudge-answer error:", e);
      return null;
    }
  };

  const nudgeIncomplete = () => {
    const st = nudgePayload?.state;
    return !(st === "complete" || st === "triage_urgent");
  };

  // Live transcript store
  const liveText = useLiveTranscriptStore((s) => s.text);
  const isStreaming = useLiveTranscriptStore((s) => s.isStreaming);

  // Index of the live "me" bubble in chats (or null)
  const liveIdxRef = useRef(null);
  // Debounce timer to avoid premature finalize on transient pauses
  const finalizeTimerRef = useRef(null);

  // auto-scroll
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chats, liveText, isStreaming]);

  // suggestions
  useEffect(() => {
    fetch("https://ai-doctor-assistant-backend-server.onrender.com/suggestions")
      .then((res) => res.json())
      .then((data) => setSuggestedQuestions(data.suggested_questions || []))
      .catch((err) => console.error("Failed to fetch suggestions:", err));
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      micStream?.getTracks().forEach((track) => track.stop());
      peerConnection?.close();
      dataChannel?.close();
      setIsMicActive(false);
    };
  }, [dataChannel, micStream, peerConnection]);

  // === reflect store → chat bubbles in real time ===
  useEffect(() => {
    // If streaming resumes, cancel any pending finalization
    if (isStreaming && finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }

    // streaming started: open a live "me" bubble if not already present
    if (isStreaming && liveIdxRef.current === null) {
      setChats((prev) => [...prev, { msg: "", who: "me", live: true }]);
      liveIdxRef.current = chats.length; // position at new element
    }

    // update the live bubble text
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

    // streaming stopped: debounce finalization to avoid fugacious cut-offs
    if (
      !isStreaming &&
      liveIdxRef.current !== null &&
      !finalizeTimerRef.current
    ) {
      finalizeTimerRef.current = setTimeout(() => {
        setChats((prev) => {
          const arr = [...prev];
          const idx = liveIdxRef.current;
          if (arr[idx]) arr[idx] = { msg: liveText || arr[idx].msg || "", who: "me" };
          return arr;
        });
        liveIdxRef.current = null;
        finalizeTimerRef.current = null;
        // Do not send here; ChatInputWidget already sent on manual stop with skipEcho:true
      }, 900);
    }

    return () => {
      if (finalizeTimerRef.current) {
        clearTimeout(finalizeTimerRef.current);
        finalizeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, liveText]);

  // ===== Your existing WebRTC (voice assistant) — left intact =====
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
        if (pc.connectionState === "closed" || pc.connectionState === "failed") {
          setConnectionStatus("error");
          setIsMicActive(false);
        }
      };

      if (!localStream) console.error("localStream undefined when adding track.");
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

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
            const chunk = Uint8Array.from(atob(msg.delta), (c) => c.charCodeAt(0));
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
              audioContextRef.current =
                new (window.AudioContext || window.webkitAudioContext)();
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

              if (!el.paused && !el.ended) requestAnimationFrame(monitorBotVolume);
            };

            monitorBotVolume();
            setAudioWave(true);
            el.play().catch((err) => console.error("play error:", err.name, err.message));
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

      // Offer
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
          headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId },
          body: offer.sdp,
        }
      );

      if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      console.error("WebRTC setup failed:", error);
      setConnectionStatus("error");
      setIsMicActive(false);
    }
  };

  const toggleMic = async () => {
    // ✅ Block voice until PM questions done
    if (isPersonalized && (!nudgePayload || nudgeIncomplete())) {
      if (!complaintRef.current) complaintRef.current = "Voice consultation";
      await fetchNudgeNext({ complaint: complaintRef.current });
      return;
    }

    if (connectionStatus === "idle" || connectionStatus === "error") {
      startWebRTC();
      return;
    }
    if (connectionStatus === "connected" && localStream) {
      const newMicState = !isMicActive;
      setIsMicActive(newMicState);
      localStream.getAudioTracks().forEach((track) => (track.enabled = newMicState));
    }
  };
  // Close voice session immediately (DC, PC, tracks, audio, UI)
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
  };

  // ===== Send message to backend; stream into ONE bot bubble =====
  const handleNewMessage = async ({ text, skipEcho = false }) => {
    if (!text || !text.trim()) return;

    // ✅ Personalized mode: trigger/continue nudge BEFORE normal chat
    if (isPersonalized) {
      if (!complaintRef.current) complaintRef.current = text.trim();
      if (!nudgePayload || nudgeIncomplete()) {
        await fetchNudgeNext({ complaint: complaintRef.current });
        return;
      }
    }

    if (!skipEcho) {
      setChats((prev) => [...prev, { msg: text, who: "me" }]);
    }
    setSuggestedQuestions((prev) => prev.filter((q) => q !== text));

    const res = await fetch(`${API_BASE}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session_id: sessionId }),
    });

    if (!res.ok || !res.body) {
      setChats((prev) => [...prev, { msg: "Something went wrong.", who: "bot" }]);
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
        setChats((prev) => [...prev, { msg: "", who: "bot" }]);
        isFirstChunk = false;
      }

      message += chunk;
      setChats((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].msg = message;
        return updated;
      });
    }
  };

  // === Markdown + Mermaid renderer ===
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

  // === Opinion panel hooks (unchanged) ===
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
      setChats((prev) => [...prev, { msg: "", who: "bot" }]);
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
      console.error("Failed to send transcript context for voice assistant:", e);
    }
  };

  // === Render ===
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

  return (
    <div className="chat-layout">
      <audio ref={audioPlayerRef} playsInline style={{ display: "none" }} />
      <div className="chat-content">
        {chats.map((chat, index) => (
          <div
            key={index}
            className={`chat-message ${chat.who} ${chat.live ? "live" : ""}`}
          >
            {chat.who === "bot" && (
              <figure className="avatar">
                <img src="/av.gif" alt="avatar" />
              </figure>
            )}
            <div className="message-text">{renderMessage(chat.msg)}</div>
          </div>
        ))}
        <div ref={scrollAnchorRef} />
      </div>

      <div className="chat-footer">
        {/* Personalized Medicine Toggle */}
        <div className="pmode-toggle">
          <label className="switch">
            <input
              type="checkbox"
              checked={isPersonalized}
              onChange={(e) => {
                const on = e.target.checked;
                setIsPersonalized(on);
                if (!on) {
                  // reset PM state when turning OFF
                  setNudgeOpen(false);
                  setNudgePayload(null);
                  nudgeHistoryRef.current = [];
                  complaintRef.current = "";
                  setIntakeAnswers({ age: null, sex: null, pregnancy: null, weight: null });
                }
              }}
            />
            <span className="slider" />
          </label>
          <span className="pmode-label">Personalized Medicine</span>
        </div>

        <SuggestedQuestionsAccordion
          questions={suggestedQuestions}
          onQuestionClick={({ text }) => handleNewMessage({ text, skipEcho: false })}
        />
        <ChatInputWidget onSendMessage={handleNewMessage} />
      </div>

      <div className="suggestion-column">
        <h4 className="suggestion-title">💡 Suggested Questions</h4>
        <div className="suggestion-list">
          {suggestedQuestions.map((q, idx) => (
            <button
              key={idx}
              className="suggestion-item"
              onClick={() => handleNewMessage({ text: q, skipEcho: false })}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <button className="voice-toggle-button" onClick={handleEnterVoiceMode}>
        🎙️
      </button>

      {/* Nudge modal */}
      <NudgeModal
        open={nudgeOpen}
        payload={nudgePayload}
        onClose={() => setNudgeOpen(false)}
        onAnswer={async (qid, answer) => {
          const data = await sendNudgeAnswer({ question_id: qid, answer });
          if (data && (data.state === "complete" || data.state === "triage_urgent")) {
            const text = complaintRef.current;
            complaintRef.current = "";
            // Echo complaint and proceed through normal chat flow
            handleNewMessage({ text, skipEcho: false });
          }
        }}
      />

      <VoiceRecorderPanel
        transcribeUrl="https://ai-doctor-assistant-backend-server.onrender.com/transcribe"
        opinionUrl="https://ai-doctor-assistant-backend-server.onrender.com/case-second-opinion-stream"
        fileFieldName="audio_data"
        anchorLeft={72}
        anchorBottom={96}
        onOpinion={handleOpinionStream}
        onTranscriptReady={handleAssistantContextTranscript}
      />
    </div>
  );
};

export default Chat;

/* ==== Helpers (unchanged) ==== */
const CollapsibleDiagram = ({ chart }) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="collapsible-diagram">
      <div className="collapsible-header" onClick={() => setIsOpen((prev) => !prev)}>
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

const SuggestedQuestionsAccordion = ({ questions, onQuestionClick }) => {
  const [isOpen, setIsOpen] = useState(false);
  if (!questions.length) return null;

  return (
    <div className="suggested-questions-accordion">
      <button className="accordion-toggle" onClick={() => setIsOpen(!isOpen)}>
        <span className="accordion-toggle-icon">{isOpen ? "−" : "+"}</span>
        Suggested Questions
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="accordion-content"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <div className="suggestion-list-mobile">
              {questions.map((q, idx) => (
                <button
                  key={idx}
                  className="suggestion-item-mobile"
                  onClick={() => {
                    onQuestionClick({ text: q });
                    setIsOpen(false);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/** === Nudge Modal (fixed: hook is before any early return) === */
const NudgeModal = ({ open, payload, onAnswer, onClose }) => {
  const [val, setVal] = React.useState(""); // <-- hook first, always called

  if (!open || !payload) return null;       // early return AFTER hooks

  const q = payload.next_question || null;

  const renderControls = () => {
    if (!q) return null;

    if (q.type === "enum" || q.type === "multiselect") {
      const opts = Array.isArray(q.options) ? q.options : [];
      return (
        <div className="nudge-pills">
          {opts.map((opt) => (
            <button key={opt} className="pill" onClick={() => onAnswer(q.id, opt)}>
              {opt}
            </button>
          ))}
        </div>
      );
    }
    if (q.type === "boolean") {
      return (
        <div className="nudge-pills">
          <button className="pill" onClick={() => onAnswer(q.id, true)}>Yes</button>
          <button className="pill" onClick={() => onAnswer(q.id, false)}>No</button>
        </div>
      );
    }
    if (q.type === "scale" || q.type === "number") {
      return (
        <div className="nudge-number-row">
          <input
            type="number"
            inputMode="decimal"
            placeholder={q.unit ? `${q.text} (${q.unit})` : q.text}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && val !== "" && onAnswer(q.id, Number(val))}
          />
          <button disabled={val === ""} onClick={() => onAnswer(q.id, Number(val))}>
            Submit
          </button>
        </div>
      );
    }
    return (
      <div className="nudge-text-row">
        <input
          type="text"
          placeholder={q.text}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && val.trim() && onAnswer(q.id, val.trim())}
        />
        <button disabled={!val.trim()} onClick={() => onAnswer(q.id, val.trim())}>
          Submit
        </button>
      </div>
    );
  };

  const state = payload.state;
  const done = state === "complete" || state === "triage_urgent";

  return (
    <div className="nudge-overlay" role="dialog" aria-modal="true">
      <div className="nudge-card">
        <h3 className="nudge-title">{done ? "Summary ready" : "Quick critical questions"}</h3>

        {!done && q && (
          <>
            <p className="nudge-question">{q.text}</p>
            {q.hint && <div className="nudge-hint">{q.hint}</div>}
            {renderControls()}
            {Array.isArray(payload.alternatives) && payload.alternatives.length > 0 && (
              <div className="nudge-alt">
                <span>Or ask:</span>
                {payload.alternatives.slice(0, 2).map((alt) => (
                  <button
                    key={alt.id}
                    className="alt-pill"
                    onClick={() => onAnswer(alt.id, "[skipped → alt]")}
                  >
                    {alt.text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {done && (
          <>
            <div className="nudge-done-note">
              {state === "triage_urgent"
                ? "⚠️ Urgent triage suggested."
                : "✅ Enough info collected."}
            </div>
            <button className="proceed-btn" onClick={onClose}>Proceed to chat</button>
          </>
        )}
      </div>
    </div>
  );
};

