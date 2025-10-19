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
import { FaMicrophoneAlt, FaFlask } from "react-icons/fa";
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

// 🧪 NEW: Lab Voice Agent (VAD, suggestions + approve)
import LabVoiceAgent from "./LabVoiceAgent.jsx";

let localStream;
const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

// Force fixed-position pieces to play nicely in the drawer + Second Opinion styling (no accordions).
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

  .labs-prompt { width: 100%; margin: 0 0 8px 0; }

  /* --- Second Opinion (flat sections, larger donuts) --- */
  .so-card {
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 16px;
    background: rgba(255,255,255,0.96);
    box-shadow: 0 8px 28px rgba(0,0,0,0.10);
    padding: 16px;
  }
  .so-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 14px;
  }
  .so-title { font-weight: 800; font-size: 18px; }
  .so-sub { font-size: 13px; opacity: 0.8; }
  .so-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 999px;
    background: rgba(55,80,216,0.08);
    border: 1px solid rgba(55,80,216,0.25);
    font-size: 12px; font-weight: 700;
  }

  .so-section {
    border: 1px dashed rgba(0,0,0,0.08);
    border-radius: 12px;
    padding: 12px;
    background: #fff;
  }
  .so-sec-title { font-weight: 800; font-size: 14px; margin-bottom: 8px; }
  .so-grid { display: grid; grid-template-columns: repeat( auto-fit, minmax(260px, 1fr) ); gap: 12px; }

  /* Differential items with bigger donuts */
  .so-diffs { display: grid; grid-template-columns: repeat( auto-fit, minmax(280px, 1fr) ); gap: 12px; }
  .so-diff-item {
    display: flex; align-items: center; gap: 14px;
    border: 1px solid rgba(0,0,0,0.06); border-radius: 14px; padding: 10px; background: #fff;
  }
  .so-diff-meta { display: grid; gap: 4px; }
  .so-diff-name { font-weight: 800; font-size: 14px; }
  .so-diff-sub { font-size: 12px; opacity: 0.75; }

  .so-table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  .so-table th, .so-table td {
    border-bottom: 1px solid rgba(0,0,0,0.06); padding: 8px 6px; text-align: left;
  }

  .so-narrative {
    border: 1px solid rgba(0,0,0,0.06);
    background: #fff; border-radius: 12px; padding: 12px;
  }

  /* Donut theme (CSS vars for easy theming) */
  :root {
    --donut-fill: #3750D8;
    --donut-track: #E5E7EB;
    --donut-text: #111827;
    --donut-subtext: #6B7280;
  }

  /* Required labs bubble */
  .req-labs { border: 1px solid rgba(0,0,0,0.08); border-radius: 14px; background: #fff; padding: 12px; }
  .req-labs .title { font-weight: 800; margin-bottom: 8px; }
  .req-chip {
    display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:12px;
    border:1px solid rgba(0,0,0,0.08); margin: 4px 6px 0 0; background: #f8fafc; font-size: 12.5px;
  }
  .req-chip .why { opacity: .7; font-size: 11.5px; }
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

/* ---------- Helpers for Second Opinion JSON extraction ---------- */
function extractJsonBlock(text = "") {
  const fence = /```json([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) return fence[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function tryParseJsonLoose(raw) {
  if (!raw) return null;
  let s = raw;
  s = s.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  try {
    return JSON.parse(s);
  } catch {
    s = s.replace(/^\uFEFF/, "").replace(/```/g, "");
    try { return JSON.parse(s); } catch { return null; }
  }
}

