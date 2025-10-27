/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaFlask, FaTimes, FaBroom, FaPaperPlane } from "react-icons/fa";

/* 🔊 Visualizer + audio store */
import AudioWave from "./AudioWave.jsx"; // your provided visualizer component
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

/**
 * LabVoiceAgent
 * - WebRTC to OpenAI Realtime
 * - Registers approve_lab tool (strict schema)
 * - Buffers function-call deltas; applies only on "completed"
 * - Replaces "Conversation" card with the AudioWave visualizer (no scroll, no label)
 *
 * Props:
 * - isVisible: boolean
 * - onClose: () => void
 * - sessionId: string
 * - backendBase: string
 * - context: string
 * - onApproveLab: (item: {id, name, why?, priority?}) => void
 * - onEndSession: () => void
 * - allowedLabs?: string[] (optional; sent as guidance to the model)
 */
export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
  onEndSession = () => { },
  allowedLabs = [],
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [pendingQueue, setPendingQueue] = useState([]); // [{id, name, why, priority}]
  const [askingText, setAskingText] = useState("");

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null); // outbound control DataChannel ("oai-events")
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null); // remote MediaStream for visualizer

  // Which source should drive the visualizer: "mic" | "agent"
  const [vizSource, setVizSource] = useState("mic");

  // SSE (kept for compatibility)
  const sseAbortRef = useRef(null);
  const sseReaderRef = useRef(null);

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
        setVizSource("mic"); // default to mic when opening
        await sendContext();
        await startVoice(); // mic <-> model audio
        startSuggestStream(); // optional SSE text/suggestions (kept)
      } catch (e) {
        console.error("Agent init failed:", e);
        setStatus("error");
      }
    })();

    return () => {
      stopAll();
    };
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
          enum: ["high", "medium", "low"],
          description: "Optional priority label.",
        },
        why: { type: "string", description: "Optional reason the test is indicated." },
      },
      required: ["name"],
    },
  };

  const sendSessionUpdate = () => {
    const instruction = [
      "You are a clinical lab assistant. Speak concisely. No long monologues.",
      "You must NEVER modify the table directly via text. Instead, ONLY call the 'approve_lab' tool after the user explicitly confirms (e.g., 'yes', 'approve', 'add').",
      "If you are not sure which lab name to use, ask a short clarification question then wait.",
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
        instructions: instruction,
      },
    };
    try {
      dcRef.current?.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("session.update send failed:", e);
    }
  };

  const startVoice = async () => {
    try {
      // 1) Mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      try {
        startVolumeMonitoring(stream, setAudioScale);
      } catch { }

      // 2) WebRTC peer
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;

      // 2a) outbound data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      // Changed by Hamender
      wireDataChannel(dc); // Wire the outbound channel for bidirectional communication
      dc.onopen = () => {
        sendSessionUpdate();
      };
      dc.onclose = () => console.log("Outbound data channel closed");

      // 3) mic -> PC
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 4) agent voice -> audio element + visualizer switching
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        // Changed by Hamender
        if (!remoteStream) {
          console.warn("No remote stream in ontrack event");
          return;
        }

        remoteStreamRef.current = remoteStream;

        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          const audioEl = remoteAudioRef.current;

          const onPlay = () => setVizSource("agent");
          const onPause = () => setVizSource("mic");
          const onEnded = () => setVizSource("mic");

          audioEl.removeEventListener?.("play", onPlay);
          audioEl.removeEventListener?.("pause", onPause);
          audioEl.removeEventListener?.("ended", onEnded);

          audioEl.addEventListener?.("play", onPlay);
          audioEl.addEventListener?.("pause", onPause);
          audioEl.addEventListener?.("ended", onEnded);

          audioEl.play?.().catch((err) => console.warn("Agent audio play failed:", err));
        }

        const audioTracks = remoteStream.getAudioTracks?.() || [];
        audioTracks.forEach((t) => {
          t.onunmute = () => setVizSource("agent");
          t.onmute = () => setVizSource("mic");
          t.onended = () => setVizSource("mic");
        });

        try {
          startVolumeMonitoring(remoteStream, setAudioScale);
        } catch { }
        try {
          setAudioUrl(remoteStream);
        } catch { }
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

      let offer = await pc.createOffer({ offerToReceiveAudio: true });
      offer.sdp = offer.sdp.replace(
        /a=rtpmap:\d+ opus\/48000\/2/g,
        "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
      );
      await pc.setLocalDescription(offer);

      const res = await fetch(
        `${backendBase}/lab-agent/rtc-connect?session_id=${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/sdp", "X-Session-Id": sessionId },
          body: offer.sdp,
        }
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
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        // Changed by Hamender
        console.warn("Failed to parse message as JSON:", e, "Raw:", raw);
      }

      // Changed by Hamender
      if (msg?.type === "response.output_item.added") {
        const item = msg.item;
        if (item?.type === "function_call") {
          const id = item.call_id || item.id || "default";
          const name = item.name || "";
          const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
          prev.name = name;
          toolBuffersRef.current.set(id, prev);
        }
        return;
      }

      if (msg?.type === "response.function_call_arguments.delta" || msg?.type === "tool_call.delta") {
        const id = msg.call_id || msg.id || "default";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || { name: "", argsText: "" };
        if (!prev.name) prev.name = "approve_lab";
        prev.argsText += delta || "";
        toolBuffersRef.current.set(id, prev);
        return;
      }

      // Changed by Hamender
      if (msg?.type === "response.function_call_arguments.done" || msg?.type === "tool_call_arguments.done" || msg?.type === "response.function_call.completed" || msg?.type === "tool_call.completed") {
        const id = msg.call_id || msg.id || "default";
        const buf = toolBuffersRef.current.get(id);
        toolBuffersRef.current.delete(id);
        if (!buf) {
          // No buffer, perhaps done without deltas, ignore
          return;
        }
        if (!buf.name) buf.name = "approve_lab"; // fallback
        console.log("Tool call completed - id:", id, "name:", buf.name, "argsText:", buf.argsText);

        let args = {};
        try {
          args = JSON.parse(buf.argsText || "{}");
          console.log("Parsed args:", args);
          if (args && args.name && args.priority) {
            approveFromTool(args)
          }
        } catch (e) {
          console.warn("Failed to parse args:", e);
        }


        if (msg?.type === "ask") {
          setAskingText(String(msg.prompt || ""));
        }
      };

      ch.onerror = (e) => console.error("DataChannel error:", e);
    }
  }

  async function approveFromTool(item) {
    // Changed by Hamender
    const approved = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: String(item.name || "").trim(),
      priority: item.priority || "",
      why: item.why || "",
    };


    try {
      const res = await fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          item: approved,
        }),
      });
      if (!res.ok) throw new Error(`/lab-agent/approve ${res.status}`);
      const data = await res.json();

      applyApproved(approved);

      if (askingText && approved.name && askingText.toLowerCase().includes(approved.name.toLowerCase())) {
        setAskingText("");
      }
    } catch (e) {
      console.error("approveFromTool backend failed:", e);// Approval already applied locally, so no issue
    }
  }

  const stopAll = () => {
    try {
      sseAbortRef.current?.abort();
    } catch { }
    sseAbortRef.current = null;
    sseReaderRef.current = null;

    try {
      if (pcRef.current) {
        pcRef.current.getSenders?.().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    } catch { }
    pcRef.current = null;

    try {
      localStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch { }
    localStreamRef.current = null;

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.src = "";
      }
    } catch { }

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
            continue;
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
    const slug = String(name || "")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-().+/]/g, "");
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

  const notifyManualAdd = (item) => {
    try {
      fetch(`${backendBase}/lab-agent/tool-bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, tool: "add_lab_manual", args: item }),
      }).catch(() => { });
    } catch { }
  };

  const applyApproved = (item) => {
    const nm = String(item?.name || "").trim();
    if (!nm) return;

    removePendingByName(nm);
    try {
      onApproveLab?.(item);
    } catch { }

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
      }).catch(() => { });
    } finally {
      stopAll();
      resetAll();
      onEndSession?.();
    }
  };

  if (!isVisible) return null;

  const leftColumn =
    pendingQueue.length > 0
      ? createPortal(
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
                  <button
                    className="va-btn is-primary"
                    onClick={() => {
                      applyApproved(s);
                      notifyManualAdd(s);
                    }}
                  >
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
      )
      : null;

  const waveStream =
    vizSource === "agent" && remoteStreamRef.current
      ? remoteStreamRef.current
      : localStreamRef.current || null;

  return (
    <>
      {/* Right-side voice assistant panel */}
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        {/* hidden audio element */}
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

        <div className="assistant-orb">
          <BaseOrb className="base-orb" />
        </div>

        {/* top-right controls */}
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

        {/* Content: visualizer */}
        <div className="assistant-content" style={{ overflow: "hidden" }}>
          <div className="va-header" style={{ marginBottom: 12 }}>
            <div className="va-title">
              <FaFlask style={{ marginRight: 8 }} /> Lab Agent
            </div>
            <div className={`va-status ${status}`}>
              {status === "prepping"
                ? "Preparing • sending context…"
                : status === "connected"
                  ? micActive
                    ? "Connected • VAD listening"
                    : "Connected • mic muted"
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

      {/* Left column with pending approvals */}
      {leftColumn}
    </>
  );
}



