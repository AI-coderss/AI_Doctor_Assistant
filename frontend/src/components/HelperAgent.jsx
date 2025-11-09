/* eslint-disable no-useless-concat */
/* eslint-disable no-restricted-globals */
/* src/components/HelperAgent.jsx */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* HelperAgent.jsx — right dock, validator-style FAB toggles, Orb center, AudioWave bottom, function-calling via window events */
/* eslint-disable react-hooks/exhaustive-deps */
/* HelperAgent.jsx — right dock, uses Orb at the top (same position as BaseOrb in LabVoiceAgent),
   AudioWave at the bottom, and function-calling via window CustomEvents for Clinical Notes. */

// src/components/HelperAgent.jsx
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import "../styles/helper-agent.css";
import AudioWave from "./AudioWave.jsx";
import Orb from "./Orb.jsx";
import { FaTimes, FaPaperPlane, FaBroom, FaMicrophoneAlt } from "react-icons/fa";

/** Same schemas as backend */
const CN_TOOLS = [
  {
    type: "function", name: "cn_add_section",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string" },
        key: { type: "string" },
        text: { type: "string", default: "" },
        position: { type: "string", enum: ["before","after","end"], default: "after" },
        anchor_key: { type: "string" }
      },
      required: ["title"]
    }
  },
  { type: "function", name: "cn_remove_section", parameters: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string" } }, required: ["key"]
  }},
  { type: "function", name: "cn_update_section", parameters: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string" }, text: { type: "string" }, append: { type: "boolean", default: false } },
      required: ["key","text"]
  }},
  { type: "function", name: "cn_rename_section", parameters: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string" }, new_title: { type: "string" }, new_key: { type: "string" } },
      required: ["key","new_title"]
  }},
  { type: "function", name: "cn_apply_markdown", parameters: {
      type: "object", additionalProperties: false, properties: { markdown: { type: "string" } }, required: ["markdown"]
  }},
  { type: "function", name: "cn_save", parameters: { type: "object", additionalProperties: false, properties: {} } },
  { type: "function", name: "cn_preview", parameters: { type: "object", additionalProperties: false, properties: {} } },
];

