/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes, FaBroom, FaPaperPlane } from "react-icons/fa";

/* 🔊 Visualizer + audio store */
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/* 🔊 Audio waveform component (kept exactly as you asked, only imported and used) */
import AudioWave from "./AudioWave.jsx";

/**
 * LabVoiceAgent
 * - Connects to backend voice agent (WebRTC + SSE).
 * - Conversation area replaced by AudioWave (no label; no internal scroll).
 * - Pending Lab Suggestions render in a fixed LEFT column (via portal to <body>), not draggable.
 */
export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
  onEndSession = () => {},
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [pendingQueue, setPendingQueue] = useState([]); // [{id, name, why, priority}]
  const [askingText, setAskingText] = useState("");

  /* expose streams to the visualizer */
  const [localStreamState, setLocalStreamState] = useState(null);
  const [remoteStreamState, setRemoteStreamState] = useState(null);

  // WebRTC
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // SSE
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

  // Text buffer
  const textBufRef = useRef("");

  // Function-call buffers
  const toolBuffersRef = useRef(new Map()); // id -> { name, argsText }

  // Orb / output level stores
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

  // Local id counter
  const seqRef = useRef(0);

  const appendText = (s) => {
    textBufRef.current += s;
    setStreamingText(textBufRef.current);
  };

  const resetAll = () => {
    textBufRef.current = "";
    setStreamingText("");
    setPendingQueue([]);
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
        await startVoice();       // mic -> model; model -> audio
        startSuggestStream();     // SSE text/suggestions
      } catch (e) {
        console.error("Agent init failed:", e);
        setStatus("error");
      }
    })();

    return () => { stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

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

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setLocalStreamState(stream); // expose mic

      // Orb reacts to MIC input
      try { startVolumeMonitoring(stream, setAudioScale); } catch {}

      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;

      // mic -> PC
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // agent voice -> audio element + visualizer
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (!remoteStream) return;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play?.().catch((err) => console.warn("Agent audio play failed:", err));
        }
        setRemoteStreamState(remoteStream);       // expose agent output
        try { setAudioUrl(remoteStream); } catch {}
        try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
      };

      // DataChannel for events/tool-calls
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        if (!ch) return;
        wireDataChannel(ch);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
          setMicActive(true);
        } else if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          setStatus("error");
          setMicActive(false);
        }
      };

      // Offer/answer — set & POST *the same* SDP
      let offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      offer.sdp = offer.sdp.replace(
        /a=rtpmap:\d+ opus\/48000\/2/g,
        "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
      );
      await pc.setLocalDescription(offer);

      const res = await fetch(
        `${backendBase}/lab-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
        { method: "POST", headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId }, body: offer.sdp }
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

      // 1) Function-call deltas
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

      // 2) Function-call completed
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
    setPendingQueue([]);
  };

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

  const makeId = (name) => {
    const seq = ++seqRef.current;
    const slug = String(name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-().+/]/g, "");
    return `${slug}::${Date.now()}::${seq}`;
  };

  const normalizeItem = (raw, forceId = false) => {
    if (!raw) return null;
    const name = ((raw.name || raw.test || "") + "").trim();
    if (!name) return null;
    return {
      id: raw.id && !forceId ? String(raw.id) : makeId(name),
      name,
      why: raw.why ? String(raw.why).trim() : "",
      priority: raw.priority ? String(raw.priority).trim() : "",
    };
  };

  const hasByName = (arr, nm) =>
    (arr || []).some(
      (x) => String(x.name || "").trim().toLowerCase() === String(nm || "").trim().toLowerCase()
    );

  const removePendingByName = (nm) => {
    const low = String(nm || "").toLowerCase();
    setPendingQueue((prev) => prev.filter((x) => (x.name || "").toLowerCase() !== low));
  };

  const softApproveFromText = (txt) => {
    const t = (txt || "").toLowerCase();
    const m = t.match(/\b(approved|approve|add|yes)\b[:\s-]*([a-z0-9 .+\-/()]+)$/i);
    if (!m) return;
    const name = (m[2] || "").trim();
    if (!name) return;
    if (hasByName([], name)) return;
    const item = normalizeItem({ name }, true);
    applyApproved(item);
  };

  const notifyManualAdd = (item) => {
    try {
      fetch(`${backendBase}/lab-agent/tool-bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, tool: "add_lab_manual", args: item }),
      }).catch(() => {});
    } catch {}
  };

  const applyApproved = (item) => {
    const nm = String(item?.name || "").trim();
    if (!nm) return;
    removePendingByName(nm);
    try { onApproveLab?.(item); } catch {}
    if (askingText && askingText.toLowerCase().includes(nm.toLowerCase())) setAskingText("");
  };

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
      if (hasByName(pendingQueue, itm.name)) return;
      setPendingQueue((prev) => [...prev, itm]);
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

    if (typeof msg === "string") {
      appendText(msg + "\n");
      softApproveFromText(msg);
    }
  };

  // 🔚 End Session
  const endSessionNow = async () => {
    try {
      await fetch(`${backendBase}/lab-agent/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
    } finally {
      stopAll();
      resetAll();
      onEndSession?.();
    }
  };

  if (!isVisible) return null;

  /* ---------- LEFT COLUMN PORTAL ---------- */
  const leftColumn = pendingQueue.length > 0 ? createPortal(
    <div
      key="pending-left-column"
      className="pending-dock pending-dock--left"
      aria-live="polite"
    >
      <div className="dock-title">Pending Lab Suggestions</div>

      <div className="pending-list">
        {pendingQueue.map((s) => (
          <div key={s.id} className="pending-item">
            <div className="sug-title">{s.name}</div>
            {(s.priority || s.why) && (
              <div className="sug-meta">
                {s.priority ? <span className="badge">{s.priority}</span> : null}
                {s.priority && s.why ? " • " : null}
                {s.why ? <span className="why">Reason: {s.why}</span> : null}
              </div>
            )}
            <div className="btn-row">
              <button
                className="va-btn is-primary"
                onClick={() => { applyApproved(s); notifyManualAdd(s); }}
              >
                Add to Table
              </button>
              <button
                className="va-btn is-ghost"
                onClick={() => removePendingByName(s.name)}
              >
                Skip
              </button>
            </div>
            <div className="tiny-hint">
              Say “yes / approve / add” to confirm via the agent.
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  /* Prefer remote (agent output); fallback to mic */
  const visualizerStream = remoteStreamState || localStreamState;

  return (
    <>
      {/* Right-side voice assistant panel */}
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        {/* hidden audio element */}
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

        <div className="assistant-orb"><BaseOrb className="base-orb" /></div>

        {/* top-right controls */}
        <div className="va-controls">
          <button className="va-btn is-ghost" onClick={sendContext} title="Resend context">
            <FaPaperPlane />&nbsp;Sync Context
          </button>
          <button className="va-btn is-danger" onClick={endSessionNow} title="End session & reset">
            <FaBroom />&nbsp;End Session
          </button>
          <button className="close-btn" onClick={() => { onClose?.(); }} title="Close">
            <FaTimes />
          </button>
        </div>

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

          {/* ✅ Conversation area replaced by the visualizer (no title, no scroll) */}
          <div className="va-section va-visualizer">
            <AudioWave stream={visualizerStream} />
          </div>

          {askingText && (
            <div className="va-section" style={{ marginTop: 8 }}>
              <div className="va-subtitle">Approval</div>
              <div className="va-ask">{askingText}</div>
              <div className="va-hint">Reply verbally to the agent. No buttons needed.</div>
            </div>
          )}
        </div>

        {/* Mic toggle */}
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
      </div>

      {/* Render the LEFT column at top-left OUTSIDE the voice panel */}
      {leftColumn}
    </>
  );
}

