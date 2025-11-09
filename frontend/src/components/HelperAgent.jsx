/* eslint-disable no-useless-concat */
/* eslint-disable no-restricted-globals */
/* src/components/HelperAgent.jsx */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* HelperAgent.jsx — right dock, validator-style FAB toggles, Orb center, AudioWave bottom, function-calling via window events */
/* eslint-disable react-hooks/exhaustive-deps */
/* HelperAgent.jsx — right dock, uses Orb at the top (same position as BaseOrb in LabVoiceAgent),
   AudioWave at the bottom, and function-calling via window CustomEvents for Clinical Notes. */

import React, { useEffect, useRef, useState } from "react";
import "../styles/helper-agent.css";
import Orb from "./Orb.jsx";
import AudioWave from "./AudioWave.jsx";

// Audio visualizer stores (same ones you use for LabVoiceAgent)
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";
import { FaTimes, FaPaperPlane, FaBroom, FaMicrophoneAlt } from "react-icons/fa";

/** Fallback tools (identical schema to backend) — used only if fetch to /helper-agent/tools fails */
const CN_TOOLS_FALLBACK = [
  {
    name: "cn_add_section",
    description: "Add a new section to clinical notes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Section title" },
        key: { type: "string", description: "Slug key (lowercase_with_underscores). Optional" },
        text: { type: "string", description: "Default text content", default: "" },
        position: { type: "string", enum: ["before", "after", "end"], default: "after" },
        anchor_key: { type: "string", description: "Place relative to this key (required for before/after)" }
      },
      required: ["title"]
    }
  },
  {
    name: "cn_remove_section",
    description: "Remove a section by key.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { key: { type: "string" } },
      required: ["key"]
    }
  },
  {
    name: "cn_update_section",
    description: "Set or append text for a section.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string" },
        text: { type: "string" },
        append: { type: "boolean", default: false }
      },
      required: ["key", "text"]
    }
  },
  {
    name: "cn_rename_section",
    description: "Rename a section (and optionally change its key).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string" },
        new_title: { type: "string" },
        new_key: { type: "string" }
      },
      required: ["key", "new_title"]
    }
  },
  {
    name: "cn_apply_markdown",
    description: "Replace entire note with a full Markdown string (SOAP or organized).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { markdown: { type: "string" } },
      required: ["markdown"]
    }
  },
  {
    name: "cn_save",
    description: "Ask UI to approve & save current clinical notes.",
    parameters: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "cn_preview",
    description: "Open preview tab for the clinical notes.",
    parameters: { type: "object", additionalProperties: false, properties: {} }
  }
];

