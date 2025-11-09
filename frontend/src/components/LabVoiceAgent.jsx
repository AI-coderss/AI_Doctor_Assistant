/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lab-voice-agent.css";
import Orb from "./Orb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes, FaBroom, FaPaperPlane } from "react-icons/fa";

/* Visualizer + audio store */
import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/**
 * LabVoiceAgent — now also drives ClinicalNotes actions via function-calling
 * Props:
 * - isVisible, onClose, sessionId, backendBase, context
 * - onApproveLab(item), onEndSession()
 * - allowedLabs?: string[]
 */
export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
  onEndSession = () => {},
  allowedLabs = [],
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [pendingQueue, setPendingQueue] = useState([]);
  const [askingText, setAskingText] = useState("");

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null);

  const [vizSource, setVizSource] = useState("mic");

  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

  const toolBuffersRef = useRef(new Map());

  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

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
        await startVoice();
        startSuggestStream();
      } catch (e) {
        console.error("Agent init failed:", e);
        setStatus("error");
      }
    })();
    return () => { stopAll(); };
  }, [isVisible]);

  const sendContext = async () => {
    try {
      await fetch(`${backendBase}/lab-agent/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context: context || "" }),
      });
    } catch (e) { console.error("Failed to send context:", e); }
  };

  // ------------ realtime session.update (tools list) ------------
  const sendSessionUpdate = () => {
    const instruction = [
      "You are a concise clinical lab & notes assistant.",
      "For labs: ONLY call approve_lab after explicit confirmation.",
      allowedLabs?.length
        ? `Use ONLY names from this allowed list when approving: ${allowedLabs.join(", ")}.`
        : "Prefer standard test names when no list provided.",
      "For clinical notes: call a clinical_* tool only when asked; keep responses short."
    ].join(" ");

    const TOOLS = [
      // labs
      {
        name: "approve_lab",
        description: "Approve a lab test after explicit approval.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            name: { type: "string" },
            priority: { type: "string", enum: ["STAT", "High", "Routine"] },
            why: { type: "string" }
          },
          required: ["name"]
        }
      },
      {
        name: "reject_lab",
        description: "Reject a proposed lab.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { name: { type: "string" }, reason: { type: "string" } },
          required: ["name"]
        }
      },

      // clinical notes
      {
        name: "clinical_add_section",
        description: "Add a new section; draft if text is missing.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            title: { type: "string" },
            text: { type: "string" },
            style: { type: "string", enum: ["paragraph","bullets"] },
            anchor_key: { type: "string" },
            position: { type: "string", enum: ["before","after","end"] }
          },
          required: ["title"]
        }
      },
      {
        name: "clinical_remove_section",
        description: "Remove a section by key.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { key: { type: "string" } },
          required: ["key"]
        }
      },
      {
        name: "clinical_update_section",
        description: "Replace or append to a section.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            key: { type: "string" },
            text: { type: "string" },
            append: { type: "boolean" }
          },
          required: ["key","text"]
        }
      },
      {
        name: "clinical_rename_section",
        description: "Rename a section; optionally set new key.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            key: { type: "string" },
            new_title: { type: "string" },
            new_key: { type: "string" }
          },
          required: ["key","new_title"]
        }
      },
      {
        name: "clinical_apply_markdown",
        description: "Replace the entire note with given Markdown.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { markdown: { type: "string" } },
          required: ["markdown"]
        }
      },
      {
        name: "clinical_save",
        description: "Save the current note now.",
        parameters: { type: "object", additionalProperties: false, properties: {} }
      },
    ];

    try {
      dcRef.current?.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "alloy",
          turn_detection: { type: "server_vad", threshold: 0.5 },
          tools: TOOLS,
          tool_choice: { type: "auto" },
          instructions: instruction,
        },
      }));
    } catch (e) { console.warn("session.update send failed:", e); }
  };

  // ------------ WebRTC ------------
  const startVoice = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    try { startVolumeMonitoring(stream, setAudioScale); } catch {}

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    wireDataChannel(dc);
    dc.onopen = () => sendSessionUpdate();

    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams || [];
      if (!remoteStream) return;
      remoteStreamRef.current = remoteStream;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        const el = remoteAudioRef.current;
        const onPlay = () => setVizSource("agent");
        const onPause = () => setVizSource("mic");
        const onEnded = () => setVizSource("mic");
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.play?.().catch(()=>{});
      }
      try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
      try { setAudioUrl(remoteStream); } catch {}
    };

    pc.ondatachannel = (e) => e.channel && wireDataChannel(e.channel);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { setStatus("connected"); setMicActive(true); }
      else if (["failed","closed","disconnected"].includes(pc.connectionState)) {
        setStatus("error"); setMicActive(false); setVizSource("mic");
      }
    };

    let offer = await pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = offer.sdp.replace(
      /a=rtpmap:\d+ opus\/48000\/2/g,
      "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
    );
    await pc.setLocalDescription(offer);

    const res = await fetch(`${backendBase}/lab-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId },
      body: offer.sdp,
    });
    if (!res.ok) throw new Error(`/lab-agent/rtc-connect ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  };

  // ------------ Tool-call -> UI handlers ------------
  const dispatch = (name, detail) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));

  const handleClinicalAdd = async (args) => {
    const title = (args?.title || "").trim();
    if (!title) return;
    let text = (args?.text || "").trim();
    const style = args?.style === "bullets" ? "bullets" : "paragraph";
    const anchor_key = args?.anchor_key || undefined;
    const position = args?.position || "after";

    // If no text provided by the tool, ask backend to draft it (RAG)
    if (!text) {
      try {
        const r = await fetch(`${backendBase}/api/clinical-notes/suggest-section`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, transcript: context || "", title, style })
        });
        const j = await r.json();
        if (j?.ok && j?.text) text = j.text;
      } catch {}
    }

    // Insert into the live editor
    dispatch("cn:section.add", { title, key: slugify(title), text, anchor_key, position });
  };

  const handleClinicalRemove = (args) => {
    const key = (args?.key || "").trim();
    if (!key) return;
    dispatch("cn:section.remove", { key });
  };

  const handleClinicalUpdate = (args) => {
    const key = (args?.key || "").trim();
    const text = (args?.text || "").trim();
    const append = !!args?.append;
    if (!key || !text) return;
    dispatch("cn:section.update", { key, text, append });
  };

  const handleClinicalRename = (args) => {
    const key = (args?.key || "").trim();
    const new_title = (args?.new_title || "").trim();
    const new_key = (args?.new_key || "").trim() || slugify(new_title);
    if (!key || !new_title) return;
    dispatch("cn:section.rename", { key, new_title, new_key });
  };

  const handleClinicalApplyMarkdown = (args) => {
    const md = (args?.markdown || "").trim();
    if (!md) return;
    dispatch("cn:apply", { markdown: md });
  };

  const handleClinicalSave = async () => {
    dispatch("cn:save"); // your ClinicalNotes already wires this to /api/clinical-notes/save
  };

  function slugify(s) {
    return (String(s||"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g,"_")
      .replace(/^_+|_+$/g,"")
      .slice(0,64)) || "custom_section";
  }

  // ------------ DataChannel glue ------------
  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) {}

      // Collect live function-call chunks
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
        if (!buf) return;

        let args = {};
        try { args = JSON.parse(buf.argsText || "{}"); } catch {}
        const name = buf.name || "";

        // Route
        if (name === "approve_lab") return approveFromTool(args);
        if (name === "reject_lab") return; // no UI change required here

        if (name === "clinical_add_section") return handleClinicalAdd(args);
        if (name === "clinical_remove_section") return handleClinicalRemove(args);
        if (name === "clinical_update_section") return handleClinicalUpdate(args);
        if (name === "clinical_rename_section") return handleClinicalRename(args);
        if (name === "clinical_apply_markdown") return handleClinicalApplyMarkdown(args);
        if (name === "clinical_save") return handleClinicalSave();
        return;
      }
    };
    ch.onerror = (e) => console.error("DataChannel error:", e);
  }

  async function approveFromTool(item) {
    const approved = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: String(item.name || "").trim(),
      priority: item.priority || "",
      why: item.why || "",
    };
    try {
      await fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, item: approved }),
      });
      applyApproved(approved);
    } catch (e) { console.error("approveFromTool backend failed:", e); }
  }

  const stopAll = () => {
    try { sseAbortRef.current?.abort(); } catch {}
    sseAbortRef.current = null; sseReaderRef.current = null;

    try { if (pcRef.current) { pcRef.current.getSenders?.().forEach(s => s.track?.stop()); pcRef.current.close(); } } catch {}
    pcRef.current = null;
    try { localStreamRef.current?.getTracks?.().forEach(t => t.stop()); } catch {}
    localStreamRef.current = null;
    try {
      if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = null; remoteAudioRef.current.pause?.(); remoteAudioRef.current.src = ""; }
    } catch {}
    remoteStreamRef.current = null;

    setMicActive(false); setVizSource("mic"); setStatus("idle"); setPendingQueue([]);
  };

  const startSuggestStream = async () => {
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;
    try {
      const res = await fetch(`${backendBase}/lab-agent/suggest-stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/lab-agent/suggest-stream ${res.status}`);
      const reader = res.body.getReader(); sseReaderRef.current = reader;
      const decoder = new TextDecoder(); let buf = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim(); if (!line) continue;
          const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
          if (!payload) continue;
          try {
            const msg = JSON.parse(payload);
            if (msg?.type === "suggestion" && msg?.item?.name) {
              const itm = normalizeItem(msg.item, true);
              if (itm && !hasByName(pendingQueue, itm.name)) setPendingQueue(prev => [...prev, itm]);
            }
          } catch {}
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) console.error("suggest-stream error:", e);
    }
  };

  const makeId = (name) => {
    const seq = ++seqRef.current;
    const slug = String(name || "").toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9\-().+/]/g,"");
    return `${slug}::${Date.now()}::${seq}`;
  };

  const normalizeItem = (raw, forceId = false) => {
    if (!raw) return null;
    const name = ((raw.name || raw.test || "") + "").trim();
    if (!name) return null;
    return { id: raw.id && !forceId ? String(raw.id) : makeId(name), name, why: raw.why ? String(raw.why).trim() : "", priority: raw.priority ? String(raw.priority).trim() : "" };
  };

  const hasByName = (arr, nm) => (arr || []).some(x => String(x.name||"").trim().toLowerCase() === String(nm||"").trim().toLowerCase());
  const removePendingByName = (nm) => setPendingQueue(prev => prev.filter(x => (x.name||"").toLowerCase() !== String(nm||"").toLowerCase()));
  const notifyManualAdd = (item) => {
    fetch(`${backendBase}/lab-agent/tool-bridge`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, tool: "add_lab_manual", args: item }),
    }).catch(()=>{});
  };

  const applyApproved = (item) => {
    const nm = String(item?.name || "").trim(); if (!nm) return;
    removePendingByName(nm);
    try { onApproveLab?.(item); } catch {}
    if (askingText && nm && askingText.toLowerCase().includes(nm.toLowerCase())) setAskingText("");
  };

  const endSessionNow = async () => {
    try { await fetch(`${backendBase}/lab-agent/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) }); }
    finally { stopAll(); resetAll(); onEndSession?.(); }
  };

  if (!isVisible) return null;

  const waveStream = vizSource === "agent" && remoteStreamRef.current ? remoteStreamRef.current : (localStreamRef.current || null);

  return (
    <>
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

        <div className="ha-orb">
          <div className="ha-orb-ring" aria-hidden="true" />
          <Orb  boost={5.5} className="ha-orb-canvas" />
        </div>

        <div className="va-controls">
          <button className="va-btn is-ghost" onClick={sendContext} title="Resend context">
            <FaPaperPlane />&nbsp;Sync Context
          </button>
          <button className="va-btn is-danger" onClick={endSessionNow} title="End session & reset">
            <FaBroom />&nbsp;End Session
          </button>
          <button className="close-btn" onClick={() => onClose?.()} title="Close">
            <FaTimes />
          </button>
        </div>

        <div className="assistant-content" style={{ overflow: "hidden" }}>
          <div className="va-header" style={{ marginBottom: 12 }}>
            <div className="va-title"><FaFlask style={{ marginRight: 8 }} /> Lab Agent</div>
            <div className={`va-status ${status}`}>
              {status === "prepping" ? "Preparing • sending context…" :
               status === "connected" ? (micActive ? "Connected • VAD listening" : "Connected • mic muted") :
               status === "error" ? "Error • check connection" : "Idle"}
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

      {pendingQueue.length > 0 ? createPortal(
        <div className="pending-dock pending-dock--left" aria-live="polite">
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
                  <button className="va-btn is-ghost" onClick={() => setPendingQueue(prev => prev.filter(x => x.id !== s.id))}>
                    Skip
                  </button>
                </div>
                <div className="tiny-hint">Say “yes / approve / add” to confirm via the agent.</div>
              </div>
            ))}
          </div>
        </div>, document.body) : null}
    </>
  );
}




