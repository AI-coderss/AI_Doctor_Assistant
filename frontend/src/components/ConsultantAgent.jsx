/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaUserMd, FaTimes, FaBroom, FaPaperPlane, FaPhone } from "react-icons/fa";
import "../styles/lab-voice-agent.css"; // reuse same CSS
import Orb from "./Orb.jsx";
import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

export default function ConsultantAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,     // e.g. https://ai-doctor-assistant-voice-mode-webrtc.onrender.com  (same as Lab agent host)
  context,         // transcript / context string
  onCreateReferral = () => {},   // optional UI callback
  onEndSession = () => {},
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

  const [vizSource, setVizSource] = useState("mic"); // mic | agent
  const toolBuffersRef = useRef(new Map());
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);
  const seqRef = useRef(0);

  const { setAudioScale } = useAudioForVisualizerStore.getState();
  const { setAudioUrl } = useAudioStore();

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
        await startVoice();
        startSuggestStream();
      } catch (e) {
        console.error("ConsultantAgent init failed:", e);
        setStatus("error");
      }
    })();
    return () => { stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  const sendContext = async () => {
    if (!context) return;
    try {
      await fetch(`${backendBase}/consultant-agent/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, context }),
      });
    } catch (e) { console.error("consultant context failed:", e); }
  };

  // ------- session.update (declare tools for realtime function-calling) -------
  const sendSessionUpdate = () => {
    const instruction = [
      "You are a concise consultant-coordination assistant for clinicians.",
      "Your goals: identify appropriate specialty, prepare crisp referral reasons, urgency, and channel (tele / in-person).",
      "Never submit or send emails without explicit clinician confirmation.",
      "When asked, create/modify clinical notes via the clinical_* tools.",
      "When asked, open/share email via share_* tools for the clinician to review first.",
    ].join(" ");

    const TOOLS = [
      // ---- REFERRALS / CONSULTS ----
      {
        name: "consult_request",
        description: "Propose a specialty consultation.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            specialty: { type: "string", description: "E.g., cardiology, endocrinology" },
            reason: { type: "string", description: "Short, clinical reason" },
            urgency: { type: "string", enum: ["STAT","High","Routine"] },
            mode: { type: "string", enum: ["in-person","tele","asynchronous"] }
          },
          required: ["specialty", "reason"]
        }
      },
      {
        name: "consult_cancel",
        description: "Cancel the pending consultation suggestion or request.",
        parameters: { type: "object", additionalProperties: false, properties: {} }
      },
      {
        name: "referral_create",
        description: "Confirm and create a referral ticket.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            patient_id: { type: "string" },
            specialty: { type: "string" },
            notes: { type: "string" },
            urgency: { type: "string", enum: ["STAT","High","Routine"] },
            mode: { type: "string", enum: ["in-person","tele","asynchronous"] }
          },
          required: ["specialty"]
        }
      },

      // ---- CLINICAL NOTES (re-use your existing editor bridges) ----
      {
        name: "clinical_add_section",
        description: "Add a new section; draft text if missing.",
        parameters: {
          type: "object",
          additionalProperties: false,
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
      { name: "clinical_remove_section",
        description: "Remove a section by key.",
        parameters: { type: "object", additionalProperties: false, properties: { key: { type: "string" } }, required: ["key"] }
      },
      { name: "clinical_update_section",
        description: "Replace or append text to an existing section.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { key: { type: "string" }, text: { type: "string" }, append: { type: "boolean" } },
          required: ["key","text"]
        }
      },
      { name: "clinical_rename_section",
        description: "Rename a section; optionally set a new key.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { key: { type: "string" }, new_title: { type: "string" }, new_key: { type: "string" } },
          required: ["key","new_title"]
        }
      },
      { name: "clinical_apply_markdown",
        description: "Replace the entire note with Markdown.",
        parameters: { type: "object", additionalProperties: false, properties: { markdown: { type: "string" } }, required: ["markdown"] }
      },
      { name: "clinical_save",
        description: "Save the current note.",
        parameters: { type: "object", additionalProperties: false, properties: {} }
      },

      // ---- SHARE WIDGET (email draft) ----
      {
        name: "share_open_widget",
        description: "Open share widget so clinician can review email.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { recipient_hint: { type: "string" } }
        }
      },
      {
        name: "share_update_field",
        description: "Update one field of the share widget.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            field: { type: "string", enum: ["to","subject","body"] },
            value: { type: "string" },
            append: { type: "boolean" }
          },
          required: ["field","value"]
        }
      },
      {
        name: "share_send",
        description: "Send email after explicit confirmation.",
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
    } catch (e) { console.warn("consultant session.update failed:", e); }
  };

  // ----------------------- WebRTC -----------------------
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

    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
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

    const res = await fetch(
      `${backendBase}/consultant-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
      { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp }
    );
    if (!res.ok) throw new Error(`/consultant-agent/rtc-connect ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  };

  // ------------------ Tool-call routing ------------------
  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) {}

      // collect function-call chunks
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

        if (name === "consult_request") return handleConsultRequest(args);
        if (name === "consult_cancel") return handleConsultCancel();
        if (name === "referral_create") return handleReferralCreate(args);

        if (name === "clinical_add_section") return handleClinicalAdd(args);
        if (name === "clinical_remove_section") return handleClinicalRemove(args);
        if (name === "clinical_update_section") return handleClinicalUpdate(args);
        if (name === "clinical_rename_section") return handleClinicalRename(args);
        if (name === "clinical_apply_markdown") return handleClinicalApplyMarkdown(args);
        if (name === "clinical_save") return handleClinicalSave();

        if (name === "share_open_widget") return handleShareOpen(args);
        if (name === "share_update_field") return handleShareUpdateField(args);
        if (name === "share_send") return handleShareSend(args);
        return;
      }
    };
    ch.onerror = (e) => console.error("ConsultantAgent DC error:", e);
  }

  // ------ UI bridge helpers ------
  const dispatch = (name, detail) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));

  const handleConsultRequest = (args) => {
    const item = normalizeItem(args, true);
    if (!item) return;
    if (!hasBySpecialty(pendingQueue, item.specialty)) {
      setPendingQueue((prev) => [...prev, item]);
      setAskingText(`Proposed ${item.specialty} consult — ${item.reason || "no reason provided"}`);
    }
  };

  const handleConsultCancel = () => {
    setPendingQueue([]);
    setAskingText("");
  };

  const handleReferralCreate = async (args) => {
    const item = normalizeItem(args, true);
    if (!item) return;
    try {
      await fetch(`${backendBase}/consultant-agent/referral`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, item }),
      });
      onCreateReferral?.(item);
      removePendingBySpecialty(item.specialty);
    } catch (e) { console.error("referral create failed:", e); }
  };

  // ---- clinical notes bridge (re-use your app events) ----
  const handleClinicalAdd = async (args) => {
    const title = (args?.title || "").trim(); if (!title) return;
    const style = args?.style === "bullets" ? "bullets" : "paragraph";
    let text = (args?.text || "").trim();
    if (!text && context) {
      try {
        const r = await fetch(`/api/clinical-notes/suggest-section`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, transcript: context || "", title, style })
        });
        const j = await r.json();
        if (j?.ok && j?.text) text = j.text;
      } catch {}
    }
    dispatch("cn:section.add", {
      title,
      key: slugify(title),
      text,
      anchor_key: args?.anchor_key || undefined,
      position: args?.position || "after",
    });
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
  const handleClinicalSave = () => dispatch("cn:save");

  // ---- share widget bridge ----
  const handleShareOpen = (args) => {
    const recipient_hint = (args?.recipient_hint || "").trim();
    dispatch("sw:open", { recipient_hint: recipient_hint || undefined });
  };
  const handleShareUpdateField = (args) => {
    const field = (args?.field || "").trim().toLowerCase();
    const value = (args?.value || "").trim();
    const append = !!args?.append;
    if (!field || !value) return;
    if (!["to","subject","body"].includes(field)) return;
    dispatch("sw:update", { field, value, append });
  };
  const handleShareSend = () => dispatch("sw:send", {});

  // -------------------- helpers --------------------
  function slugify(s) {
    return (String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,64)) || "section";
  }
  const makeId = (specialty) => `${String(specialty||"").toLowerCase()}::${Date.now()}::${(++seqRef.current)}`;
  const normalizeItem = (raw, forceId=false) => {
    if (!raw) return null;
    const specialty = String(raw.specialty || "").trim();
    if (!specialty) return null;
    return {
      id: raw.id && !forceId ? String(raw.id) : makeId(specialty),
      specialty,
      reason: raw.reason ? String(raw.reason).trim() : "",
      urgency: raw.urgency ? String(raw.urgency).trim() : "",
      mode: raw.mode ? String(raw.mode).trim() : "",
      patient_id: raw.patient_id ? String(raw.patient_id).trim() : "",
      notes: raw.notes ? String(raw.notes).trim() : "",
    };
  };
  const hasBySpecialty = (arr, s) =>
    (arr || []).some(x => String(x.specialty||"").toLowerCase() === String(s||"").toLowerCase());
  const removePendingBySpecialty = (s) =>
    setPendingQueue(prev => prev.filter(x => (x.specialty||"").toLowerCase() !== String(s||"").toLowerCase()));

  // -------------------- stop & suggest stream --------------------
  const stopAll = () => {
    try { sseAbortRef.current?.abort(); } catch {}
    sseAbortRef.current = null; sseReaderRef.current = null;

    try { pcRef.current?.getSenders?.().forEach(s => s.track?.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.src = "";
      }
    } catch {}
    try { localStreamRef.current?.getTracks?.forEach(t => t.stop()); } catch {}
    localStreamRef.current = null;
    remoteStreamRef.current = null;

    setMicActive(false);
    setVizSource("mic");
    setStatus("idle");
    setPendingQueue([]);
  };

  const startSuggestStream = async () => {
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;
    try {
      const res = await fetch(`${backendBase}/consultant-agent/suggest-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/consultant-agent/suggest-stream ${res.status}`);
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
            if (msg?.type === "suggestion" && msg?.item?.specialty) {
              const itm = normalizeItem(msg.item, true);
              if (itm && !hasBySpecialty(pendingQueue, itm.specialty))
                setPendingQueue(prev => [...prev, itm]);
            }
          } catch {}
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) console.error("consultant suggest-stream error:", e);
    }
  };

  if (!isVisible) return null;

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
          <button className="va-btn is-ghost" onClick={sendContext} title="Resend context">
            <FaPaperPlane />&nbsp;Sync Context
          </button>
          <button className="va-btn is-danger" onClick={stopAll} title="End session & reset">
            <FaBroom />&nbsp;End Session
          </button>
          <button className="close-btn" onClick={() => onClose?.()} title="Close">
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
          <FaPhone />
        </button>
      </div>

      {/* Pending consult suggestions dock (left) */}
      {pendingQueue.length > 0
        ? createPortal(
            <div className="pending-dock pending-dock--left" aria-live="polite">
              <div className="dock-title">Pending Consultant Suggestions</div>
              <div className="pending-list">
                {pendingQueue.map((s) => (
                  <div key={s.id} className="pending-item">
                    <div className="sug-title">{s.specialty}</div>
                    {(s.urgency || s.reason || s.mode) && (
                      <div className="sug-meta">
                        {s.urgency ? <span className="badge">{s.urgency}</span> : null}
                        {s.mode ? <> • <span className="badge">{s.mode}</span></> : null}
                      </div>
                    )}
                    {s.reason ? (
                      <div className="tiny-hint" style={{ marginTop: 6 }}>
                        Reason: {s.reason}
                      </div>
                    ) : null}

                    <div className="btn-row" style={{ marginTop: 8 }}>
                      <button
                        className="va-btn is-primary"
                        onClick={() => {
                          handleReferralCreate(s);
                        }}
                      >
                        Create Referral
                      </button>
                      <button
                        className="va-btn is-ghost"
                        onClick={() => removePendingBySpecialty(s.specialty)}
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