function ensureOpinionShape(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {
    primary_diagnosis: obj.primary_diagnosis || null,
    differential_diagnosis: Array.isArray(obj.differential_diagnosis) ? obj.differential_diagnosis : [],
    recommended_labs: Array.isArray(obj.recommended_labs) ? obj.recommended_labs : [],
    imaging: Array.isArray(obj.imaging) ? obj.imaging : [],
    prescriptions: Array.isArray(obj.prescriptions) ? obj.prescriptions : [],
    recommendations: Array.isArray(obj.recommendations) ? obj.recommendations : [],
    treatment_plan: Array.isArray(obj.treatment_plan) ? obj.treatment_plan : [],
    services: Array.isArray(obj.services) ? obj.services : []
  };
  out.differential_diagnosis = out.differential_diagnosis.map((d) => {
    const p = Math.max(0, Math.min(100, Math.round(Number(d?.probability_percent || 0))));
    return {
      name: d?.name || "Unknown",
      probability_percent: p,
      icd10: (d?.icd10 == null || d?.icd10 === "") ? null : String(d.icd10)
    };
  });
  return out;
}

/* ---------- Donut chart (pure SVG) — larger, crisp, no animation ---------- */
function Donut({ value = 0, size = 140, stroke = 16, label = "" }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (v / 100) * c;
  const cx = size / 2, cy = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${v}%`}>
      {/* track */}
      <circle cx={cx} cy={cy} r={r} strokeWidth={stroke} stroke="var(--donut-track)" fill="none" />
      {/* value */}
      <circle
        cx={cx} cy={cy} r={r} strokeWidth={stroke}
        stroke="var(--donut-fill)" strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`} fill="none"
      />
      {/* % text */}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        fontSize="18" fontWeight="800" fill="var(--donut-text)">{v}%</text>
    </svg>
  );
}

