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

let localStream;

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
  // eslint-disable-next-line no-unused-vars
  const [audioWave, setAudioWave] = useState(false);
  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const analyserRef = useRef(null);
  // eslint-disable-next-line no-unused-vars
  const { audioUrl, setAudioUrl, stopAudio } = useAudioStore();
  const scrollAnchorRef = useRef(null);
  const audioPlayerRef = useRef(null);
  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chats]);

  useEffect(() => {
    // fetch("http://localhost:5050/suggestions")
    fetch("https://ai-doctor-assistant-backend-server.onrender.com/suggestions")
      .then((res) => res.json())
      .then((data) => setSuggestedQuestions(data.suggested_questions || []))
      .catch((err) => console.error("Failed to fetch suggestions:", err));
  }, []);

  useEffect(() => {
    return () => {
      micStream?.getTracks().forEach((track) => track.stop());
      peerConnection?.close();
      dataChannel?.close();
      setMicStream(null);
      setPeerConnection(null);
      setDataChannel(null);
      setConnectionStatus("idle");
      setIsMicActive(false);
    };
  }, [dataChannel, micStream, peerConnection]);
  const { audioScale } = useAudioForVisualizerStore();
  const startWebRTC = async () => {
    if (peerConnection || connectionStatus === "connecting") {
      console.warn("⚠️ Already connecting or connected.");
      return;
    }

    //console.log("🔌 Initializing WebRTC connection...");
    setConnectionStatus("connecting");
    setIsMicActive(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { setAudioScale } = useAudioForVisualizerStore.getState();
      startVolumeMonitoring(stream, setAudioScale);

      localStream = stream; // Prevent garbage collection

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
          console.error("🚫 ICE connection failed.");
          pc.close();
          setConnectionStatus("error");
        }
      };

      pc.onicecandidateerror = (e) => {
        console.error("🚨 ICE candidate error:", e);
      };

      pc.onnegotiationneeded = (event) => {
        //console.log("Negotiation needed:", event);
      };

      pc.onconnectionstatechange = () => {
        // //console.log("🔁 Connection state:", pc.connectionState);
        if (
          pc.connectionState === "closed" ||
          pc.connectionState === "failed"
        ) {
          // console.error("🚫 Connection closed unexpectedly. ICE state:", pc.iceConnectionState, "Signaling state:", pc.signalingState);
          setConnectionStatus("error");
          setIsMicActive(false);
        }
      };

      if (!localStream) {
        console.error("🚫 localStream is undefined when adding track.");
      }
      // 2. ADD TRACKS PROPERLY USING addTrack INSTEAD OF addTransceiver and add after creating channel
      stream.getAudioTracks().forEach((track) => {
        // pc.addTransceiver(track, { direction: "sendrecv" });
        // Use addTrack instead of addTransceiver
        return pc.addTrack(track, localStream);
      });

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
        micStream?.getAudioTracks().forEach((track) => {
          track.enabled = true;
          //console.log("🎤 Microphone track enabled:", track.label);
        });
      };

      channel.onclose = () => {
        //console.log("🔌 Data channel closed.");
        if (pc.connectionState !== "closed") {
          console.warn(
            "⚠️ Data channel closed unexpectedly. Peer connection state:",
            pc.connectionState
          );
        }
        setConnectionStatus("idle");
        setIsMicActive(false);
      };

      channel.onerror = (error) => {
        console.error("❌ Data channel error:", error);
        setConnectionStatus("error");
        setIsMicActive(false);
      };

      let pcmBuffer = new ArrayBuffer(0);

      channel.onmessage = async (event) => {
        //console.log("📨 Data channel message received:", event.data);
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "response.audio.delta":
            const chunk = Uint8Array.from(atob(msg.delta), (c) =>
              c.charCodeAt(0)
            );
            const tmp = new Uint8Array(pcmBuffer.byteLength + chunk.byteLength);
            tmp.set(new Uint8Array(pcmBuffer), 0);
            tmp.set(chunk, pcmBuffer.byteLength);
            pcmBuffer = tmp.buffer;
            break;

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

              if (!el.paused && !el.ended) {
                requestAnimationFrame(monitorBotVolume);
              }
            };

            monitorBotVolume();
            setAudioWave(true);
            el.play()
              .then(() => console.log("✅ play promise resolved"))
              .catch((err) =>
                console.error("❌ play error:", err.name, err.message)
              );

            pcmBuffer = new ArrayBuffer(0); // reset for next turn
            break;
          }

          case "response.audio_transcript.delta":
            //console.log("📝 Transcript streaming update received.");
            break;
          case "output_audio_buffer.stopped":
            //console.log("🛑 Audio buffer stopped. Clearing audio...");
            setAudioWave(false);
            stopAudio();
            break;
          default:
            console.warn("❓ Unhandled message type:", msg.type);
        }
      };

      // 3. CREATE OFFER AFTER SETTING UP ALL TRACKS AND HANDLERS
      let offer;
      try {
        // //console.log("📡 Creating offer...");
        offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
        });

        // Modify SDP to prioritize Opus
        const modifiedOffer = {
          ...offer,
          sdp: offer.sdp.replace(
            /a=rtpmap:\d+ opus\/48000\/2/g,
            "a=rtpmap:111 opus/48000/2\r\n" +
              "a=fmtp:111 minptime=10;useinbandfec=1"
          ),
        };
        // //console.log("📝 Offer created:", offer.type);

        await pc.setLocalDescription(modifiedOffer);
        // //console.log("📤 Local SDP offer set:", pc.signalingState);
      } catch (e) {
        console.error("❌ Failed to create/set offer:", e);
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
      // //console.log("📨 Sending offer to signaling server...");
      const res = await fetch(
        "https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/rtc-connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: offer.sdp,
        }
      );

      if (!res.ok) {
        throw new Error(`❌ Server responded with status ${res.status}`);
      }

      const answer = await res.text();
    
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
     
    } catch (error) {
      console.error("🚫 WebRTC setup failed:", error);
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

  const handleEnterVoiceMode = () => {
    setIsVoiceMode(true);
    if (audioPlayerRef.current) {
      audioPlayerRef.current.muted = true;
      audioPlayerRef.current.play().catch(() => {});
    }
  };

  const handleNewMessage = async ({ text }) => {
    if (!text) return;
    setChats((prev) => [...prev, { msg: text, who: "me" }]);
    setSuggestedQuestions((prev) => prev.filter((q) => q !== text)); // 🧼 remove from list

    const res = await fetch("https://ai-doctor-assistant-backend-server.onrender.com/stream", {
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
        setChats((prev) => [...prev, { msg: "", who: "bot" }]);
        isFirstChunk = false;
      }

      message += chunk;
      // eslint-disable-next-line no-loop-func
      setChats((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].msg = message;
        return updated;
      });
    }
  };

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
            {/* {audioWave && ( */}
            {/* <figure className="avatar">
              <img src="/av.gif" alt="avatar" />
            </figure> */}
            {/* )} */}
            <button
              className={`mic-icon-btn ${isMicActive ? "active" : ""}`}
              onClick={toggleMic}
              disabled={connectionStatus === "connecting"}
            >
              <FaMicrophoneAlt />
            </button>
            <button
              className="closed-btn"
              onClick={() => setIsVoiceMode(false)}
            >
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
          <div key={index} className={`chat-message ${chat.who}`}>
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
        <SuggestedQuestionsAccordion
          questions={suggestedQuestions}
          onQuestionClick={handleNewMessage}
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
              onClick={() => handleNewMessage({ text: q })}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <button className="voice-toggle-button" onClick={handleEnterVoiceMode}>
        🎙️
      </button>
    </div>
  );
};

export default Chat;

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