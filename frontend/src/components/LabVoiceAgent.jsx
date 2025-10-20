/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes } from "react-icons/fa";
import { motion, AnimatePresence, Reorder } from "framer-motion";

/* 🔊 Visualizer + audio store (adjust paths if your app differs) */
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/**
 * LabVoiceAgent (agent-led voice approvals; NO browser SR/TTS)
 * - Backend voice model asks for approval, parses replies, and emits events.
 * - Frontend listens over WebRTC data channel + SSE and updates UI; no buttons.
 *
 * Props:
 *  - isVisible: boolean
 *  - onClose: () => void
 *  - sessionId: string
 *  - backendBase: string
 *  - context: string
 *  - onApproveLab: (item: {id, name, why?, priority?}) => void
 *
 * Backend endpoints:
 *  POST /lab-agent/context        { session_id, context }
 *  POST /lab-agent/suggest-stream { session_id }  SSE "data: {json}\n\n"
 *  POST /lab-agent/rtc-connect?session_id=...  (Content-Type: application/sdp)
 *  POST /lab-agent/tool-bridge    { session_id, tool, args }
 */

export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
}) {
  const [status, setStatus] = useState("idle");      // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [pendingQueue, setPendingQueue] = useState([]);   // [{id, name, why, priority}]
  const [approvedLocal, setApprovedLocal] = useState([]); // [{id, name, why, priority}]
  const [askingText, setAskingText] = useState("");

  // Reorder state for framer-motion (must share the same objects)
  const [reorderList, setReorderList] = useState([]);

  // WebRTC
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // SSE
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

  // Text buffer (running transcript/log from agent)
  const textBufRef = useRef("");

  // Function-call buffers (Realtime delta -> completed args)
  const toolBuffersRef = useRef(new Map()); // id -> { name, argsText }

  // Visualizer stores
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

  // Local monotonic id counter (stable keys)
  const seqRef = useRef(0);

  const appendText = (s) => {
    textBufRef.current += s;
    setStreamingText(textBufRef.current);
  };

  const resetAll = () => {
    textBufRef.current = "";
    setStreamingText("");
    setPendingQueue([]);
    setApprovedLocal([]);
    setReorderList([]);
    setAskingText("");
  };

  useEffect(() => {
    if (!isVisible) {
      stopAll();
      return;
    }

    (async () => {
      try {
        setStatus("prepping");
        resetAll();
        await sendContext();
        await startVoice();       // voice (mic -> model; model -> audio) + data channel
        startSuggestStream();     // text/suggestion/approved SSE
      } catch (e) {
        console.error("Agent init failed:", e);
        setStatus("error");
      }
    })();

    return () => { stopAll(); };
  }, [isVisible]);

  // === Send conversation context (case transcript etc.) ===
  const sendContext = async () => {
    try {
      const res = await fetch(`${backendBase}/lab-agent/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context: context || "" }),
      });
      if (!res.ok) throw new Error(`/lab-agent/context ${res.status}`);
    } catch (e) {
      console.error("Failed to send context:", e);
    }
  };

  // === WebRTC: mic upstream; agent voice downstream; datachannel for events/tool-calls ===
  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      // 🔊 drive orb from MIC (input)
      try { startVolumeMonitoring(stream, setAudioScale); } catch {}

      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;

      // mic -> PC
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // agent voice -> audio element
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (!remoteStream) return;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play?.().catch((err) => console.warn("Agent audio play failed:", err));
        }
        // 🔊 expose remote stream to the app; also let orb react to OUTPUT
        try { setAudioUrl(remoteStream); } catch {}
        try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
      };

      // Accept any DataChannel label; wire for LLM tool-calls + JSON events
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        if (!ch) return;
        wireDataChannel(ch);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
          setMicActive(true);
        } else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed" ||
          pc.connectionState === "disconnected"
        ) {
          setStatus("error");
          setMicActive(false);
        }
      };

      // SDP Offer/Answer
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      const patchedOffer = {
        ...offer,
        sdp: offer.sdp.replace(
          /a=rtpmap:\d+ opus\/48000\/2/g,
          "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
        ),
      };
      await pc.setLocalDescription(patchedOffer);

      const res = await fetch(
        `${backendBase}/lab-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
        { method: "POST", headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId }, body: patchedOffer.sdp }
      );
      if (!res.ok) throw new Error(`/lab-agent/rtc-connect ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      console.error("startVoice error:", err);
      setStatus("error");
      setMicActive(false);
      throw err;
    }
  };

  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch {}

      // 1) Realtime tool-calling deltas
      if (msg && (msg.type === "response.function_call.arguments.delta" || msg.type === "tool_call.delta")) {
        const id = msg.call_id || msg.id || "default";
        const name = msg.name || msg.function_name || "";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name, argsText: "" };
        prev.name = name || prev.name;
        prev.argsText += delta || "";
        toolBuffersRef.current.set(id, prev);
        return;
      }

      // 2) Realtime tool-calling completed
      if (msg && (msg.type === "response.function_call.completed" || msg.type === "tool_call.completed")) {
        const id = msg.call_id || msg.id || "default";
        const buf = toolBuffersRef.current.get(id);
        toolBuffersRef.current.delete(id);
        if (!buf || !buf.name) return;

        let args = {};
        try { args = JSON.parse(buf.argsText || "{}"); } catch {}

        const tool = mapToolName(buf.name);
        fetch(`${backendBase}/lab-agent/tool-bridge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, tool, args }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data?.applied && (tool === "approve_lab" || tool === "add_lab_manual")) {
              const item = normalizeItem(data.item || args, true);
              if (!item) return;
              applyApproved(item);
            }
          })
          .catch((e) => console.error("tool-bridge failed:", e));
        return;
      }

      // 3) Structured JSON event
      if (msg && msg.type) {
        handleStreamEvent(msg);
        return;
      }

      // 4) Plain text fallback
      appendText(raw);
      softApproveFromText(raw);
    };

    ch.onerror = (e) => console.error("DataChannel error:", e);
  }

  function mapToolName(n) {
    const s = String(n || "").toLowerCase();
    if (s.includes("reject")) return "reject_lab";
    if (s.includes("manual")) return "add_lab_manual";
    if (s.includes("approve") || s.includes("add")) return "approve_lab";
    return "approve_lab";
  }

  const stopAll = () => {
    try { sseAbortRef.current?.abort(); } catch {}
    sseAbortRef.current = null;
    sseReaderRef.current = null;

    try {
      if (pcRef.current) {
        pcRef.current.getSenders?.().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    try { localStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
    localStreamRef.current = null;

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.src = "";
      }
    } catch {}

    setMicActive(false);
    setStatus("idle");
  };

  // === Suggestion stream (SSE) ===
  const startSuggestStream = async () => {
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;

    try {
      const res = await fetch(`${backendBase}/lab-agent/suggest-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/lab-agent/suggest-stream ${res.status}`);

      const reader = res.body.getReader();
      sseReaderRef.current = reader;
      const decoder = new TextDecoder();

      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // split by SSE frames (prevents partial dupes)
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line) continue;
          const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
          if (!payload) continue;
          try {
            const msg = JSON.parse(payload);
            handleStreamEvent(msg);
          } catch {
            appendText(payload + "\n");
            softApproveFromText(payload);
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.error("suggest-stream error:", e);
      appendText("\n\n[stream ended]");
    }
  };

  // === Helpers ===
  const makeId = (name) => {
    // stable-enough unique key for this session render
    const seq = ++seqRef.current;
    const slug = String(name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-().+/]/g, "");
    return `${slug}::${Date.now()}::${seq}`;
  };

  const normalizeItem = (raw, forceId = false) => {
    if (!raw) return null;
    const name = ((raw.name || raw.test || "") + "").trim();
    if (!name) return null;
    const base = {
      id: raw.id && !forceId ? String(raw.id) : makeId(name),
      name,
      why: raw.why ? String(raw.why).trim() : "",
      priority: raw.priority ? String(raw.priority).trim() : "",
    };
    return base;
  };

  const hasByName = (arr, nm) =>
    (arr || []).some((x) => String(x.name || "").trim().toLowerCase() === String(nm || "").trim().toLowerCase());

  const removePendingByName = (nm) => {
    const low = String(nm || "").toLowerCase();
    setPendingQueue((prev) => prev.filter((x) => (x.name || "").toLowerCase() !== low));
    setReorderList((prev) => prev.filter((x) => (x.name || "").toLowerCase() !== low));
  };

  // Fallback: approve from plain text like "Approved CBC" / "yes add CMP"
  const softApproveFromText = (txt) => {
    const t = (txt || "").toLowerCase();
    const m = t.match(/\b(approved|approve|add|yes)\b[:\s-]*([a-z0-9 .+\-/()]+)$/i);
    if (!m) return;
    const name = (m[2] || "").trim();
    if (!name) return;

    if (hasByName(approvedLocal, name)) return;

    const item = normalizeItem({ name }, true);
    applyApproved(item);
  };

  const applyApproved = (item) => {
    const nm = String(item?.name || "").trim();
    if (!nm) return;

    removePendingByName(nm);

    setApprovedLocal((prev) => (hasByName(prev, nm) ? prev : [...prev, item]));
    try { onApproveLab?.(item); } catch {}
    if (askingText && askingText.toLowerCase().includes(nm.toLowerCase())) setAskingText("");
  };

  // Unified handler for SSE + data-channel JSON events
  const handleStreamEvent = (msg) => {
    const t = String(msg?.type || "").toLowerCase();

    if (t === "delta" || t === "text") {
      const c = String(msg.content || "");
      if (c) {
        appendText(c);
        softApproveFromText(c);
      }
      return;
    }

    if (t === "suggestion" || t === "pending" || t === "proposed") {
      const itm = normalizeItem(msg.item || msg, true);
      if (!itm) return;

      // De-dupe by NAME against both pending & approved
      if (hasByName(approvedLocal, itm.name)) return;
      if (hasByName(pendingQueue, itm.name)) return;

      setPendingQueue((prev) => {
        const next = [...prev, itm];
        setReorderList(next);
        return next;
      });
      return;
    }

    if (t === "ask") {
      setAskingText(String(msg.prompt || ""));
      return;
    }

    if (t === "approved" || t === "approval" || t === "lab_approved") {
      const itm = normalizeItem(msg.item || msg, true);
      if (!itm) return;
      applyApproved(itm);
      return;
    }

    if (t === "rejected" || t === "lab_rejected") {
      const itm = normalizeItem(msg.item || msg, true);
      if (!itm) return;
      removePendingByName(itm.name);
      if (askingText && itm.name && askingText.toLowerCase().includes(itm.name.toLowerCase())) {
        setAskingText("");
      }
      return;
    }

    if (t === "end") return;

    // Fallback: raw string-ish event
    if (typeof msg === "string") {
      appendText(msg + "\n");
      softApproveFromText(msg);
    }
  };

  // === UI ===
  if (!isVisible) return null;

  return (
    <div className="voice-assistant" style={{ zIndex: 1000 }}>
      {/* hidden audio element for agent voice */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

      {/* Agent orb & header */}
      <div className="assistant-orb"><BaseOrb className="base-orb" /></div>

      <button className="close-btn" onClick={() => { onClose?.(); }}>
        <FaTimes />
      </button>

      <div className="assistant-content">
        <div className="va-header">
          <div className="va-title"><FaFlask style={{ marginRight: 8 }} /> Lab Agent</div>
          <div className={`va-status ${status}`}>
            {status === "prepping" ? "Preparing • sending context…"
              : status === "connected" ? (micActive ? "Connected • VAD listening" : "Connected • mic muted")
              : status === "error" ? "Error • check connection"
              : "Idle"}
          </div>
        </div>

        <div className="va-section">
          <div className="va-subtitle">Conversation</div>
          <div className="va-stream">
            {streamingText ? streamingText : <em>Agent is speaking & listening over the voice channel…</em>}
          </div>
        </div>

        {askingText && (
          <div className="va-section" style={{ marginTop: 8 }}>
            <div className="va-subtitle">Approval</div>
            <div className="va-ask">{askingText}</div>
            <div className="va-hint">Reply verbally to the agent. No buttons needed.</div>
          </div>
        )}

        {approvedLocal.length > 0 && (
          <div className="va-section">
            <div className="va-subtitle">
              Approved in this session <span className="pill">{approvedLocal.length}</span>
            </div>
            <div className="approved-list">
              {approvedLocal.map((a) => (
                <span key={a.id} className="chip-approved">
                  {a.name}{a.priority ? ` • ${a.priority}` : ""}{a.why ? ` — ${a.why}` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Mic toggle (just enables/disables upstream mic) */}
      <button
        className={`mic-btn ${micActive ? "mic-active" : ""}`}
        onClick={() => {
          if (!localStreamRef.current) return;
          const enabled = !micActive;
          localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = enabled));
          setMicActive(enabled);
        }}
        title={micActive ? "Mute mic" : "Unmute mic"}
        aria-label="Toggle microphone"
      >
        <FaMicrophoneAlt />
      </button>

      {/* === DRAGGABLE PENDING SUGGESTIONS (unique keys!) === */}
      <AnimatePresence>
        {reorderList.length > 0 && (
          <motion.div
            key="pending-dock"
            className="pending-dock"
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ duration: 0.22 }}
            drag
            dragMomentum={false}
            dragElastic={0.18}
          >
            <div className="dock-title">Pending Lab Suggestions</div>

            <Reorder.Group
              axis="y"
              className="pending-list"
              values={reorderList}
              onReorder={(list) => { setReorderList(list); setPendingQueue(list); }}
            >
              {reorderList.map((s) => (
                <Reorder.Item
                  key={s.id}          
                  value={s}
                  className="pending-item"
                  whileDrag={{ scale: 1.02 }}
                >
                  <div className="sug-title">{s.name}</div>
                  {(s.priority || s.why) && (
                    <div className="sug-meta">
                      {s.priority ? <span className="badge">{s.priority}</span> : null}
                      {s.priority && s.why ? " • " : null}
                      {s.why ? <span className="why">Reason: {s.why}</span> : null}
                    </div>
                  )}
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                    Drag to reorder. Say “yes / approve / add” to confirm via the agent.
                  </div>
                </Reorder.Item>
              ))}
            </Reorder.Group>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

