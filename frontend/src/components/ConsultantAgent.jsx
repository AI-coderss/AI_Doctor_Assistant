/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { FaUserMd, FaTimes, FaBroom, FaPaperPlane, FaPhone } from "react-icons/fa";
import "../styles/lab-voice-agent.css";
import Orb from "./Orb.jsx";
import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/**
 * ConsultantAgent — with Orb + AudioWave UI but text Q/A in chat bubbles.
 *
 * Props:
 *   active: boolean
 *   sessionId: string
 *   backendBase: string (base URL of the service that hosts /consultant-agent/*)
 *   context: string
 *   onAgentMessage: ({ who:'bot'|'system', msg, type?, ddx? }) => void
 *   onDone: ({ assessment_md, plan_md, ddx }) => void
 *   onClose?: () => void
 */
const ConsultantAgent = forwardRef(function ConsultantAgent(
  { active, sessionId, backendBase, context, onAgentMessage, onDone, onClose = () => {} },
  ref
) {
  // ---------- constants ----------
  const BACKEND = String(backendBase || "https://ai-doctor-assistant-backend-server.onrender.com").replace(/\/+$/,"");
  const CONNECT_URL = `${BACKEND}/consultant-agent/rtc-connect?session_id=${encodeURIComponent(sessionId || "")}`;
  const CONTEXT_URL = `${BACKEND}/consultant-agent/context`;

  // ---------- WebRTC refs ----------
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null);

  // ---------- UI / state ----------
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [questionCount, setQuestionCount] = useState(6);
  const [vizSource, setVizSource] = useState("mic");
  const connectedRef = useRef(false);

  // ---------- streaming parsers ----------
  const toolBuffersRef = useRef(new Map()); // id -> {name, argsText}
  const outBufRef = useRef("");

  // ---------- visualizer stores ----------
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

  useImperativeHandle(ref, () => ({
    async start() {
      if (connectedRef.current) return;
      await primeContext();
      await connectRTC();
      // session.update will be sent on DataChannel onopen
    },
    async stop() { stopAll(); },
    setQuestionCount(n) {
      const nn = Math.max(1, Math.min(20, Number(n) || 6));
      setQuestionCount(nn);
      dcSend({ type: "session.update", session: { metadata: { consult_q_count: nn } } });
      onAgentMessage?.({ who: "system", msg: `Consultant will ask ~${nn} questions.` });
    },
    async handleUserText(text) {
      if (!dcRef.current || !connectedRef.current) return;
      const t = String(text || "").trim();
      if (!t) return;
      dcSend({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
      });
      dcSend({ type: "response.create" });
    },
  }));

  useEffect(() => {
    if (!active) {
      stopAll();
      return;
    }
    (async () => {
      try {
        setStatus("prepping");
        await primeContext();
        await connectRTC(); // session.update gets sent on DC open
      } catch (e) {
        console.error("Consultant start failed:", e);
        onAgentMessage?.({ who: "system", msg: `Consultant agent failed to start (${e?.message || "unknown"}).` });
        setStatus("error");
      }
    })();
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function primeContext() {
    if (!context) return;
    try {
      await fetch(CONTEXT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context }),
      });
    } catch (e) {
      console.warn("consultant context failed:", e);
    }
  }

  async function connectRTC() {
    // 1) mic
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    try { startVolumeMonitoring(stream, setAudioScale); } catch {}

    // 2) RTCPeerConnection + DataChannel
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    wireDC(dc);

    // Mirror LabVoiceAgent: send session.update only when the DC is truly open
    dc.onopen = () => {
      try {
        sendSessionUpdate();
        dcSend({ type: "response.create" });
      } catch {}
    };

    // Also handle server-created channel just in case
    pc.ondatachannel = (e) => e.channel && wireDC(e.channel);

    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams || [];
      if (!remoteStream) return;
      remoteStreamRef.current = remoteStream;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        const el = remoteAudioRef.current;
        const onPlay  = () => setVizSource("agent");
        const onPause = () => setVizSource("mic");
        const onEnded = () => setVizSource("mic");
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.play?.().catch(() => {});
      }
      try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
      try { setAudioUrl(remoteStream); } catch {}
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        connectedRef.current = true;
        setStatus("connected");
        setMicActive(true);
        onAgentMessage?.({ who: "system", msg: "Consultant connected. I’ll start with a few questions." });
      } else if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        connectedRef.current = false;
        setStatus("error");
        setMicActive(false);
        setVizSource("mic");
      }
    };

    // 3) Offer (same SDP tweak as lab)
    let offer = await pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = offer.sdp.replace(
      /a=rtpmap:\d+ opus\/48000\/2/g,
      "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
    );
    await pc.setLocalDescription(offer);

    // 4) POST SDP → get answer (NO custom headers; session_id only in query)
    const res = await fetch(CONNECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`/consultant-agent/rtc-connect ${res.status} ${text?.slice(0,120) || ""}`);
    }
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  async function sendSessionUpdate() {
    const instructions = [
      "You are a clinician-facing consultant-assistant that conducts a SHORT focused interview.",
      `Ask ONE concise question at a time (max ~${questionCount} total).`,
      "When the doctor answers, ask the next most relevant question. Stop early if enough data.",
      "When finished, emit a single structured summary via the tool 'emit_assessment':",
      "  - assessment_md: markdown with Assessment/Impression",
      "  - ddx: array of {name, probability} (0..1), top 3–8 items",
      "  - plan_md: markdown with Plan (bullet points)",
      "ALSO call 'emit_ddx' with the same ddx list for the bubble chart UI.",
      "Only call 'referral_create' if explicitly requested.",
      "NEVER call share_* or upload_* without explicit instruction.",
    ].join(" ");

    const TOOLS = [
      {
        name: "emit_assessment",
        description: "Emit final assessment & plan to UI.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            assessment_md: { type: "string" },
            plan_md: { type: "string" },
            ddx: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  probability: { type: "number" }
                },
                required: ["name", "probability"]
              }
            }
          },
          required: ["assessment_md", "ddx", "plan_md"]
        }
      },
      {
        name: "emit_ddx",
        description: "Emit a ddx list for the DDx bubble chart UI.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ddx: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  probability: { type: "number" }
                },
                required: ["name", "probability"]
              }
            }
          },
          required: ["ddx"]
        }
      },
      {
        name: "consult_set_question_count",
        description: "Adjust how many total questions to ask (1-20).",
        parameters: { type: "object", additionalProperties: false, properties: { count: { type: "number" } }, required: ["count"] }
      },
      {
        name: "referral_create",
        description: "Create a referral ticket after explicit confirmation.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            specialty: { type: "string" },
            reason: { type: "string" },
            urgency: { type: "string", enum: ["STAT","High","Routine"] },
            mode: { type: "string", enum: ["in-person","tele","asynchronous"] }
          },
          required: ["specialty"]
        }
      },
      { name: "share_open_widget",   description: "Open share widget (review before sending).", parameters: { type: "object", additionalProperties: false, properties: { recipient_hint: { type: "string" } } } },
      { name: "share_update_field",  description: "Update a share widget field.", parameters: { type: "object", additionalProperties: false, properties: { field: { type: "string", enum: ["to","subject","body"] }, value: { type: "string" }, append: { type: "boolean" } }, required: ["field","value"] } },
      { name: "share_send",          description: "Send email after explicit confirmation.", parameters: { type: "object", additionalProperties: false, properties: {} } },
      { name: "upload_lab_result",   description: "Open lab-results uploader UI.", parameters: { type: "object", additionalProperties: false, properties: {} } },
    ];

    dcSend({
      type: "session.update",
      session: {
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions,
        tools: TOOLS,
        metadata: { consult_q_count: questionCount }
      },
    });
  }

  function dcSend(obj) { try { dcRef.current?.send(JSON.stringify(obj)); } catch {} }

  function wireDC(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch {}

      if (msg?.type === "response.output_item.added" && msg?.item?.type === "function_call") {
        const id = msg.item.call_id || msg.item.id || "default";
        const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
        prev.name = msg.item.name || prev.name;
        toolBuffersRef.current.set(id, prev);
        return;
      }
      if (msg?.type === "response.function_call_arguments.delta" || msg?.type === "tool_call.delta") {
        const id = msg.call_id || msg.id || "default";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
        prev.argsText += delta || "";
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
        if (buf) {
          let args = {};
          try { args = JSON.parse(buf.argsText || "{}"); } catch {}
          routeTool(buf.name || "", args);
        }
        return;
      }

      if (msg?.type === "response.output_text.delta") {
        outBufRef.current += (msg.delta || "");
        return;
      }
      if (msg?.type === "response.output_text.done" || msg?.type === "response.completed") {
        const text = outBufRef.current.trim();
        outBufRef.current = "";
        if (text) onAgentMessage?.({ who: "bot", msg: text });
        return;
      }
    };
    ch.onerror = (e) => console.error("Consultant DC error:", e);
  }

  function routeTool(name, args) {
    if (!name) return;

    if (name === "emit_assessment") {
      const assessment_md = (args?.assessment_md || "").trim();
      const plan_md = (args?.plan_md || "").trim();
      const ddx = Array.isArray(args?.ddx) ? args.ddx : [];
      const md = [
        "### Assessment",
        assessment_md || "_(not provided)_",
        "",
        "### Differential Diagnosis",
        ddx.length
          ? ddx.map((d) => `- ${d.name} — ${(Math.max(0, Math.min(1, Number(d.probability))) * 100).toFixed(1)}%`).join("\n")
          : "_no items_",
        "",
        "### Plan",
        plan_md || "_(not provided)_",
      ].join("\n");

      onAgentMessage?.({ who: "bot", msg: md });
      try { window.dispatchEvent(new CustomEvent("ddx:render", { detail: { items: ddx } })); } catch {}
      onDone?.({ assessment_md, plan_md, ddx });
      return;
    }

    if (name === "emit_ddx") {
      const ddx = Array.isArray(args?.ddx) ? args.ddx : [];
      const txt = ddx.length
        ? `Top DDx:\n` + ddx.map((d) => `• ${d.name} (${(d.probability * 100).toFixed(0)}%)`).join("\n")
        : "No DDx items provided.";
      onAgentMessage?.({ who: "bot", msg: txt, type: "ddx", ddx });
      try { window.dispatchEvent(new CustomEvent("ddx:render", { detail: { items: ddx } })); } catch {}
      return;
    }

    if (name === "consult_set_question_count") {
      const c = Number(args?.count || 6);
      setQuestionCount(c);
      onAgentMessage?.({ who: "system", msg: `Question count set to ${c}.` });
      return;
    }

    if (name === "referral_create") {
      fetch(`${BACKEND}/consultant-agent/referral`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, item: args || {} }),
      }).catch(() => {});
      onAgentMessage?.({
        who: "bot",
        msg: `Referral created: ${args?.specialty || "Unknown"}${args?.urgency ? " • " + args.urgency : ""}${args?.mode ? " • " + args.mode : ""}${args?.reason ? " — " + args.reason : ""}`,
      });
      return;
    }

    if (name === "share_open_widget") {
      try { window.dispatchEvent(new CustomEvent("sw:open", { detail: { recipient_hint: args?.recipient_hint || "" } })); } catch {}
      onAgentMessage?.({ who: "system", msg: "Opened share widget." });
      return;
    }
    if (name === "share_update_field") {
      try {
        window.dispatchEvent(new CustomEvent("sw:update", {
          detail: { field: args?.field, value: args?.value, append: !!args?.append },
        }));
      } catch {}
      return;
    }
    if (name === "share_send") { try { window.dispatchEvent(new Event("sw:send")); } catch {} return; }
    if (name === "upload_lab_result") { try { window.dispatchEvent(new Event("labs:upload:open")); } catch {} onAgentMessage?.({ who: "system", msg: "Opened lab results uploader." }); return; }
  }

  function stopAll() {
    try { dcRef.current?.close(); } catch {}
    dcRef.current = null;
    try { pcRef.current?.getSenders?.().forEach((s) => s.track?.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.src = "";
      }
    } catch {}
    try { localStreamRef.current?.getTracks?.forEach((t) => t.stop()); } catch {}
    localStreamRef.current = null;
    remoteStreamRef.current = null;

    connectedRef.current = false;
    setStatus("idle");
    setMicActive(false);
    setVizSource("mic");
    outBufRef.current = "";
    toolBuffersRef.current.clear();
  }

  if (!active) return null;

  const waveStream =
    vizSource === "agent" && remoteStreamRef.current
      ? remoteStreamRef.current
      : (localStreamRef.current || null);

  return (
    <>
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

        <div className="ha-orb">
          <div className="ha-orb-ring" aria-hidden="true" />
          <Orb boost={5.5} className="ha-orb-canvas" />
        </div>

        <div className="va-controls">
          <button className="va-btn is-ghost" onClick={primeContext} title="Resend context">
            <FaPaperPlane />&nbsp;Sync Context
          </button>

          <div className="va-mini" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Q:</label>
            <select
              value={questionCount}
              onChange={(e) => {
                const v = Number(e.target.value || 6);
                setQuestionCount(v);
                dcSend({ type: "session.update", session: { metadata: { consult_q_count: v } } });
                onAgentMessage?.({ who: "system", msg: `Consultant will ask ~${v} questions.` });
              }}
              style={{ fontSize: 12, padding: "2px 6px", borderRadius: 8 }}
              aria-label="Question count"
            >
              {[4,5,6,7,8,9,10,12].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <button className="va-btn is-danger" onClick={stopAll} title="End session & reset">
            <FaBroom />&nbsp;End Session
          </button>
          <button className="close-btn" onClick={onClose} title="Close">
            <FaTimes />
          </button>
        </div>

        <div className="assistant-content" style={{ overflow: "hidden" }}>
          <div className="va-header" style={{ marginBottom: 12 }}>
            <div className="va-title">
              <FaUserMd style={{ marginRight: 8 }} /> Consultant Agent
            </div>
            <div className={`va-status ${status}`}>
              {status === "prepping"
                ? "Preparing • sending context…"
                : status === "connected"
                ? (micActive ? "Connected • VAD listening" : "Connected • mic muted")
                : status === "error"
                ? "Error • check connection"
                : "Idle"}
            </div>
          </div>

          <div style={{ border: "1px solid var(--card-border)", borderRadius: 12, padding: 8 }}>
            <AudioWave stream={waveStream} />
          </div>
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
          <FaPhone />
        </button>
      </div>
    </>
  );
});

export default ConsultantAgent;

