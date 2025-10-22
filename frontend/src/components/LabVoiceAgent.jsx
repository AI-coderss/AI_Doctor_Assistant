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

/**
 * LabVoiceAgent
 * - WebRTC to OpenAI Realtime (server creates session with tools)
 * - Buffers function-call args via official events
 *   • response.function_call_arguments.delta
 *   • response.function_call_arguments.done
 * - On approve_lab(done): removes item from pending and appends to chat table via onApproveLab()
 *
 * Props:
 *  - isVisible: boolean
 *  - onClose: () => void
 *  - sessionId: string
 *  - backendBase: string
 *  - context: string
 *  - onApproveLab: (item: {id?, name, why?, priority?}) => void
 *  - onEndSession: () => void
 *  - allowedLabs?: string[]  (optional guidance)
 */
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

  // WebRTC refs
  const pcRef = useRef(null);
  const dcRef = useRef(null);             // data channel to send client events
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null);

  // Visualizer
  const [vizSource, setVizSource] = useState("mic");
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

  // SSE
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

  // function-call buffers
  const toolBuffersRef = useRef(new Map()); // call_id -> { name, argsText }

  // id helpers
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
        setVizSource("mic");
        await sendContext();
        await startVoice();       // mic <-> model audio
        startSuggestStream();     // optional SSE suggestions
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

  // client-side guidance only (tools come from backend session)
  const sendSessionUpdate = () => {
    const instruction = [
      "You are a clinical lab assistant. Speak concisely.",
      "Propose ONE test then WAIT for explicit approval (e.g., 'yes', 'approve', 'add').",
      "Never edit the UI by text; only call approve_lab after approval.",
      allowedLabs?.length
        ? `Use ONLY names from this allowed list when approving: ${allowedLabs.join(", ")}.`
        : "Prefer canonical test names (e.g., 'CBC', 'CMP', 'TSH').",
    ].join(" ");

    const msg = {
      type: "session.update",
      session: {
        instructions: instruction,
        // server VAD for natural turn-taking
        turn_detection: { type: "server_vad" } // official setting; details in docs
      }
    };
    try { dcRef.current?.send(JSON.stringify(msg)); } catch {}
  };

  // tighten tool gating if model is explicitly asking for approval
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
      // 1) mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      try { startVolumeMonitoring(stream, setAudioScale); } catch {}

      // 2) RTCPeer
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;

      // 2a) outbound data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => sendSessionUpdate();
      dc.onclose = () => {};
      wireDataChannel(dc);

      // 3) mic -> pc
      stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));

      // 4) agent audio -> element & visualizer
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (!remoteStream) return;
        remoteStreamRef.current = remoteStream;

        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;

          const onPlay  = () => setVizSource("agent");
          const onPause = () => setVizSource("mic");
          const onEnded = () => setVizSource("mic");
          const el = remoteAudioRef.current;
          el.removeEventListener?.("play", onPlay);
          el.removeEventListener?.("pause", onPause);
          el.removeEventListener?.("ended", onEnded);
          el.addEventListener?.("play", onPlay);
          el.addEventListener?.("pause", onPause);
          el.addEventListener?.("ended", onEnded);
          el.play?.().catch((err) => console.warn("Agent audio play failed:", err));
        }

        // make the orb respond to OUTPUT as well
        try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
        try { setAudioUrl(remoteStream); } catch {}
      };

      pc.ondatachannel = (e) => e?.channel && wireDataChannel(e.channel);

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected"); setMicActive(true);
        } else if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          setStatus("error"); setMicActive(false); setVizSource("mic");
        }
      };

      // 5) SDP offer/answer
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
      setStatus("error"); setMicActive(false); setVizSource("mic");
      throw err;
    }
  };

  // === Event wiring for official function-calling events ===
  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch {}

      // 1) arguments delta (official)
      if (msg?.type === "response.function_call_arguments.delta") {
        const id = msg.call_id || msg.id || "default";
        const name = msg.name || "";
        const delta = msg.delta || "";
        const prev = toolBuffersRef.current.get(id) || { name, argsText: "" };
        prev.name = name || prev.name;
        prev.argsText += String(delta || "");
        toolBuffersRef.current.set(id, prev);
        return;
      }

      // 2) arguments done (official): parse & apply
      if (msg?.type === "response.function_call_arguments.done") {
        const id = msg.call_id || msg.id || "default";
        const buf = toolBuffersRef.current.get(id);
        toolBuffersRef.current.delete(id);
        if (!buf?.name) return;

        let args = {};
        try { args = JSON.parse(buf.argsText || "{}"); } catch {}
        if ((buf.name === "approve_lab" || /approve_lab/i.test(buf.name)) && args?.name) {
          approveFromTool(args);
        }
        return;
      }

      // 3) fallbacks for older shapes (best-effort)
      if (msg?.type === "tool_call.delta" || msg?.type === "response.function_call.arguments.delta") {
        const id = msg.call_id || msg.id || "default";
        const name = msg.name || msg.function_name || "";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name, argsText: "" };
        prev.name = name || prev.name;
        prev.argsText += (delta || "");
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (msg?.type === "tool_call.completed" || msg?.type === "response.function_call.completed") {
        const id = msg.call_id || msg.id || "default";
        const buf = toolBuffersRef.current.get(id);
        toolBuffersRef.current.delete(id);
        if (!buf?.name) return;
        let args = {};
        try { args = JSON.parse(buf.argsText || "{}"); } catch {}
        if ((buf.name === "approve_lab" || /approve_lab/i.test(buf.name)) && args?.name) {
          approveFromTool(args);
        }
        return;
      }

      // optional hint from the model
      if (msg?.type === "ask") {
        setAskingText(String(msg.prompt || ""));
        return;
      }
    };

    ch.onerror = (e) => console.error("DataChannel error:", e);
  }

  // normalize priority for the UI table pills
  const uiPriority = (p) => {
    const s = String(p || "").trim().toLowerCase();
    if (s === "stat" || s === "high") return "High";
    if (s === "medium") return "Medium";
    if (s === "routine" || s === "low") return "Low";
    return "Low";
  };

  async function approveFromTool(item) {
    try {
      const payload = {
        session_id: sessionId,
        item: {
          name: String(item.name || "").trim(),
          priority: uiPriority(item.priority),
          why: String(item.why || "").trim()
        }
      };
      const res = await fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`/lab-agent/approve ${res.status}`);
      const data = await res.json();

      const approved = {
        id: data?.item?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: data?.item?.name || item.name,
        priority: uiPriority(data?.item?.priority || item.priority),
        why: data?.item?.why || item.why || ""
      };
      applyApproved(approved);

      if (askingText && approved.name && askingText.toLowerCase().includes(approved.name.toLowerCase())) {
        setAskingText("");
      }
    } catch (e) {
      console.error("approveFromTool failed:", e);
    }
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
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.src = "";
      }
    } catch {}
    remoteStreamRef.current = null;

    setMicActive(false);
    setVizSource("mic");
    setStatus("idle");
    setPendingQueue([]);
  };

  // suggestions SSE (unchanged)
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
            if (msg?.type === "suggestion" && msg?.item?.name) {
              const itm = normalizeItem(msg.item, true);
              if (itm && !hasByName(pendingQueue, itm.name)) {
                setPendingQueue((prev) => [...prev, itm]);
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.error("suggest-stream error:", e);
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
      priority: uiPriority(raw.priority),
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

  // Left pending column
  const leftColumn = pendingQueue.length > 0 ? createPortal(
    <div key="pending-left-column" className="pending-dock pending-dock--left" aria-live="polite">
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
              <button className="va-btn is-primary" onClick={() => { applyApproved(s); notifyManualAdd(s); }}>
                Add to Table
              </button>
              <button className="va-btn is-ghost" onClick={() => removePendingByName(s.name)}>
                Skip
              </button>
            </div>
            <div className="tiny-hint">Say “yes / approve / add” to confirm via the agent.</div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  // visualizer source
  const waveStream =
    vizSource === "agent" && remoteStreamRef.current
      ? remoteStreamRef.current
      : localStreamRef.current || null;

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

          <div style={{ border: "1px solid var(--card-border)", borderRadius: 12, padding: 8 }}>
            <AudioWave stream={waveStream} />
          </div>

          {askingText && <div className="va-hint" style={{ marginTop: 8 }}>{askingText}</div>}
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



