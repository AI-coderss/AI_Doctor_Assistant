/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes, FaBroom, FaPaperPlane } from "react-icons/fa";

import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
  onEndSession = () => {},
  allowedLabs = []
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [pendingQueue, setPendingQueue] = useState([]); // [{id, name, why, priority}]
  const [askingText, setAskingText] = useState("");

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);             // outbound control DataChannel ("oai-events")
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Tool-call deltas buffer
  const toolBuffersRef = useRef(new Map()); // id -> { name, argsText }

  // Visualizer stores
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

  // Local id counter
  const seqRef = useRef(0);

  const resetAll = () => {
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
        await startVoice();       // mic <-> model audio
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

  /* ------- Tools the model can call over the data channel ------- */
  const APPROVE_LAB_TOOL = {
    name: "approve_lab",
    description:
      "Approve a lab test that the user has verbally confirmed. Only call this tool after explicit user approval (e.g., 'yes', 'approve', 'add').",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Canonical lab test name." },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        why: { type: "string" }
      },
      required: ["name"]
    }
  };

  const QUEUE_LAB_TOOL = {
    name: "queue_lab_suggestion",
    description:
      "Queue ONE suggested lab test into the pending list for user review. Do NOT approve automatically. Use whenever you propose a test.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Canonical lab test name." },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        why: { type: "string", description: "Short rationale (6–18 words)." }
      },
      required: ["name"]
    }
  };

  // Send tools to the Realtime session (no instructions here; backend already sets context+policy)
  const sendSessionUpdate = () => {
    const msg = {
      type: "session.update",
      session: {
        voice: "alloy",
        turn_detection: { type: "server_vad", threshold: 0.5 },
        tools: [APPROVE_LAB_TOOL, QUEUE_LAB_TOOL],
        tool_choice: { type: "auto" },
      }
    };
    try {
      dcRef.current?.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("session.update send failed:", e);
    }
  };

  // When the agent is explicitly asking for approval, make approve tool required
  useEffect(() => {
    if (!dcRef.current || dcRef.current.readyState !== "open") return;
    const msg = {
      type: "session.update",
      session: {
        tool_choice: askingText ? { type: "required", name: "approve_lab" } : { type: "auto" }
      }
    };
    try { dcRef.current.send(JSON.stringify(msg)); } catch {}
  }, [askingText]);

  const startVoice = async () => {
    try {
      // 1) Mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      try { startVolumeMonitoring(stream, setAudioScale); } catch {}

      // 2) WebRTC peer
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;

      // 2a) outbound data channel for control/events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = sendSessionUpdate;

      // 3) mic -> PC
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 4) agent voice -> audio element
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (remoteStream && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play?.().catch((err) => console.warn("Agent audio play failed:", err));
          try { setAudioUrl(remoteStream); } catch {}
          try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
        }
      };

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

      // 5) Offer/answer
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

      // ------- Old shapes (delta/completed) -------
      if (msg?.type === "response.function_call.arguments.delta" || msg?.type === "tool_call.delta") {
        const id = msg.call_id || msg.id || "default";
        const name = msg.name || msg.function_name || "";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name, argsText: "" };
        prev.name = name || prev.name;
        prev.argsText += (delta || "");
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (msg?.type === "response.function_call.completed" || msg?.type === "tool_call.completed") {
        const id = msg.call_id || msg.id || "default";
        flushToolBuffer(id);
        return;
      }

      // ------- Newer shapes (delta/done) -------
      if (msg?.type === "response.output_tool_call.delta") {
        const id = msg?.output_tool_call?.id || "default";
        const name = msg?.output_tool_call?.name || "";
        const delta = msg?.output_tool_call?.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name, argsText: "" };
        prev.name = name || prev.name;
        prev.argsText += (delta || "");
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (msg?.type === "response.output_tool_call.done") {
        const id = msg?.output_tool_call?.id || "default";
        flushToolBuffer(id, /*isNewShape*/ true);
        return;
      }

      // Optional ask hint
      if (msg?.type === "ask") {
        setAskingText(String(msg.prompt || ""));
        return;
      }
    };

    ch.onerror = (e) => console.error("DataChannel error:", e);
  }

  function flushToolBuffer(id, isNewShape = false) {
    const buf = toolBuffersRef.current.get(id);
    toolBuffersRef.current.delete(id);
    if (!buf?.name) return;

    let args = {};
    try { args = JSON.parse(buf.argsText || "{}"); } catch {}

    const toolName = String(buf.name || "").toLowerCase();

    if (toolName === "approve_lab") {
      approveFromTool(args);
      ackTool(id, { ok: true, applied: true }, isNewShape);
      return;
    }

    if (toolName === "queue_lab_suggestion") {
      queueSuggestion(args);
      ackTool(id, { ok: true, queued: true }, isNewShape);
      return;
    }

    // silently ack unknown to let the model continue
    ackTool(id, { ok: true }, isNewShape);
  }

  function ackTool(callId, payload, isNewShape) {
    const safe = JSON.stringify(payload || { ok: true });
    try {
      // Old shape
      dcRef.current?.send(JSON.stringify({
        type: "response.function_call.output",
        call_id: callId,
        output: safe
      }));
      // New shape
      dcRef.current?.send(JSON.stringify({
        type: "tool.output",
        tool_call_id: callId,
        output: safe
      }));
    } catch {}
  }

  async function approveFromTool(item) {
    // 1) Optimistic UI add
    const approved = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: String(item?.name || "").trim(),
      priority: String(item?.priority || "").trim(),
      why: String(item?.why || "").trim(),
    };
    if (approved.name) {
      applyApproved(approved);
      if (askingText && approved.name && askingText.toLowerCase().includes(approved.name.toLowerCase())) {
        setAskingText("");
      }
    }

    // 2) Persist in background (non-blocking)
    try {
      fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, item: approved }),
      }).catch(() => {});
    } catch {}
  }

  function queueSuggestion(raw) {
    const itm = normalizeItem(raw, true);
    if (!itm) return;
    setPendingQueue((prev) => {
      const exists = prev.some(
        (x) => String(x.name).toLowerCase() === String(itm.name).toLowerCase()
      );
      return exists ? prev : [...prev, itm];
    });
  }

  const stopAll = () => {
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

  const removePendingByName = (nm) => {
    const low = String(nm || "").toLowerCase();
    setPendingQueue((prev) => prev.filter((x) => (x.name || "").toLowerCase() !== low));
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
    if (askingText && nm && askingText.toLowerCase().includes(nm.toLowerCase())) {
      setAskingText("");
    }
  };

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

  const leftColumn = createPortal(
    <div key="pending-left-column" className="pending-dock pending-dock--left" aria-live="polite">
      <div className="dock-title">Pending Lab Suggestions</div>
      <div className="pending-list">
        {pendingQueue.length === 0 ? (
          <div className="pending-empty">The agent will queue suggestions here.</div>
        ) : (
          pendingQueue.map((s) => (
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
              <div className="tiny-hint">Say “yes / approve / add” to confirm via the agent.</div>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

        <div className="assistant-orb"><BaseOrb className="base-orb" /></div>

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

        <div className="assistant-content" style={{ overflow: "hidden" }}>
          <div className="va-header" style={{ marginBottom: 12 }}>
            <div className="va-title"><FaFlask style={{ marginRight: 8 }} /> Lab Agent</div>
            <div className={`va-status ${status}`}>
              {status === "prepping" ? "Preparing • sending context…"
                : status === "connected" ? (micActive ? "Connected • VAD listening" : "Connected • mic muted")
                : status === "error" ? "Error • check connection"
                : "Idle"}
            </div>
          </div>

          {/* Visualizer only, no scrolling text */}
          <div style={{ border: "1px solid var(--card-border)", borderRadius: 12, padding: 8 }}>
            <AudioWave stream={localStreamRef.current || null} />
          </div>

          {askingText && (
            <div className="va-hint" style={{ marginTop: 8 }}>
              {askingText}
            </div>
          )}
        </div>

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

      {leftColumn}
    </>
  );
}



