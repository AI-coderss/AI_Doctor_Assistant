/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes, FaBroom, FaPaperPlane } from "react-icons/fa";

/* 🔊 Visualizer + audio store */
import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/**
 * LabVoiceAgent
 * - WebRTC to OpenAI Realtime
 * - Registers approve_lab tool (strict schema)
 * - Buffers function-call deltas (official events); applies only on ".done"
 * - Removes from Pending and appends to the table via onApproveLab
 *
 * Props:
 *  - isVisible: boolean
 *  - onClose: () => void
 *  - sessionId: string
 *  - backendBase: string
 *  - context: string
 *  - onApproveLab: (item: {id, name, why?, priority?}) => void
 *  - onEndSession: () => void
 *  - allowedLabs?: string[]
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

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);             // outbound control DataChannel ("oai-events")
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null);

  // Which source should drive the visualizer: "mic" | "agent"
  const [vizSource, setVizSource] = useState("mic");

  // SSE
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

  // Tool-call buffers (by call_id)
  const toolBuffersRef = useRef(new Map()); // call_id -> { name, argsText }
  const callIdToNameRef = useRef(new Map()); // call_id OR item.id -> name (from output_item.added)

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
        setVizSource("mic");
        await sendContext();
        await startVoice();       // mic <-> model audio
        startSuggestStream();     // optional SSE text/suggestions (kept)
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

  const APPROVE_LAB_TOOL = {
    name: "approve_lab",
    description:
      "Approve a lab test that the user has verbally confirmed. Only call this tool after explicit user approval (e.g., 'yes', 'approve', 'add'). Choose names from the allowed list if provided.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Canonical lab test name." },
        priority: {
          type: "string",
          enum: ["STAT", "High", "Routine", "Medium", "Low"], // accept extras; we will normalize
          description: "Optional priority label."
        },
        why: { type: "string", description: "Optional reason the test is indicated." }
      },
      required: ["name"]
    }
  };

  const sendSessionUpdate = () => {
    const instruction = [
      "You are a clinical lab assistant. Speak concisely. No long monologues.",
      "NEVER modify the table via text. ONLY call the 'approve_lab' function after explicit user approval (e.g., 'yes', 'approve', 'add').",
      allowedLabs?.length
        ? `Use ONLY names from this allowed list when approving: ${allowedLabs.join(", ")}.`
        : "If a canonical list is not provided, prefer standard test names (e.g., 'CBC', 'CMP', 'TSH').",
    ].join(" ");

    const msg = {
      type: "session.update",
      session: {
        voice: "alloy",
        turn_detection: { type: "server_vad", threshold: 0.5 },
        tools: [APPROVE_LAB_TOOL],
        tool_choice: { type: "auto" },
        instructions: instruction
      }
    };
    try {
      dcRef.current?.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("session.update send failed:", e);
    }
  };

  // Tighten tool gating when explicitly asking for approval (optional visual prompt)
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

      // 2a) our outbound data channel for control/events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => { sendSessionUpdate(); };
      dc.onclose = () => {};

      // 3) mic -> PC
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 4) agent -> audio element + visualizer switching
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (!remoteStream) return;

        remoteStreamRef.current = remoteStream;

        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;

          const audioEl = remoteAudioRef.current;
          const onPlay   = () => setVizSource("agent");
          const onPause  = () => setVizSource("mic");
          const onEnded  = () => setVizSource("mic");

          audioEl.addEventListener?.("play", onPlay);
          audioEl.addEventListener?.("pause", onPause);
          audioEl.addEventListener?.("ended", onEnded);

          audioEl.play?.().catch((err) => console.warn("Agent audio play failed:", err));
        }

        const audioTracks = remoteStream.getAudioTracks?.() || [];
        audioTracks.forEach((t) => {
          t.onunmute = () => setVizSource("agent");
          t.onmute   = () => setVizSource("mic");
          t.onended  = () => setVizSource("mic");
        });

        try { startVolumeMonitoring(remoteStream, setAudioScale); } catch {}
        try { setAudioUrl(remoteStream); } catch {}
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
          setVizSource("mic");
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
      setVizSource("mic");
      throw err;
    }
  };

  function wireDataChannel(ch) {
    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try { msg = JSON.parse(raw); } catch {}

      // ---- 1) Name capture when function call item appears ----
      if (msg?.type === "response.output_item.added" && msg?.item?.type === "function_call") {
        const itemId = msg?.item?.id;
        const fname  = msg?.item?.name || "";
        if (itemId && fname) {
          callIdToNameRef.current.set(itemId, fname);
          // seed buffer in case deltas come before we see .done
          if (!toolBuffersRef.current.has(itemId)) {
            toolBuffersRef.current.set(itemId, { name: fname, argsText: "" });
          }
        }
        return;
      }

      // ---- 2) Streaming args ----
      if (msg?.type === "response.function_call_arguments.delta") {
        const callId = msg.call_id || msg.item_id || "default";
        const delta  = msg.delta || "";
        const prev   = toolBuffersRef.current.get(callId) || { name: callIdToNameRef.current.get(callId) || "", argsText: "" };
        prev.argsText += (delta || "");
        if (!prev.name && callIdToNameRef.current.get(callId)) prev.name = callIdToNameRef.current.get(callId);
        toolBuffersRef.current.set(callId, prev);
        return;
      }

      // ---- 3) Completion of args ----
      if (msg?.type === "response.function_call_arguments.done") {
        const callId = msg.call_id || msg.item_id || "default";
        const buf    = toolBuffersRef.current.get(callId);
        toolBuffersRef.current.delete(callId);
        const toolName = (buf?.name || callIdToNameRef.current.get(callId) || "").trim();

        let args = {};
        try { args = JSON.parse(buf?.argsText || "{}"); } catch (e) {
          console.warn("Failed to parse tool args JSON:", e, buf?.argsText);
        }

        if (/approve_lab/i.test(toolName) && args?.name) {
          approveFromTool(args);
        }
        return;
      }

      // ---- Optional asking prompt ----
      if (msg?.type === "ask" && typeof msg.prompt === "string") {
        setAskingText(msg.prompt);
        return;
      }

      // (Other events ignored)
    };

    ch.onerror = (e) => console.error("DataChannel error:", e);
  }

  const mapPriority = (p) => {
    const s = String(p || "").trim().toLowerCase();
    if (s === "stat" || s === "urgent" || s === "high") return "High";
    if (s === "medium") return "Medium";
    if (s === "routine" || s === "low") return "Low";
    return ""; // unknown/omitted
  };

  async function approveFromTool(item) {
    try {
      const res = await fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          item: {
            name: String(item.name || "").trim(),
            priority: mapPriority(item.priority),
            why: String(item.why || "").trim()
          }
        })
      });
      if (!res.ok) throw new Error(`/lab-agent/approve ${res.status}`);
      const data = await res.json();

      const approved = {
        id: data?.item?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: data?.item?.name || item.name,
        priority: mapPriority(data?.item?.priority || item.priority),
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

  // Optional: keep SSE suggestions stream alive
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
          } catch {
            // ignore
          }
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
      priority: raw.priority ? mapPriority(raw.priority) : "",
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

  /* ---------- LEFT COLUMN PORTAL (Pending list) ---------- */
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

  // Decide which stream drives the AudioWave
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