/* ---------- Second Opinion panel (no accordions; everything open) ---------- */
function SecondOpinionPanel({ data, narrative }) {
  const diffs = Array.isArray(data?.differential_diagnosis) ? data.differential_diagnosis : [];
  const primary = data?.primary_diagnosis;

  return (
    <div className="so-card">
      <div className="so-header">
        <div>
          <div className="so-title">AI Second Opinion</div>
          {primary?.name && (
            <div className="so-sub">
              Primary diagnosis: <span className="so-chip">{primary.name}{primary.icd10 ? ` • ${primary.icd10}` : ""}</span>
            </div>
          )}
        </div>
      </div>

      {/* Differential diagnosis with bigger donuts */}
      {diffs.length > 0 && (
        <div className="so-section" style={{ marginBottom: 12 }}>
          <div className="so-sec-title">Differential diagnosis (probabilities)</div>
          <div className="so-diffs">
            {diffs.map((d, i) => (
              <div className="so-diff-item" key={i}>
                <Donut value={d.probability_percent} label={d.name} />
                <div className="so-diff-meta">
                  <div className="so-diff-name">{d.name}</div>
                  <div className="so-diff-sub">Probability: <b>{d.probability_percent}%</b></div>
                  <div className="so-diff-sub">ICD-10: <code>{d.icd10 || "—"}</code></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ICD-10 table */}
      {diffs.length > 0 && (
        <div className="so-section" style={{ marginBottom: 12 }}>
          <div className="so-sec-title">ICD-10 Summary</div>
          <table className="so-table">
            <thead>
              <tr>
                <th>Diagnosis</th>
                <th>ICD-10</th>
                <th>Probability</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map((d, i) => (
                <tr key={i}>
                  <td>{d.name}</td>
                  <td><code>{d.icd10 || "—"}</code></td>
                  <td>{d.probability_percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Always-visible sections (no accordions) */}
      <div className="so-grid" style={{ marginBottom: 12 }}>
        {data?.recommended_labs?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Recommended lab tests & investigations</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.recommended_labs.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
        {data?.imaging?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Imaging / Radiology</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.imaging.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
        {data?.prescriptions?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Drug prescriptions</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.prescriptions.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
        {data?.recommendations?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Recommendations to the doctor</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.recommendations.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
        {data?.treatment_plan?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Treatment plan</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.treatment_plan.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
        {data?.services?.length > 0 && (
          <div className="so-section">
            <div className="so-sec-title">Services / Referrals</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.services.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Full narrative (always visible) */}
      {narrative && (
        <div className="so-narrative">
          <div className="so-sec-title" style={{ marginBottom: 6 }}>Narrative</div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{narrative}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function RequiredLabsBubble({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="req-labs">
      <div className="title">Required Labs (approved)</div>
      <div>
        {items.map((it, idx) => (
          <span key={idx} className="req-chip">
            <strong>{it.name}</strong>
            {it.priority && <span> • {it.priority}</span>}
            {it.why && <span className="why"> ({it.why})</span>}
          </span>
        ))}
      </div>
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

  // 🧪 NEW — Required labs (approved) & Lab Agent visibility
  const [requiredLabs, setRequiredLabs] = useState([]);
  const [showLabAgent, setShowLabAgent] = useState(false);

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
      try { toggleSfxRef.current?.unload(); } catch {}
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

  // Load current required labs on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_BASE}/lab-agent/list?session_id=${encodeURIComponent(sessionId)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.labs)) {
            setRequiredLabs(data.labs);
            if (data.labs.length) {
              setChats((prev) => [...prev, { who: "bot", type: "requiredLabs", labs: data.labs }]);
            }
          }
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        arr[liveIdxRef.current] = { ...arr[liveIdxRef.current], msg: liveText || "" };
        return arr;
      });
    }
    if (!isStreaming && liveIdxRef.current !== null && !finalizeTimerRef.current) {
      finalizeTimerRef.current = setTimeout(() => {
        setChats((prev) => {
          const arr = [...prev];
          const idx = liveIdxRef.current;
          if (arr[idx]) arr[idx] = { msg: liveText || arr[idx].msg || "", who: "me" };
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

  // Voice assistant
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
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!audioPlayerRef.current) return;
        audioPlayerRef.current.srcObject = stream;
        setAudioUrl(stream);
        audioPlayerRef.current.play().catch((err) => console.error("live stream play failed:", err));
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          console.error("ICE connection failed."); pc.close(); setConnectionStatus("error");
        }
      };
      pc.onicecandidateerror = (e) => console.error("ICE candidate error:", e);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "closed" || pc.connectionState === "failed") {
          setConnectionStatus("error"); setIsMicActive(false);
        }
      };

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

      const channel = pc.createDataChannel("response");
      channel.onopen = () => {
        setConnectionStatus("connected");
        setIsMicActive(true);
        channel.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] },
        }));
        channel.send(JSON.stringify({ type: "response.create" }));
        micStream?.getAudioTracks().forEach((track) => (track.enabled = true));
      };
      channel.onclose = () => { setConnectionStatus("idle"); setIsMicActive(false); };
      channel.onerror = (error) => { console.error("Data channel error:", error); setConnectionStatus("error"); setIsMicActive(false); };

      let offer;
      try {
        offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
        const modifiedOffer = {
          ...offer,
          sdp: offer.sdp.replace(
            /a=rtpmap:\d+ opus\/48000\/2/g,
            "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
          ),
        };
        await pc.setLocalDescription(modifiedOffer);
      } catch (e) {
        console.error("Failed to create/set offer:", e);
        pc.close(); setPeerConnection(null); setDataChannel(null);
        if (localStream) { localStream.getTracks().forEach((track) => track.stop()); localStream = null; }
        setConnectionStatus("error"); setIsMicActive(false); throw e;
      }

      const res = await fetch(
        `https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/rtc-connect?session_id=${sessionId}`,
        { method: "POST", headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId }, body: offer.sdp }
      );
      if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      console.error("WebRTC setup failed:", error);
      setConnectionStatus("error"); setIsMicActive(false);
    }
  };

  const toggleMic = () => {
    if (connectionStatus === "idle" || connectionStatus === "error") { startWebRTC(); return; }
    if (connectionStatus === "connected" && localStream) {
      const newMicState = !isMicActive; setIsMicActive(newMicState);
      localStream.getAudioTracks().forEach((track) => (track.enabled = newMicState));
    }
  };

  const closeVoiceSession = () => {
    try { stopAudio?.(); } catch {}
    try { const { setAudioScale } = useAudioForVisualizerStore.getState(); setAudioScale(1); } catch {}
    if (audioPlayerRef.current) { try { audioPlayerRef.current.pause(); } catch {} audioPlayerRef.current.srcObject = null; audioPlayerRef.current.src = ""; }
    if (dataChannel && dataChannel.readyState !== "closed") { try { dataChannel.close(); } catch {} }
    if (peerConnection) { try { peerConnection.getSenders?.().forEach((s) => s.track?.stop()); } catch {} try { peerConnection.close(); } catch {} }
    if (localStream) { try { localStream.getTracks().forEach((t) => t.stop()); } catch {} localStream = null; }
    setDataChannel(null); setPeerConnection(null); setIsMicActive(false); setConnectionStatus("idle"); setIsVoiceMode(false);
  };

  const handleEnterVoiceMode = () => {
    setIsVoiceMode(true);
    if (audioPlayerRef.current) { audioPlayerRef.current.muted = true; audioPlayerRef.current.play().catch(() => {}); }
    try { if (toggleSfxRef.current) { toggleSfxRef.current.stop(); toggleSfxRef.current.play(); } } catch {}
  };

  // Text chat → /stream
  const handleNewMessage = async ({ text, skipEcho = false }) => {
    if (!text || !text.trim()) return;
    if (!skipEcho) setChats((prev) => [...prev, { msg: text, who: "me" }]);

    const res = await fetch(`${BACKEND_BASE}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session_id: sessionId }),
    });

    if (!res.ok || !res.body) {
      setChats((prev) => [...prev, { msg: "Something went wrong.", who: "bot" }]); return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let message = ""; let isFirstChunk = true;

    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      if (isFirstChunk) { setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]); isFirstChunk = false; }

      message += chunk;
      setChats((prev) => { const updated = [...prev]; updated[updated.length - 1].msg = message; return updated; });
    }

    setChats((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.streaming) { last.streaming = false; last.msg = normalizeMarkdown(last.msg); }
      return updated;
    });
  };

  // Markdown renderer (kept as-is)
  const renderMessage = (message) => {
    const regex = /```mermaid([\s\S]*?)```/g;
    const parts = []; let lastIndex = 0; let match;
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

  // ====== SECOND OPINION STREAM ======
  const opinionBufferRef = useRef("");
  const opinionStreamingRef = useRef(false);

  const finalizeSecondOpinion = () => {
    const full = opinionBufferRef.current || "";
    const jsonRaw = extractJsonBlock(full);
    const parsed = tryParseJsonLoose(jsonRaw);
    const shaped = ensureOpinionShape(parsed);

    setChats((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.streaming) { updated.pop(); }
      if (shaped) {
        // Keep narrative = prose after JSON block
        const prose = full.replace(jsonRaw || "", "").replace(/```json[\s\S]*?```/i, "").trim();
        updated.push({
          who: "bot",
          type: "secondOpinion",
          opinion: shaped,
          narrative: normalizeMarkdown(prose)
        });
        // Prompt for labs upload explicitly
        const needsLabs = Array.isArray(shaped.recommended_labs) ? shaped.recommended_labs.length > 0 : false;
        const labsPrompt = needsLabs
          ? "I can interpret recent lab reports to refine the differential. Please upload them here: [request_labs]"
          : "If you have recent lab results, upload them and I’ll integrate them: [request_labs]";
        updated.push({ who: "bot", msg: labsPrompt });
      } else {
        updated.push({ who: "bot", msg: normalizeMarkdown(full) });
      }
      return updated;
    });

    opinionBufferRef.current = "";
    opinionStreamingRef.current = false;
  };

  const handleOpinionStream = (chunkOrFull, done = false) => {
    if (done) { finalizeSecondOpinion(); return; }
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
      const t = (transcript || "").trim(); if (!t) return;
      await fetch(`${BACKEND_BASE}/set-context`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript: t }),
      });
      fetch("https://ai-doctor-assistant-voice-mode-webrtc.onrender.com/api/session-context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript: t }),
      }).catch(() => {});
      try { const store = useDosageStore.getState(); store.setTranscript?.(t); store.setSessionId?.(sessionId); } catch {}
    } catch (e) { console.error("Failed to send transcript context:", e); }
  };

  /** Specialty form streaming (if used elsewhere) */
  const handleFormStreamEvent = (evt) => {
    if (!evt || !evt.type) return;
    if (evt.type === "start") { setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]); return; }
    if (evt.type === "chunk") {
      const chunk = String(evt.data || "");
      setChats((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (!updated[lastIdx] || updated[lastIdx].who !== "bot") { updated.push({ msg: "", who: "bot", streaming: true }); }
        updated[updated.length - 1].msg = (updated[updated.length - 1].msg || "") + chunk;
        return updated;
      });
      return;
    }
    if (evt.type === "done") {
      setChats((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last) { if (last.streaming) last.streaming = false; last.msg = normalizeMarkdown(last.msg); }
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
    return t.includes("upload lab") || t.includes("attach lab") || t.includes("upload the lab") || t.includes("[request_labs]");
  }

  const LABS_TOKEN_RE = /\[request_labs\]/i;
  const LABS_TOKEN_RE_GLOBAL = /\[request_labs\]/gi;

  const stripLabsTokenFromBubble = (bubbleIdx) => {
    setChats((prev) => {
      const arr = [...prev];
      const target = arr[bubbleIdx];
      if (target && typeof target.msg === "string" && LABS_TOKEN_RE.test(target.msg)) {
        target.msg = target.msg.replace(LABS_TOKEN_RE_GLOBAL, "");
      }
      return arr;
    });
  };

  const handleParsedLabs = (labs, meta) => {
    if (!Array.isArray(labs) || labs.length === 0) return;
    setChats((prev) => [...prev, { who: "bot", type: "labs", labs, meta: meta || null }]);
  };

  /* ===================== Medication checker streaming ===================== */
  const medUploaderRef = useRef(null);
  const medsStreamingRef = useRef(false);
  const medsBufferRef = useRef("");

  // Build a single “context” string for the Lab Agent
  const buildAgentContext = () => {
    const transcript = useDosageStore.getState()?.transcript || "";
    const lastNarrative = (() => {
      for (let i = chats.length - 1; i >= 0; i--) {
        if (chats[i]?.type === "secondOpinion" && typeof chats[i].narrative === "string") {
          return chats[i].narrative;
        }
      }
      return "";
    })();

    return [
      "### Patient Consultation Transcript",
      transcript,
      "",
      "### Latest Second-Opinion Narrative",
      lastNarrative,
      "",
      "### Approved Required Labs so far",
      requiredLabs.map((l, i) => `${i + 1}. ${l.name}${l.priority ? ` [${l.priority}]` : ""}${l.why ? ` — ${l.why}` : ""}`).join("\n") || "None"
    ].join("\n");
  };

  // When a lab is approved inside LabVoiceAgent
  const handleApproveLab = async (item) => {
    const normalized = {
      name: String(item?.name || "").trim(),
      why: item?.why ? String(item.why).trim() : "",
      priority: item?.priority ? String(item.priority).trim() : "",
    };
    if (!normalized.name) return;

    // optimistic update
    setRequiredLabs((prev) => {
      const exists = prev.some((x) => x.name.toLowerCase() === normalized.name.toLowerCase());
      return exists ? prev : [...prev, normalized];
    });

    // render/update bubble in chat
    setChats((prev) => [...prev, { who: "bot", type: "requiredLabs", labs: [...requiredLabs, normalized] }]);
  };

  if (isVoiceMode) {
    return (
      <div className="voice-assistant-wrapper">
        <audio ref={audioPlayerRef} playsInline style={{ display: "none" }} controls={false} autoPlay onError={(e) => console.error("Audio error:", e.target.error)} />
        <div className="voice-stage-orb"><BaseOrb audioScale={audioScale} /></div>
        <div className="mic-controls">
          {connectionStatus === "connecting" && (<div className="connection-status connecting">🔄 Connecting...</div>)}
          <div>
            <button className={`mic-icon-btn ${isMicActive ? "active" : ""}`} onClick={toggleMic} disabled={connectionStatus === "connecting"}><FaMicrophoneAlt /></button>
            <button className="closed-btn" onClick={closeVoiceSession}>✖</button>
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
      if (seg) nodes.push(<div key={`seg-${bubbleIdx}-${idx}`}>{renderMessage(seg)}</div>);
      if (idx < pieces.length - 1) {
        nodes.push(
          <InlineLabsCard
            key={`labs-${bubbleIdx}-${idx}`}
            onParsedLabs={handleParsedLabs}
            onStreamToken={(chunk) => {
              stripLabsTokenFromBubble(bubbleIdx);
              if (!labsStreamingRef.current) {
                labsStreamingRef.current = true; labsBufferRef.current = "";
                setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
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
                  if (last && last.streaming) { last.streaming = false; last.msg = normalizeMarkdown(fullText || ""); return updated; }
                }
                return [...updated, { msg: normalizeMarkdown(fullText || ""), who: "bot" }];
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
          const isLabCard = chat?.type === "labs" && Array.isArray(chat.labs);
          const isSecondOpinion = chat?.type === "secondOpinion" && chat.opinion;
          const isReqLabs = chat?.type === "requiredLabs" && Array.isArray(chat.labs);
          return (
            <div key={index} className={`chat-message ${chat.who} ${chat.live ? "live" : ""} ${chat.streaming ? "streaming" : ""}`}>
              {chat.who === "bot" && (
                <figure className="avatar"><img src="/av.gif" alt="avatar" /></figure>
              )}
              <div className="message-text">
                {isLabCard ? (
                  <LabsPanel labs={chat.labs} meta={chat.meta} />
                ) : isSecondOpinion ? (
                  <SecondOpinionPanel data={chat.opinion} narrative={chat.narrative} />
                ) : isReqLabs ? (
                  <RequiredLabsBubble items={chat.labs} />
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

      <button className="voice-toggle-button" onClick={handleEnterVoiceMode}>🎙️</button>

      {/* Drawer with tools */}
      <DrawComponent>
        <div className="tool-wrapper">
          <VoiceRecorderPanel
            transcribeUrl={`${BACKEND_BASE}/transcribe`}
            opinionUrl={`${BACKEND_BASE}/case-second-opinion-stream`}
            fileFieldName="audio_data"
            onOpinion={handleOpinionStream}
            onTranscriptReady={handleAssistantContextTranscript}
          />
        </div>

        <div className="tool-wrapper">
          <div className="labs-uploader-fixed">
            {wantsLabs(lastBotText) && (
              <div
                className="labs-prompt"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 10, padding: "10px 12px", borderRadius: 12,
                  background: "rgba(255, 235, 59, 0.12)",
                  border: "1px solid rgba(255, 193, 7, 0.35)", boxShadow: "0 4px 16px rgba(0,0,0,.06)",
                }}
              >
                <div style={{ display: "grid", gap: 2 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Lab results requested</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Attach a PDF/image to interpret instantly.</div>
                </div>
                <button
                  style={{ padding: "8px 12px", borderRadius: 10, border: 0, cursor: "pointer",
                    background: "#0a66c2", color: "#fff", fontWeight: 600 }}
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
                  labsStreamingRef.current = true; labsBufferRef.current = "";
                  setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
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
                const full = payload?.text ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
                setChats((prev) => {
                  const updated = [...prev];
                  if (labsStreamingRef.current) {
                    labsStreamingRef.current = false;
                    const last = updated[updated.length - 1];
                    if (last && last.streaming) { last.streaming = false; last.msg = normalizeMarkdown(full || ""); return updated; }
                  }
                  return [...updated, { msg: normalizeMarkdown(full || ""), who: "bot" }];
                });
              }}
            />
          </div>
        </div>

        <div className="tool-wrapper">
          <div className="meds-uploader micro dense">
            <MedicationChecker
              ref={medUploaderRef}
              autoSend={true}
              ocrLanguage="eng"
              engine="2"
              onAIStreamToken={(chunk) => {
                if (!medsStreamingRef.current) {
                  medsStreamingRef.current = true; medsBufferRef.current = "";
                  setChats((prev) => [...prev, { msg: "", who: "bot", streaming: true }]);
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
                const full = payload?.text ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
                setChats((prev) => {
                  const updated = [...prev];
                  if (medsStreamingRef.current) {
                    medsStreamingRef.current = false;
                    const last = updated[updated.length - 1];
                    if (last && last.streaming) { last.streaming = false; last.msg = normalizeMarkdown(full || ""); return updated; }
                  }
                  return [...updated, { msg: normalizeMarkdown(full || ""), who: "bot" }];
                });
              }}
            />
          </div>
        </div>

        <div className="tool-wrapper"><CalculateDosageButton /></div>

        <div className="tool-wrapper">
          <MedicalImageAnalyzer
            onResult={(text, meta) => {
              setChats((prev) => [
                ...prev,
                { who: "bot", msg: normalizeMarkdown(
                  ["**Medical Image Analysis (Vision)**", meta?.filename ? `*Source:* ${meta.filename}` : null, "", text]
                    .filter(Boolean).join("\n")
                ) }
              ]);
            }}
          />
        </div>

        {/* 6) NEW — Lab Agent (voice + VAD + suggestions/approve) */}
        <div className="tool-wrapper">
          <button
            style={{
              padding: "10px 12px", borderRadius: 12, background: "#1f2937", color: "#fff",
              border: "1px solid rgba(0,0,0,0.1)", cursor: "pointer", fontWeight: 700, width: "100%", maxWidth: 160
            }}
            title="Open Lab Agent"
            onClick={() => setShowLabAgent(true)}
          >
            <FaFlask style={{ marginRight: 6 }} />
            Lab Agent
          </button>
        </div>
      </DrawComponent>

      {/* Overlay: LabVoiceAgent */}
      {showLabAgent && (
        <LabVoiceAgent
          isVisible={showLabAgent}
          onClose={() => setShowLabAgent(false)}
          sessionId={sessionId}
          backendBase={BACKEND_BASE}
          context={buildAgentContext()}
          onApproveLab={handleApproveLab}
        />
      )}
    </div>
  );
};

export default Chat;

// Drawer wrapper (unchanged)
const DrawComponent = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div style={{ position: "fixed", bottom: "25px", left: "25px", zIndex: 100 }}>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="tools-grid"
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
          width: "56px", height: "56px", borderRadius: "50%", border: "none",
          background: "#3750D8", color: "white", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: "24px", cursor: "pointer",
          boxShadow: "0 4px 15px rgba(0,0,0,0.2)", transition: "transform 0.2s, background-color 0.2s",
          float: "left", position: "relative", bottom: "12px", marginBottom: "8px",
        }}
        title="Toggle Tools"
      >
        {isOpen ? "✖" : "🛠️"}
      </button>
    </div>
  );
};

// Mermaid collapsible (used for non-SecondOpinion messages; kept as-is)
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

/* ===== Visual Labs Panel using AI classification (unchanged) ===== */
function LabsPanel({ labs = [], meta }) {
  const valid = (Array.isArray(labs) ? labs : []).filter((l) => {
    const v = toNum(l?.value);
    const hasRange = Number.isFinite(toNum(l?.low)) && Number.isFinite(toNum(l?.high));
    const hasAI = l?.status && ["normal", "borderline", "abnormal"].includes(String(l.status).toLowerCase());
    return Number.isFinite(v) && (hasRange || hasAI);
  });

  if (!valid.length) {
    return (
      <div className="labs-panel">
        <div className="labs-panel__header">
          <div>
            <div className="labs-panel__title">Lab Summary</div>
            {meta?.filename && <div className="labs-panel__meta">Source: {meta.filename}</div>}
          </div>
        </div>
        <div className="labs-panel__body">
          <div style={{ opacity: 0.7, fontSize: 13 }}>No parsable lab values were found in this upload.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="labs-panel">
      <div className="labs-panel__header">
        <div>
          <div className="labs-panel__title">Lab Summary</div>
          {meta?.filename && <div className="labs-panel__meta">Source: {meta.filename}</div>}
        </div>
        <div className="labs-panel__legend">
          <span className="chip chip--green" /> Normal
          <span className="chip chip--yellow" /> Borderline
          <span className="chip chip--red" /> Abnormal
          <span className="chip chip--dot" /> Value
        </div>
      </div>

      <div className="labs-panel__body">
        {valid.map((lab, idx) => (<LabRow lab={lab} key={idx} />))}
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
  const aiStatus = (lab?.status || "").toLowerCase();

  let min, max, band;
  if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
    const span = high - low;
    min = low - Math.max(0.25 * span, 0.01 * Math.abs(high));
    max = high + Math.max(0.25 * span, 0.01 * Math.abs(high));
    band = Math.max(0.075 * span, 1e-6);
  } else { min = 0; max = 1; band = 0.2; }
  const clamp = (x) => Math.min(Math.max(x, min), max);
  const posPct = Number.isFinite(value) ? ((clamp(value) - min) / (max - min)) * 100 : 50;

  let redL = 0, yellowL = 0, green = 0, yellowR = 0, redR = 0;
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

    redL = Math.max(0, redL); yellowL = Math.max(0, yellowL); green = Math.max(0, green);
    yellowR = Math.max(0, yellowR); redR = Math.max(0, redR);
  } else {
    if (aiStatus === "normal") green = 100;
    else if (aiStatus === "borderline") yellowL = 100;
    else if (aiStatus === "abnormal") redL = 100;
    else yellowL = 100;
  }

  let status = "neutral";
  if (["normal", "borderline", "abnormal"].includes(aiStatus)) status = aiStatus;
  else if (Number.isFinite(low) && Number.isFinite(high) && Number.isFinite(value)) {
    if (value < low || value > high) status = "abnormal";
    else if (Math.abs(value - low) <= band || Math.abs(value - high) <= band) status = "borderline";
    else status = "normal";
  }

  return (
    <div className="lab-row">
      <div className="lab-row__left">
        <div className="lab-row__name">{name}</div>
        <div className="lab-row__range">
          {Number.isFinite(low) && Number.isFinite(high) ? (<>Normal range: {low} – {high} {unit}</>) : (<em>Normal range: unknown</em>)}
        </div>
      </div>

      <div className="lab-row__bar">
        <div className="range-label" aria-hidden>
          {Number.isFinite(low) && Number.isFinite(high) ? `NORMAL RANGE ${low} – ${high} ${unit}` : ""}
        </div>
        <div className="bar">
          {redL > 0 && <div className="seg seg--red" style={{ flexBasis: `${redL}%` }} />}
          {yellowL > 0 && <div className="seg seg--yellow" style={{ flexBasis: `${yellowL}%` }} />}
          {green > 0 && <div className="seg seg--green" style={{ flexBasis: `${green}%` }} />}
          {yellowR > 0 && <div className="seg seg--yellow" style={{ flexBasis: `${yellowR}%` }} />}
          {redR > 0 && <div className="seg seg--red" style={{ flexBasis: `${redR}%` }} />}
          <div className="indicator" style={{ left: `${posPct}%` }} />
        </div>
      </div>

      <div className={`lab-row__value lab-row__value--${status}`}>
        {Number.isFinite(value) ? `${value} ${unit}` : "—"}
      </div>
    </div>
  );
}

function InlineLabsCard({ onStreamToken, onComplete, onParsedLabs }) {
  const localRef = useRef(null);

  return (
    <div style={{ margin: "10px 0", padding: "10px 12px", borderRadius: 12, background: "rgba(10,102,194,0.08)", border: "1px solid rgba(10,102,194,0.25)" }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Please upload the lab results (PDF/Image)</div>
      <LabResultsUploader
        ref={localRef}
        autoSend={true}
        ocrLanguage="eng"
        engine="2"
        dense={true}
        onParsedLabs={onParsedLabs}
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
          const full = payload?.text ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
          onComplete(full);
        }}
      />
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
