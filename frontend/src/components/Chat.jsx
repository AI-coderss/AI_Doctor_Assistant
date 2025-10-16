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
import "../styles/labs-viz.css";

import { encodeWAV } from "./pcmToWav.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";
import VoiceRecorderPanel from "./VoiceRecorderPanel";
import useLiveTranscriptStore from "../store/useLiveTranscriptStore";
import LabResultsUploader from "./LabResultsUploader";
import MedicationChecker from "./MedicationChecker";
import useDosageStore from "../store/dosageStore";
import CalculateDosageButton from "./CalculateDosageButton";
import MedicalImageAnalyzer from "./MedicalImageAnalyzer";
import { Howl } from "howler";

/* Highcharts for recorded-case visuals */
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

let localStream;
const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

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

/* === Recorded Case Analysis bubble (donuts + bar + accordions) === */
function RecordedCaseAnalysisBubble({ data, topK = 5 }) {
  const diagnoses = Array.isArray(data?.diagnoses)
    ? data.diagnoses.slice(0, topK)
    : [];
  const labs = Array.isArray(data?.labs) ? data.labs : [];
  const radiology = Array.isArray(data?.radiology) ? data.radiology : [];
  const recommendations = Array.isArray(data?.recommendations)
    ? data.recommendations
    : [];
  const notes = typeof data?.notes === "string" ? data.notes : "";

  const donutOptions = (label, p) => ({
    chart: {
      type: "pie",
      backgroundColor: "transparent",
      height: 140,
      width: 140,
      margin: [0, 0, 0, 0],
    },
    title: {
      text: `${Math.round((p || 0) * 100)}%`,
      align: "center",
      verticalAlign: "middle",
      y: 6,
    },
    tooltip: { enabled: false },
    plotOptions: {
      pie: {
        innerSize: "70%",
        dataLabels: { enabled: false },
        states: { hover: { enabled: false } },
        animation: { duration: 250 },
      },
    },
    series: [
      {
        name: label,
        data: [
          { name: label, y: Math.max(0.001, p || 0) },
          { name: "other", y: 1 - Math.max(0.001, p || 0) },
        ],
      },
    ],
    credits: { enabled: false },
    legend: { enabled: false },
  });

  const barOptions = useMemo(
    () => ({
      chart: {
        type: "bar",
        backgroundColor: "transparent",
        height: Math.max(220, 60 + 26 * diagnoses.length),
      },
      title: { text: "Top comparison" },
      xAxis: { categories: diagnoses.map((d) => d.label), title: { text: null } },
      yAxis: {
        min: 0,
        max: 100,
        title: { text: "Probability (%)", align: "high" },
      },
      tooltip: { valueSuffix: "%" },
      plotOptions: {
        series: {
          animation: { duration: 250 },
          dataLabels: { enabled: true, format: "{point.y:.0f}%" },
        },
      },
      series: [
        {
          name: "Probability",
          data: diagnoses.map((d) => Math.round((d.p || 0) * 100)),
        },
      ],
      credits: { enabled: false },
    }),
    [diagnoses]
  );

  return (
    <div className="rca-bubble">
      <div className="rca-top">
        {diagnoses.map((d) => (
          <div className="rca-donut" key={d.label}>
            <HighchartsReact
              highcharts={Highcharts}
              options={donutOptions(d.label, d.p)}
            />
            <div className="rca-label">{d.label}</div>
            {Array.isArray(d.icd10) && d.icd10.length > 0 && (
              <div className="rca-icd">
                ICD-10: {d.icd10.slice(0, 3).join(", ")}
              </div>
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
        <ul className="rca-list">
          {radiology.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </details>

      <details className="rca-accordion">
        <summary>Recommendations to the doctor</summary>
        <ul className="rca-list">
          {recommendations.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </details>

      <details className="rca-accordion">
        <summary>Clinical notes</summary>
        <div className="rca-notes">{notes}</div>
      </details>
    </div>
  );
}

/* === Utilities === */
// Robustly strip a trailing JSON object from text and return {plain, jsonObj|null}
function stripTrailingJson(text) {
  if (!text) return { plain: "", json: null };
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    return { plain: text, json: null };
  const maybe = text.slice(start, end + 1);
  try {
    const json = JSON.parse(maybe);
    return { plain: text.slice(0, start).trimEnd(), json };
  } catch {
    return { plain: text, json: null };
  }
}

/* ===== Main Chat component ===== */
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

  /* Live transcript bubble lifecycle (unchanged) */
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

  /* === Voice recorder integration (no change to VoiceRecorderPanel.jsx) === */
  const opinionBufferRef = useRef("");
  const opinionStreamingRef = useRef(false);

  // Called repeatedly from VoiceRecorderPanel while the backend stream is in-flight
  const handleOpinionStream = (chunkOrFull, done = false) => {
    // Finish case: stop streaming, extract JSON, replace visible text without JSON, then add analysis bubble
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
          (json.diagnoses ||
            json.labs ||
            json.radiology ||
            json.recommendations ||
            json.notes)
        ) {
          updated.push({ who: "bot", type: "recorded-analysis", data: json });
        }
        return updated;
      });
      return;
    }

    // Streaming chunks
    const chunk = String(chunkOrFull || "");
    if (!opinionStreamingRef.current) {
      opinionStreamingRef.current = true;
      opinionBufferRef.current = "";
      setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
    }
    opinionBufferRef.current += chunk;

    setChats((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.streaming) last.msg = opinionBufferRef.current;
      return updated;
    });
  };

  const handleAssistantContextTranscript = async (transcript) => {
    try {
      const t = (transcript || "").trim();
      if (!t) return;
      await fetch(`${BACKEND_BASE}/set-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript: t }),
      });
      try {
        const store = useDosageStore.getState();
        store.setTranscript?.(t);
        store.setSessionId?.(sessionId);
      } catch {}
    } catch (e) {
      console.error("Failed to send transcript context:", e);
    }
  };

  /* === Basic text chat (unchanged) === */
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

  if (isVoiceMode) {
    return (
      <div className="voice-assistant-wrapper">
        <audio
          ref={audioPlayerRef}
          className="hidden-audio"
          playsInline
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
              onClick={() => {
                /* toggled externally in your voice-mode module */
              }}
              disabled={connectionStatus === "connecting"}
              title="Toggle microphone"
            >
              <FaMicrophoneAlt />
            </button>
            <button
              className="closed-btn"
              onClick={() => {
                try {
                  useAudioStore.getState().stopAudio?.();
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
              }}
              title="Close voice session"
            >
              ✖
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ======== Tools Drawer ======== */
  return (
    <div className="chat-layout">
      <audio ref={audioPlayerRef} className="hidden-audio" playsInline />
      <div className="chat-content">
        {chats.map((chat, index) => {
          const isRecordedAnalysis =
            chat?.type === "recorded-analysis" && chat?.data;
          const isLabCard = chat?.type === "labs" && Array.isArray(chat.labs);
          return (
            <div
              key={index}
              className={`chat-message ${chat.who} ${
                chat.live ? "live" : ""
              } ${chat.streaming ? "streaming" : ""}`}
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
                    {renderMessage(chat.msg)}
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

      <button
        className="voice-toggle-button"
        onClick={() => setIsVoiceMode(true)}
        title="Enter voice mode"
      >
        🎙️
      </button>

      <ToolsDrawer>
        {/* 1) Voice recorder (Record → Transcribe → Stream second opinion) */}
        <div className="tool-wrapper">
          <VoiceRecorderPanel
            transcribeUrl={`${BACKEND_BASE}/transcribe`}
            opinionUrl={`${BACKEND_BASE}/case-second-opinion-stream`}
            fileFieldName="audio_data"
            onOpinion={handleOpinionStream} // stream text, then parse trailing JSON
            onTranscriptReady={handleAssistantContextTranscript}
          />
        </div>

        {/* 2) Lab results uploader */}
        <div className="tool-wrapper">
          <div className="labs-uploader-fixed">
            <LabResultsUploader
              autoSend={true}
              ocrLanguage="eng"
              engine="2"
              onParsedLabs={(labs, meta) => {
                if (!Array.isArray(labs) || labs.length === 0) return;
                setChats((prev) => [
                  ...prev,
                  { who: "bot", type: "labs", labs, meta: meta || null },
                ]);
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
                setChats((prev) => {
                  const isStreaming =
                    prev.length > 0 && prev[prev.length - 1]?.streaming;
                  if (!isStreaming) {
                    return [...prev, { msg: String(chunk || ""), who: "bot", streaming: true }];
                  }
                  const updated = [...prev];
                  updated[updated.length - 1].msg += String(chunk || "");
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
                  const last = updated[updated.length - 1];
                  if (last && last.streaming) {
                    last.streaming = false;
                    last.msg = normalizeMarkdown(full || "");
                    return updated;
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

        {/* 3) Medication checker */}
        <div className="tool-wrapper">
          <div className="meds-uploader micro dense">
            <MedicationChecker
              autoSend={true}
              ocrLanguage="eng"
              engine="2"
              onAIStreamToken={(chunk) => {
                setChats((prev) => {
                  const isStreaming =
                    prev.length > 0 && prev[prev.length - 1]?.streaming;
                  if (!isStreaming) {
                    return [...prev, { msg: String(chunk || ""), who: "bot", streaming: true }];
                  }
                  const updated = [...prev];
                  updated[updated.length - 1].msg += String(chunk || "");
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
                  const last = updated[updated.length - 1];
                  if (last && last.streaming) {
                    last.streaming = false;
                    last.msg = normalizeMarkdown(full || "");
                    return updated;
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

        {/* 4) Dosage calculator */}
        <div className="tool-wrapper">
          <CalculateDosageButton />
        </div>

        {/* 5) Medical image analyzer */}
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
      </ToolsDrawer>
    </div>
  );
};

export default Chat;

/* Drawer wrapper (CSS-only layout; no inline styles) */
const ToolsDrawer = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="tools-toggle-container">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="tools-grid"
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="tools-toggle-btn"
        title="Toggle Tools"
      >
        {isOpen ? "✖" : "🛠️"}
      </button>
    </div>
  );
};

/* Mermaid collapsible (kept) */
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

/* ===== Visual Labs Panel ===== */
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