export default function HelperAgent({
  isVisible,
  onClose = () => {},
  sessionId,
  backendBase ,
  context = ""     // transcript or prepared context
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [vizSource, setVizSource] = useState("mic"); // "mic" | "agent"

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const remoteAudioEl = useRef(null);

  const toolBuffersRef = useRef(new Map());

  useEffect(() => {
    if (!isVisible) { stopAll(); return; }
    (async () => {
      try {
        setStatus("prepping");
        await sendContext();
        await startVoice();
        setStatus("connected");
      } catch (e) {
        console.error("Helper init failed", e);
        setStatus("error");
      }
    })();
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  const sendContext = async () => {
    try {
      await fetch(`${backendBase}/api/helper-agent/context`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context })
      });
    } catch {}
  };

  const sendSessionUpdate = async () => {
    let tools = CN_TOOLS, tool_choice = { type: "auto" };
    try {
      const r = await fetch(`${backendBase}/api/helper-agent/tools`);
      if (r.ok) { const j = await r.json(); tools = j.tools || tools; tool_choice = j.tool_choice || tool_choice; }
    } catch {}
    const msg = {
      type: "session.update",
      session: {
        modalities: ["text","audio"],
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        tools, tool_choice,
        instructions: "Use tools to modify the on-screen clinical notes."
      }
    };
    try { dcRef.current?.send(JSON.stringify(msg)); } catch {}
  };

  const startVoice = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    wireDataChannel(dc);
    dc.onopen = sendSessionUpdate;

    stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = (ev) => {
      const [rs] = ev.streams || [];
      if (!rs) return;
      remoteStreamRef.current = rs;
      if (remoteAudioEl.current) {
        remoteAudioEl.current.srcObject = rs;
        remoteAudioEl.current.play?.().catch(()=>{});
        remoteAudioEl.current.addEventListener("play", () => setVizSource("agent"));
        remoteAudioEl.current.addEventListener("pause", () => setVizSource("mic"));
        remoteAudioEl.current.addEventListener("ended", () => setVizSource("mic"));
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed","closed","disconnected"].includes(pc.connectionState)) {
        setStatus("error"); setMicActive(false); setVizSource("mic");
      }
    };

    let offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const res = await fetch(
      `${backendBase}/api/helper-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
      { method: "POST", headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId }, body: offer.sdp }
    );
    if (!res.ok) throw new Error("rtc-connect failed");
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    setMicActive(true);
  };

  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      // collect tool chunks (mirrors your example)
      if (msg?.type === "response.output_item.added" && msg.item?.type === "function_call") {
        const id = msg.item.call_id || msg.item.id || "default";
        const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
        prev.name = msg.item.name || prev.name || "";
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (msg?.type === "response.function_call_arguments.delta" || msg?.type === "tool_call.delta") {
        const id = msg.call_id || msg.id || "default";
        const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
        prev.argsText += (msg.delta || msg.arguments_delta || "");
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (
        msg?.type === "response.function_call_arguments.done" ||
        msg?.type === "tool_call_arguments.done" ||
        msg?.type === "response.function_call.completed" ||
        msg?.type === "tool_call.completed"
      ) {
        const id = msg.call_id || msg.id || "default";
        const buf = toolBuffersRef.current.get(id);
        toolBuffersRef.current.delete(id);
        if (!buf) return;
        let args = {};
        try { args = JSON.parse(buf.argsText || "{}"); } catch {}
        applyTool(buf.name || "", args);
      }
    };
    ch.onerror = (e) => console.error("datachannel error", e);
  }

  function dispatchCN(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }
  function applyTool(name, args) {
    switch ((name||"").trim()) {
      case "cn_add_section":     dispatchCN("cn:section.add", args||{}); break;
      case "cn_remove_section":  dispatchCN("cn:section.remove", args||{}); break;
      case "cn_update_section":  dispatchCN("cn:section.update", args||{}); break;
      case "cn_rename_section":  dispatchCN("cn:section.rename", args||{}); break;
      case "cn_apply_markdown":  dispatchCN("cn:apply", { markdown: args?.markdown || "" }); break;
      case "cn_save":            dispatchCN("cn:save", {}); break;
      case "cn_preview":         dispatchCN("cn:preview", { show: true }); break;
      default: break;
    }
  }

  const stopAll = () => {
    try { pcRef.current?.getSenders?.().forEach(s=>s.track?.stop()); pcRef.current?.close(); } catch {}
    pcRef.current = null;
    try { localStreamRef.current?.getTracks?.().forEach(t=>t.stop()); } catch {}
    localStreamRef.current = null;
    if (remoteAudioEl.current) {
      try { remoteAudioEl.current.pause?.(); remoteAudioEl.current.srcObject = null; } catch {}
    }
    remoteStreamRef.current = null;
    setMicActive(false); setVizSource("mic"); setStatus("idle");
  };

  if (!isVisible) return null;

  const waveStream = (vizSource === "agent" && remoteStreamRef.current)
    ? remoteStreamRef.current : (localStreamRef.current || null);

  return (
    <div className="helper-assistant" role="dialog" aria-label="Helper Agent">
      <audio ref={remoteAudioEl} autoPlay playsInline style={{ display: "none" }} />
      <div className="ha-controls">
        <button className="ha-btn is-primary" onClick={sendContext} title="Resend context">
          <FaPaperPlane />&nbsp;Sync Context
        </button>
        <button className="ha-btn is-danger" onClick={() => { stopAll(); onClose?.(); }}>
          <FaBroom />&nbsp;End
        </button>
        <button className="ha-close" onClick={() => { stopAll(); onClose?.(); }} title="Close">
          <FaTimes />
        </button>
      </div>

      {/* orb ABOVE content, transparent */}
      <div className="ha-orb">
        <div className="ha-orb-ring" aria-hidden="true" />
        <Orb className="ha-orb-canvas" />
      </div>

      <div className="ha-header">
        <div className="ha-title">Helper Agent</div>
        <div className={`ha-status ${status}`}>{status === "connected" ? (micActive ? "Connected • listening" : "Connected • mic muted") : status}</div>
      </div>

      <div className="ha-audiowave">
        <AudioWave stream={waveStream} />
      </div>

      <button
        className={`ha-mic ${micActive ? "on" : ""}`}
        onClick={() => {
          if (!localStreamRef.current) return;
          const next = !micActive;
          localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = next));
          setMicActive(next);
        }}
        title={micActive ? "Mute" : "Unmute"}
      >
        <FaMicrophoneAlt />
      </button>
    </div>
  );
}