export default function HelperAgent({
  isVisible,
  onClose = () => {},
  sessionId,
  backendBase,        // e.g. https://ai-doctor-assistant-backend-server.onrender.com
  context             // string: transcript or buildAgentContext()
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const remoteAudioEl = useRef(null);

  // Visualizer plumbing
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();
  const [vizSource, setVizSource] = useState("mic"); // "mic" | "agent"

  // Function-call deltas buffer
  const toolBuffersRef = useRef(new Map());

  useEffect(() => {
    if (!isVisible) {
      stopAll();
      return;
    }

    (async () => {
      try {
        setStatus("prepping");
        await sendContext();
        await startVoice();
        setStatus("connected");
      } catch (e) {
        console.error("HelperAgent init failed:", e);
        setStatus("error");
      }
    })();

    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  const sendContext = async () => {
    try {
      await fetch(`${backendBase}/helper-agent/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context: context || "" })
      });
    } catch (e) {
      console.warn("sendContext error:", e);
    }
  };

  const sendSessionUpdate = async () => {
    // Pull tool schema from the backend to keep schema in one source of truth
    let tools = CN_TOOLS_FALLBACK;
    let tool_choice = { type: "auto" };
    try {
      const r = await fetch(`${backendBase}/helper-agent/tools`);
      if (r.ok) {
        const j = await r.json();
        tools = j.tools || tools;
        tool_choice = j.tool_choice || tool_choice;
      }
    } catch {}

    const instruction = [
      "You are a UI Helper Agent for editing Clinical Notes.",
      "Prefer using the provided tools (function calls) to modify the notes.",
      "Do not claim changes happened unless the tool succeeded.",
      "When done or on request, call cn_save or cn_preview."
    ].join(" ");

    const msg = {
      type: "session.update",
      session: {
        voice: "alloy",
        turn_detection: { type: "server_vad", threshold: 0.5 },
        tools,
        tool_choice,
        instructions: instruction
      }
    };

    try { dcRef.current?.send(JSON.stringify(msg)); } catch {}
  };

  const startVoice = async () => {
    // Mic
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    try { startVolumeMonitoring(stream, setAudioScale); } catch {}

    // PC
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;

    // Outbound channel for session.update
    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    wireDataChannel(dc);
    dc.onopen = sendSessionUpdate;

    // mic -> PC
    stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));

    // remote audio
    pc.ontrack = (ev) => {
      const [rs] = ev.streams || [];
      if (!rs) return;
      remoteStreamRef.current = rs;

      if (remoteAudioEl.current) {
        remoteAudioEl.current.srcObject = rs;
        const ae = remoteAudioEl.current;
        const onPlay = () => setVizSource("agent");
        const onPause = () => setVizSource("mic");
        const onEnded = () => setVizSource("mic");
        ae.addEventListener("play", onPlay);
        ae.addEventListener("pause", onPause);
        ae.addEventListener("ended", onEnded);
        ae.play?.().catch(() => {});
      }
      try { startVolumeMonitoring(rs, setAudioScale); } catch {}
      try { setAudioUrl(rs); } catch {}
    };

    pc.ondatachannel = (e) => e.channel && wireDataChannel(e.channel);

    pc.onconnectionstatechange = () => {
      if (["failed","closed","disconnected"].includes(pc.connectionState)) {
        setStatus("error"); setMicActive(false); setVizSource("mic");
      }
    };

    // SDP
    let offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const res = await fetch(
      `${backendBase}/helper-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
      { method: "POST", headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId }, body: offer.sdp }
    );
    if (!res.ok) throw new Error(`/helper-agent/rtc-connect ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    setMicActive(true);
  };

  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch { return; }

      // Start/collect function call args
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
        prev.argsText += msg.delta || msg.arguments_delta || "";
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
        return;
      }
    };

    ch.onerror = (e) => console.error("HelperAgent datachannel error:", e);
  }

  function dispatchCN(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function applyTool(name, args) {
    switch ((name || "").trim()) {
      case "cn_add_section":
        dispatchCN("cn:section.add", args || {});
        break;
      case "cn_remove_section":
        dispatchCN("cn:section.remove", args || {});
        break;
      case "cn_update_section":
        dispatchCN("cn:section.update", args || {});
        break;
      case "cn_rename_section":
        dispatchCN("cn:section.rename", args || {});
        break;
      case "cn_apply_markdown":
        dispatchCN("cn:apply", { markdown: args?.markdown || "" });
        break;
      case "cn_save":
        dispatchCN("cn:save", {});
        break;
      case "cn_preview":
        dispatchCN("cn:preview", { show: true });
        break;
      default:
        // ignore
        break;
    }
  }

  const stopAll = () => {
    try {
      if (pcRef.current) {
        pcRef.current.getSenders?.().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    try { localStreamRef.current?.getTracks?.().forEach(t => t.stop()); } catch {}
    localStreamRef.current = null;

    if (remoteAudioEl.current) {
      try {
        remoteAudioEl.current.pause?.();
        remoteAudioEl.current.srcObject = null;
        remoteAudioEl.current.src = "";
      } catch {}
    }
    remoteStreamRef.current = null;

    setMicActive(false);
    setVizSource("mic");
    setStatus("idle");
  };

  if (!isVisible) return null;

  const waveStream =
    vizSource === "agent" && remoteStreamRef.current
      ? remoteStreamRef.current
      : localStreamRef.current || null;

  return (
    <div className="helper-assistant" role="dialog" aria-label="Helper Agent">
      <audio ref={remoteAudioEl} autoPlay playsInline style={{ display: "none" }} />

      {/* top-right controls */}
      <div className="ha-controls">
        <button className="ha-btn is-primary" onClick={sendContext} title="Resend context">
          <FaPaperPlane />&nbsp;Sync Context
        </button>
        <button
          className="ha-btn is-danger"
          onClick={() => { stopAll(); onClose?.(); }}
          title="End session & close"
        >
          <FaBroom />&nbsp;End
        </button>
        <button className="ha-close" onClick={() => { stopAll(); onClose?.(); }} title="Close">
          <FaTimes />
        </button>
      </div>

      {/* orb at the top, inside the circular frame */}
      <div className="ha-orb">
        <div className="ha-orb-ring" aria-hidden="true" />
        <Orb className="ha-orb-canvas" />
      </div>

      {/* header + status */}
      <div className="ha-header">
        <div className="ha-title">Helper Agent</div>
        <div className={`ha-status ${status}`}>
          {status === "prepping"
            ? "Preparing…"
            : status === "connected"
            ? (micActive ? "Connected • listening" : "Connected • mic muted")
            : status === "error"
            ? "Error"
            : "Idle"}
        </div>
      </div>

      {/* audio wave below orb */}
      <div className="ha-audiowave">
        <AudioWave stream={waveStream} />
      </div>

      {/* mic toggle button (bottom center inside the panel) */}
      <button
        className={`ha-mic ${micActive ? "on" : ""}`}
        onClick={() => {
          if (!localStreamRef.current) return;
          const enabled = !micActive;
          localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = enabled));
          setMicActive(enabled);
        }}
        title={micActive ? "Mute mic" : "Unmute mic"}
        aria-label="Toggle microphone"
      >
        <FaMicrophoneAlt />
      </button>
    </div>
  );
}

