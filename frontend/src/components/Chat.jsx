/* eslint-disable no-useless-escape */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable no-loop-func */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useState, useEffect, useRef, useMemo } from "react";
import ChatInputWidget from "./ChatInputWidget.jsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid.jsx";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt } from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import "../styles/chat.css";
import "../styles/labs-viz.css"; // ✅ visual bars & indicators for labs
import { encodeWAV } from "./pcmToWav.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";
import VoiceRecorderPanel from "./VoiceRecorderPanel";
import useLiveTranscriptStore from "../store/useLiveTranscriptStore";
import LabResultsUploader from "./LabResultsUploader";
import MedicationChecker from "./MedicationChecker"; // ✅
import useDosageStore from "../store/dosageStore";
import CalculateDosageButton from "./CalculateDosageButton"; // ✅
import MedicalImageAnalyzer from "./MedicalImageAnalyzer"; // ✅ NEW (Vision)
import { Howl } from "howler";

/* 🔵 NEW: charts for recorded-case visualization */
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

let localStream;
const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

/* Force fixed-position pieces to play nicely in the drawer. */
const drawerComponentOverrides = `
  /* Drawer grid + spacing */
  .tools-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 16px;
    row-gap: 16px;
    align-items: start;
    justify-items: center;
    padding: 16px;
  }

  /* Each child the drawer renders */
  .tool-wrapper {
    display: flex;
    justify-content: center;
    align-items: stretch;
    width: 100%;
  }

  /* Unify tile widths */
  .tool-wrapper > *:first-child,
  .tool-wrapper .record-case-btn-left,
  .tool-wrapper .record-timer-fixed,
  .tool-wrapper .labs-uploader-fixed,
  .tool-wrapper .meds-uploader-fixed {
    position: relative !important;
    left: auto !important;
    bottom: auto !important;
    transform: none !important;
    margin: 0 auto !important;
    z-index: 1 !important;
    width: 100% !important;
    max-width: 160px;
  }

  .labs-prompt {
    width: 100%;
    margin: 0 0 8px 0;
  }
`;

/** Normalize bot markdown a bit */
function normalizeMarkdown(input = "") {
  const lines = String(input).split(/\r?\n/);
  const out = [];
  let prev = "";
  for (let raw of lines) {
    let line = raw.replace(/\s+$/g, "");
    line = line
      .replace(/^(\s*)\d+\)\s+/g, "$11. ")
      .replace(/^(\s*)[\*\u2022]\s+/g, "$1- ");
    if (line.trim().toLowerCase() === prev.trim().toLowerCase()) continue;
    out.push(line);
    prev = line;
  }
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
  return collapsed.join("\n").trim();
}
// --- Add this to chat.jsx (e.g., near other helper components) ---
function InlineLabsCard({ onParsedLabs, onStreamToken, onComplete }) {
  const ref = React.useRef(null);

  return (
    <div className="inline-labs-card">
      <div className="inline-labs-card__body">
        <div className="inline-labs-card__title">Attach lab results</div>
        <div className="inline-labs-card__hint">
          Upload a PDF/image; I’ll parse values and summarize.
        </div>
        <div className="inline-labs-card__actions">
          <button className="btn btn--primary" onClick={() => ref.current?.open()}>
            Upload
          </button>
        </div>
      </div>

      {/* Hidden uploader instance that we trigger with the button above */}
      <LabResultsUploader
        ref={ref}
        autoSend={true}
        ocrLanguage="eng"
        engine="2"
        onParsedLabs={(labs, meta) => {
          if (typeof onParsedLabs === "function") onParsedLabs(labs, meta);
        }}
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
          if (typeof onStreamToken === "function") onStreamToken(String(chunk || ""));
        }}
        onAIResponse={(payload) => {
          const full =
            payload?.text ??
            (typeof payload === "string" ? payload : JSON.stringify(payload));
          if (typeof onComplete === "function") onComplete(full);
        }}
      />
    </div>
  );
}

/* 🔵 NEW: Strip a trailing JSON object we append from the backend */
function stripTrailingJson(text) {
  if (!text) return { plain: "", json: null };
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { plain: text, json: null };
  const maybe = text.slice(start, end + 1);
  try {
    const json = JSON.parse(maybe);
    return { plain: text.slice(0, start).trimEnd(), json };
  } catch {
    return { plain: text, json: null };
  }
}

/* 🔵 NEW: Recorded Case Analysis bubble (donuts + top comparison bar + accordions) */
function RecordedCaseAnalysisBubble({ data, topK = 5 }) {
  const diagnoses = Array.isArray(data?.diagnoses) ? data.diagnoses.slice(0, topK) : [];
  const labs = Array.isArray(data?.labs) ? data.labs : [];
  const radiology = Array.isArray(data?.radiology) ? data.radiology : [];
  const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
  const notes = typeof data?.notes === "string" ? data.notes : "";

  const donutOptions = (label, p) => ({
    chart: { type: "pie", backgroundColor: "transparent", height: 140, width: 140, margin: [0, 0, 0, 0] },
    title: { text: `${Math.round((p || 0) * 100)}%`, align: "center", verticalAlign: "middle", y: 6 },
    tooltip: { enabled: false },
    plotOptions: {
      pie: { innerSize: "70%", dataLabels: { enabled: false }, states: { hover: { enabled: false } }, animation: { duration: 250 } },
    },
    series: [
      { name: label, data: [{ name: label, y: Math.max(0.001, p || 0) }, { name: "other", y: 1 - Math.max(0.001, p || 0) }] },
    ],
    credits: { enabled: false },
    legend: { enabled: false },
  });

  const barOptions = useMemo(
    () => ({
      chart: { type: "bar", backgroundColor: "transparent", height: Math.max(220, 60 + 26 * diagnoses.length) },
      title: { text: "Top comparison" },
      xAxis: { categories: diagnoses.map((d) => d.label), title: { text: null } },
      yAxis: { min: 0, max: 100, title: { text: "Probability (%)", align: "high" } },
      tooltip: { valueSuffix: "%" },
      plotOptions: { series: { animation: { duration: 250 }, dataLabels: { enabled: true, format: "{point.y:.0f}%" } } },
      series: [{ name: "Probability", data: diagnoses.map((d) => Math.round((d.p || 0) * 100)) }],
      credits: { enabled: false },
    }),
    [diagnoses]
  );

  return (
    <div className="rca-bubble">
      <div className="rca-top">
        {diagnoses.map((d) => (
          <div className="rca-donut" key={d.label}>
            <HighchartsReact highcharts={Highcharts} options={donutOptions(d.label, d.p)} />
            <div className="rca-label">{d.label}</div>
            {Array.isArray(d.icd10) && d.icd10.length > 0 && (
              <div className="rca-icd">ICD-10: {d.icd10.slice(0, 3).join(", ")}</div>
            )}
          </div>
        ))}
      </div>

      <div className="rca-bar">
        <HighchartsReact highcharts={Highcharts} options={barOptions} />
      </div>

      <details className="rca-accordion" open>
        <summary>Recommended lab tests &amp; investigations</summary>
        <ul className="rca-list">{labs.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </details>

      <details className="rca-accordion">
        <summary>Radiology</summary>
        <ul className="rca-list">{radiology.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </details>

      <details className="rca-accordion">
        <summary>Recommendations to the doctor</summary>
        <ul className="rca-list">{recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </details>

      <details className="rca-accordion">
        <summary>Clinical notes</summary>
        <div className="rca-notes">{notes}</div>
      </details>
    </div>
  );
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
      src: ["/assistant.mp3"],
      volume: 0.2,
      preload: true,
    });
    return () => {
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

  // Live transcript bubble lifecycle
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
    if (!isStreaming && liveIdxRef.current !== null && !finalizeTimerRef.current) {
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
              if (!el.paused && !el.ended) requestAnimationFrame(monitorBotVolume);
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
        setIsMicActive(false);
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
      if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
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
      localStream.getAudioTracks().forEach((track) => (track.enabled = newMicState));
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
    try {
      if (toggleSfxRef.current) {
        toggleSfxRef.current.stop();
        toggleSfxRef.current.play();
      }
    } catch {}
  };

  // Text chat → /stream
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

  // Markdown renderer
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

  /* ===================== Recorded-case second opinion streaming ===================== */
  const opinionBufferRef = useRef("");
  const opinionStreamingRef = useRef(false);
  const handleOpinionStream = (chunkOrFull, done = false) => {
    if (done) {
      opinionStreamingRef.current = false;
      const { plain, json } = stripTrailingJson(opinionBufferRef.current);
      setChats((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.streaming) {
          last.streaming = false;
          last.msg = normalizeMarkdown(plain || "");
        } else {
          updated.push({ msg: normalizeMarkdown(plain || ""), who: "bot" });
        }
        if (
          json &&
          (json.diagnoses || json.labs || json.radiology || json.recommendations || json.notes)
        ) {
          updated.push({ who: "bot", type: "recorded-analysis", data: json });
        }
        return updated;
      });
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
      const t = (transcript || "").trim();
      if (!t) return;

      // 1) Persist context for RAG/dosage endpoints
      await fetch(`${BACKEND_BASE}/set-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript: t }),
      });

      // 2) Prime voice-mode service (fire-and-forget)
      fetch(
        "https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/session-context",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, transcript: t }),
        }
      ).catch(() => {});

      // 3) Mirror locally for DosageCalculator (Zustand)
      try {
        const store = useDosageStore.getState();
        store.setTranscript?.(t);
        store.setSessionId?.(sessionId);
      } catch {}
    } catch (e) {
      console.error("Failed to send transcript context:", e);
    }
  };

  /** Specialty form streaming (if used elsewhere) */
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

  /* ===================== Labs uploader integration ===================== */

  const uploaderRef = useRef(null);
  const labsStreamingRef = useRef(false);
  const labsBufferRef = useRef("");

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

  const LABS_TOKEN_RE = /\[request_labs\]/i;
  const LABS_TOKEN_RE_GLOBAL = /\[request_labs\]/gi;

  const stripLabsTokenFromBubble = (bubbleIdx) => {
    setChats((prev) => {
      const arr = [...prev];
      const target = arr[bubbleIdx];
      if (
        target &&
        typeof target.msg === "string" &&
        LABS_TOKEN_RE.test(target.msg)
      ) {
        target.msg = target.msg.replace(LABS_TOKEN_RE_GLOBAL, "");
      }
      return arr;
    });
  };

  // When parsed labs arrive → show visual card
  const handleParsedLabs = (labs, meta) => {
    if (!Array.isArray(labs) || labs.length === 0) return;
    setChats((prev) => [
      ...prev,
      { who: "bot", type: "labs", labs, meta: meta || null },
    ]);
  };

  /* ===================== Medication checker streaming ===================== */
  const medUploaderRef = useRef(null);
  const medsStreamingRef = useRef(false);
  const medsBufferRef = useRef("");

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

  // Render with inline uploader injection when bot asks for labs
  const renderMessageRich = (message, bubbleIdx) => {
    if (!LABS_TOKEN_RE.test(message || "")) {
      return renderMessage(message);
    }
    const pieces = String(message).split(LABS_TOKEN_RE);

    const nodes = [];
    pieces.forEach((seg, idx) => {
      if (seg) {
        nodes.push(
          <div key={`seg-${bubbleIdx}-${idx}`}>{renderMessage(seg)}</div>
        );
      }
      if (idx < pieces.length - 1) {
        nodes.push(
          <InlineLabsCard
            key={`labs-${bubbleIdx}-${idx}`}
            onParsedLabs={handleParsedLabs}
            onStreamToken={(chunk) => {
              stripLabsTokenFromBubble(bubbleIdx);
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
              stripLabsTokenFromBubble(bubbleIdx);
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
      <style>{drawerComponentOverrides}</style>
      <audio ref={audioPlayerRef} playsInline style={{ display: "none" }} />
      <div className="chat-content">
        {chats.map((chat, index) => {
          const isRecordedAnalysis = chat?.type === "recorded-analysis" && chat?.data; /* 🔵 NEW */
          const isLabCard = chat?.type === "labs" && Array.isArray(chat.labs);
          return (
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
                {isRecordedAnalysis ? (
                  <RecordedCaseAnalysisBubble data={chat.data} />
                ) : isLabCard ? (
                  <LabsPanel labs={chat.labs} meta={chat.meta} />
                ) : (
                  <>
                    {renderMessageRich(chat.msg, index)}
                    {chat.streaming && <span className="typing-caret" />}
                  </>
                )}
              </div>
            </div>
          );
        })}
        <div ref={scrollAnchorRef} />
      </div>

      <div className="chat-footer">
        <ChatInputWidget onSendMessage={handleNewMessage} />
      </div>

      <button className="voice-toggle-button" onClick={handleEnterVoiceMode}>
        🎙️
      </button>

      {/* Drawer with tools (max 3 per row; 4th wraps) */}
      <DrawComponent>
        {/* 1) Record case / voice recorder */}
        <div className="tool-wrapper">
          <VoiceRecorderPanel
            transcribeUrl={`${BACKEND_BASE}/transcribe`}
            opinionUrl={`${BACKEND_BASE}/case-second-opinion-stream`}
            fileFieldName="audio_data"
            onOpinion={handleOpinionStream}
            onTranscriptReady={handleAssistantContextTranscript}
          />
        </div>

        {/* 2) Lab results uploader */}
        <div className="tool-wrapper">
          <div className="labs-uploader-fixed">
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
              ocrLanguage="eng"
              engine="2"
              onParsedLabs={handleParsedLabs}
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
                  (typeof payload === "string"
                    ? payload
                    : JSON.stringify(payload));
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
                  return [
                    ...updated,
                    { msg: normalizeMarkdown(full || ""), who: "bot" },
                  ];
                });
              }}
            />
          </div>
        </div>

        {/* 3) Medication checker uploader */}
        <div className="tool-wrapper">
          <div className="meds-uploader micro dense">
            <MedicationChecker
              ref={medUploaderRef}
              autoSend={true}
              ocrLanguage="eng"
              engine="2"
              onAIStreamToken={(chunk) => {
                if (!medsStreamingRef.current) {
                  medsStreamingRef.current = true;
                  medsBufferRef.current = "";
                  setChats((prev) => [
                    ...prev,
                    { msg: "", who: "bot", streaming: true },
                  ]);
                }
                medsBufferRef.current += String(chunk || "");
                setChats((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.streaming) last.msg = medsBufferRef.current;
                  return updated;
                });
              }}
              onBeforeSendToAI={(text, meta) =>
                [
                  "You are a clinical pharmacology assistant specializing in medication reconciliation and interaction checking.",
                  "Input below contains OCR-extracted medication lists (may include free text, photos, or CCD text).",
                  "Tasks:",
                  "1) Normalize names to RxNorm ingredients/brands; include RxNorm CUIs where possible.",
                  "2) Flag duplicates (same ingredient, class, or therapeutic overlap).",
                  "3) Check adult dose ranges (typical) and highlight out-of-range doses.",
                  "4) Interaction check (major/moderate/minor) with brief mechanisms and clinical actions.",
                  "5) Black-box warnings and major contraindications (cross-check DailyMed).",
                  "6) Output a concise, actionable summary with bullet points, and a table of findings.",
                  `SOURCE FILE: ${meta?.filename || "Unknown"}`,
                  "",
                  "=== MED LIST (OCR) ===",
                  text,
                ].join("\n")
              }
              onAIResponse={(payload) => {
                const full =
                  payload?.text ??
                  (typeof payload === "string"
                    ? payload
                    : JSON.stringify(payload));
                setChats((prev) => {
                  const updated = [...prev];
                  if (medsStreamingRef.current) {
                    medsStreamingRef.current = false;
                    const last = updated[updated.length - 1];
                    if (last && last.streaming) {
                      last.streaming = false;
                      last.msg = normalizeMarkdown(full || "");
                      return updated;
                    }
                  }
                  return [
                    ...updated,
                    { msg: normalizeMarkdown(full || ""), who: "bot" },
                  ];
                });
              }}
            />
          </div>
        </div>

        {/* 4) Dosage calculator button (second row) */}
        <div className="tool-wrapper">
          <CalculateDosageButton />
        </div>

        {/* 5) Medical image analyzer (Vision) — placed alongside calculator on second row */}
        <div className="tool-wrapper">
          <MedicalImageAnalyzer
            onResult={(text, meta) => {
              setChats((prev) => [
                ...prev,
                {
                  who: "bot",
                  msg: normalizeMarkdown(
                    [
                      "**Medical Image Analysis (Vision)**",
                      meta?.filename ? `*Source:* ${meta.filename}` : null,
                      "",
                      text,
                    ]
                      .filter(Boolean)
                      .join("\n")
                  ),
                },
              ]);
            }}
          />
        </div>
      </DrawComponent>
    </div>
  );
};

export default Chat;

/* Drawer wrapper */
const DrawComponent = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      style={{ position: "fixed", bottom: "25px", left: "25px", zIndex: 100 }}
    >
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="tools-grid"                        // ← add this
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            style={{
              minWidth: "480px",
              background: "rgba(255, 255, 255, 0.9)",
              backdropFilter: "blur(10px)",
              borderRadius: "16px",
              boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
              border: "1px solid rgba(0,0,0,0.08)",

              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              columnGap: "16px",
              rowGap: "16px",
              alignItems: "start",
              justifyItems: "center",
              padding: "16px",
              marginBottom: "12px",
            }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          border: "none",
          background: "#3750D8",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "24px",
          cursor: "pointer",
          boxShadow: "0 4px 15px rgba(0,0,0,0.2)",
          transition: "transform 0.2s, background-color 0.2s",
          float: "left",
          position: "relative",
          bottom: "12px",
          marginBottom: "8px",
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1.0)")}
        title="Toggle Tools"
        aria-label="Toggle tools drawer"
      >
        {isOpen ? "✖" : "🛠️"}
      </button>
    </div>
  );
};

/* Mermaid collapsible (unchanged) */
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

/* ===== Visual Labs Panel (unchanged) ===== */
function LabsPanel({ labs = [], meta }) {
  const valid = (Array.isArray(labs) ? labs : []).filter((l) => {
    const v = toNum(l?.value);
    const hasRange =
      Number.isFinite(toNum(l?.low)) && Number.isFinite(toNum(l?.high));
    const hasAI =
      l?.status &&
      ["normal", "borderline", "abnormal"].includes(
        String(l.status).toLowerCase()
      );
    return Number.isFinite(v) && (hasRange || hasAI);
  });

  if (!valid.length) {
    return (
      <div className="labs-panel">
        <div className="labs-panel__header">
          <div>
            <div className="labs-panel__title">Lab Summary</div>
            {meta?.filename && (
              <div className="labs-panel__meta">Source: {meta.filename}</div>
            )}
          </div>
        </div>
        <div className="labs-panel__body">
          <div className="labs-panel__empty">
            No parsable lab values were found in this upload.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="labs-panel">
      <div className="labs-panel__header">
        <div>
          <div className="labs-panel__title">Lab Summary</div>
          {meta?.filename && (
            <div className="labs-panel__meta">Source: {meta.filename}</div>
          )}
        </div>
        <div className="labs-panel__legend">
          <span className="chip chip--green" /> Normal
          <span className="chip chip--yellow" /> Borderline
          <span className="chip chip--red" /> Abnormal
          <span className="chip chip--dot" /> Value
        </div>
      </div>

      <div className="labs-panel__body">
        {valid.map((lab, idx) => (
          <LabRow lab={lab} key={idx} />
        ))}
      </div>
    </div>
  );
}

function LabRow({ lab }) {
  const name = lab?.name || "Unknown";
  const unit = lab?.unit || "";
  const value = toNum(lab?.value);
  const low = toNum(lab?.low);
  const high = toNum(lab?.high);
  const aiStatus = (lab?.status || "").toLowerCase(); // "normal" | "borderline" | "abnormal"

  // Build scale
  let min, max, band;
  if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
    const span = high - low;
    min = low - Math.max(0.25 * span, 0.01 * Math.abs(high));
    max = high + Math.max(0.25 * span, 0.01 * Math.abs(high));
    band = Math.max(0.075 * span, 1e-6);
  } else {
    min = 0;
    max = 1;
    band = 0.2;
  }
  const clamp = (x) => Math.min(Math.max(x, min), max);
  const posPct = Number.isFinite(value)
    ? ((clamp(value) - min) / (max - min)) * 100
    : 50;

  // Segment widths
  let redL = 0,
    yellowL = 0,
    green = 0,
    yellowR = 0,
    redR = 0;

  if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
    const leftRedEnd = Math.max(min, low - band);
    const leftYellowEnd = Math.min(low + band, high);
    const rightYellowBeg = Math.max(high - band, low);
    const rightRedStart = Math.min(high + band, max);

    const total = (max - min) || 1;
    redL = ((leftRedEnd - min) / total) * 100;
    yellowL = ((leftYellowEnd - leftRedEnd) / total) * 100;
    green = ((rightYellowBeg - leftYellowEnd) / total) * 100;
    yellowR = ((rightRedStart - rightYellowBeg) / total) * 100;
    redR = ((max - rightRedStart) / total) * 100;

    redL = Math.max(0, redL);
    yellowL = Math.max(0, yellowL);
    green = Math.max(0, green);
    yellowR = Math.max(0, yellowR);
    redR = Math.max(0, redR);
  } else {
    if (aiStatus === "normal") green = 100;
    else if (aiStatus === "borderline") yellowL = 100;
    else if (aiStatus === "abnormal") redL = 100;
    else yellowL = 100;
  }

  // Status badge
  let status = "neutral";
  if (["normal", "borderline", "abnormal"].includes(aiStatus)) status = aiStatus;
  else if (
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    Number.isFinite(value)
  ) {
    if (value < low || value > high) status = "abnormal";
    else if (Math.abs(value - low) <= band || Math.abs(value - high) <= band)
      status = "borderline";
    else status = "normal";
  }

  return (
    <div className="lab-row">
      <div className="lab-row__left">
        <div className="lab-row__name">{name}</div>
        <div className="lab-row__range">
          {Number.isFinite(low) && Number.isFinite(high) ? (
            <>
              Normal range: {low} – {high} {unit}
            </>
          ) : (
            <em>Normal range: unknown</em>
          )}
        </div>
      </div>

      <div className="lab-row__bar">
        <div className="range-label" aria-hidden>
          {Number.isFinite(low) && Number.isFinite(high)
            ? `NORMAL RANGE ${low} – ${high} ${unit}`
            : ""}
        </div>
        <div className="bar">
          {redL > 0 && (
            <div className="seg seg--red" style={{ flexBasis: `${redL}%` }} />
          )}
          {yellowL > 0 && (
            <div
              className="seg seg--yellow"
              style={{ flexBasis: `${yellowL}%` }}
            />
          )}
          {green > 0 && (
            <div className="seg seg--green" style={{ flexBasis: `${green}%` }} />
          )}
          {yellowR > 0 && (
            <div
              className="seg seg--yellow"
              style={{ flexBasis: `${yellowR}%` }}
            />
          )}
          {redR > 0 && (
            <div className="seg seg--red" style={{ flexBasis: `${redR}%` }} />
          )}

          <div className="indicator" style={{ left: `${posPct}%` }} />
        </div>
      </div>

      <div className={`lab-row__value lab-row__value--${status}`}>
        {Number.isFinite(value) ? `${value} ${unit}` : "—"}
      </div>
    </div>
  );
}

function toNum(x) {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const t = x.trim().replace(",", ".");
    const m = t.match(/^[-+]?\d+(?:\.\d+)?$/);
    if (m) return parseFloat(m[0]);
  }
  return NaN;
}



