/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
// ConsultantAgent.jsx (revised to mirror LabVoiceAgent connection flow)
/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
// ConsultantAgent.jsx (WebRTC realtime – now with question list side panel)

import React, {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import {
  FaUserMd,
  FaTimes,
  FaBroom,
  FaPaperPlane,
  FaMicrophoneAlt,
} from "react-icons/fa";
import "../styles/lab-voice-agent.css";
import Orb from "./Orb.jsx";
import AudioWave from "./AudioWave.jsx";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore.js";
import useAudioStore from "../store/audioStore.js";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

const ConsultantAgent = forwardRef(function ConsultantAgent(
  { active, sessionId, backendBase, context, onAgentMessage, onDone, onClose = () => {} },
  ref
) {
  const BACKEND = String(
    backendBase || "https://ai-doctor-assistant-backend-server.onrender.com"
  ).replace(/\/+$/, "");
  const CONNECT_URL = `${BACKEND}/consultant-agent/rtc-connect?session_id=${encodeURIComponent(
    sessionId || ""
  )}`;
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

  // NEW: question list side panel
  const [questionList, setQuestionList] = useState([]);
  const [waveStream, setWaveStream] = useState(null);

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
      // sendSessionUpdate will fire when DC opens (dc.onopen)
      // kick the first response
      dcSend({ type: "response.create" });
    },
    async stop() {
      stopAll();
    },
    setQuestionCount(n) {
      const nn = Math.max(1, Math.min(20, Number(n) || 6));
      setQuestionCount(nn);
      // Update instructions only (NO metadata)
      dcSend({
        type: "session.update",
        session: { instructions: buildInstructions(nn) },
      });
      onAgentMessage?.({
        who: "system",
        msg: `Consultant will ask ~${nn} questions.`,
      });
    },
    async handleUserText(text) {
      if (!dcRef.current || !connectedRef.current) return;
      const t = String(text || "").trim();
      if (!t) return;
      dcSend({
        type: "conversation.item.create",
        conversation: { id: "consult" },
        item: {
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: t }],
        },
      });
      dcSend({ type: "response.create", conversation: { id: "consult" } });
    },
  }));

  // ---------- helper: send context ----------
  async function primeContext() {
    try {
      setStatus("prepping");
      const payload = {
        session_id: sessionId || "",
        context: String(context || "").slice(0, 24000),
      };
      await fetch(CONTEXT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      onAgentMessage?.({
        who: "system",
        msg: "Consultant context synced from current case.",
      });
    } catch (err) {
      console.error("primeContext error:", err);
      onAgentMessage?.({
        who: "system",
        msg: "Failed to sync context for consultant.",
      });
      setStatus("error");
    }
  }

  // ---------- helper: dynamic instructions ----------
  function buildInstructions(count) {
    const n = Math.max(3, Math.min(20, Number(count) || 6));
    return [
      "You are a consultant physician reviewing a single clinical case.",
      "You already have the case context (transcript + AI notes) via the `context` field.",
      `You must begin by defining an ordered question flow using the tool 'emit_question_list' exactly once, with about ${n} concise, clinically-relevant questions.`,
      "Keep questions short and focused, one topic at a time (history refinement, red flags, co-morbidities, medications, risk factors).",
      "After defining the question list, ask ONE question at a time in the chat, following that order. Wait for the clinician's answer before moving to the next question.",
      "Stop the interview early if you already have enough information.",
      "When you have finished going through the questions (or have enough data), you MUST:",
      "1) Call 'emit_assessment' exactly once with a structured markdown assessment + plan + a differential diagnosis list (each item with name + probability_percent).",
      "2) Then call 'emit_ddx' with the same differential list so that the UI can render a pie chart.",
      "Use clear markdown headings like 'Assessment' and 'Plan'.",
      "Only call 'referral_create' if the case clearly needs a referral; otherwise, do not call it.",
      "NEVER call any share_* tools, never call upload_lab_result, and never request external resources.",
    ].join(" ");
  }

  // ---------- WebRTC connect ----------
  async function connectRTC() {
    try {
      setStatus("prepping");
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // local audio
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      localStreamRef.current = stream;
      setWaveStream(stream);
      setVizSource("mic");

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
      }

      pc.ontrack = (event) => {
        event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
      };

      pc.onicecandidate = async (event) => {
        if (event.candidate) return;
        // local description ready, send offer to backend
        const offer = pc.localDescription;
        const res = await fetch(CONNECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: offer.sdp,
        });
        const answerSdp = await res.text();
        await pc.setRemoteDescription({
          type: "answer",
          sdp: answerSdp,
        });
      };

      // datachannel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        connectedRef.current = true;
        setStatus("connected");
        setMicActive(true);
        // model instructions + tools
        dcSend({
          type: "session.update",
          session: {
            instructions: buildInstructions(questionCount),
            tools: [
              { name: "emit_question_list", type: "function" }, // NEW
              { name: "emit_assessment", type: "function" },
              { name: "emit_ddx", type: "function" },
              { name: "consult_set_question_count", type: "function" },
              { name: "referral_create", type: "function" },
            ],
          },
          conversation: { id: "consult" },
        });
        // start volume monitoring from remote audio (playback)
        if (remoteAudioRef.current) {
          startVolumeMonitoring(remoteAudioRef.current, (scale) => {
            setAudioScale(scale);
          });
        }
      };

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleDCMessage(msg);
        } catch (err) {
          console.error("DC message parse error:", err);
        }
      };

      dc.onerror = (err) => {
        console.error("DC error:", err);
        setStatus("error");
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error("connectRTC error:", err);
      onAgentMessage?.({
        who: "system",
        msg: "Failed to connect consultant agent.",
      });
      setStatus("error");
    }
  }

  function dcSend(payload) {
    if (!dcRef.current || !connectedRef.current) return;
    try {
      dcRef.current.send(JSON.stringify(payload));
    } catch (err) {
      console.error("dcSend error:", err);
    }
  }

  function stopAll() {
    try {
      connectedRef.current = false;
      setStatus("idle");
      setMicActive(false);
      setQuestionList([]);
      setWaveStream(null);
      setAudioScale(0);

      if (dcRef.current) {
        try {
          dcRef.current.close();
        } catch (e) {}
      }
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch (e) {}
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      pcRef.current = null;
      dcRef.current = null;
      localStreamRef.current = null;
      remoteStreamRef.current = null;
    } catch (err) {
      console.error("stopAll error:", err);
    }
  }

  // ---------- DC message handler ----------
  function handleDCMessage(msg) {
    // tool calls
    if (msg.type === "response.function_call_arguments.delta") {
      const { id, name, arguments: argsChunk } = msg;
      if (!id || !name) return;
      const buf =
        toolBuffersRef.current.get(id) || { name, argsText: "" };
      buf.argsText += argsChunk || "";
      toolBuffersRef.current.set(id, buf);
      return;
    }

    if (msg.type === "response.function_call_arguments.done") {
      const { id } = msg;
      if (!id) return;
      const buf = toolBuffersRef.current.get(id);
      if (!buf) return;
      toolBuffersRef.current.delete(id);
      try {
        const args = buf.argsText ? JSON.parse(buf.argsText) : {};
        routeTool(buf.name, args);
      } catch (err) {
        console.error("Tool JSON parse error:", err, buf.argsText);
      }
      return;
    }

    // text output (assistant messages)
    if (msg.type === "response.output_text.delta") {
      const { delta } = msg;
      if (!delta) return;
      outBufRef.current += delta;
      return;
    }

    if (msg.type === "response.output_text.done") {
      const full = outBufRef.current.trim();
      outBufRef.current = "";
      if (full) {
        onAgentMessage?.({
          who: "bot",
          msg: full,
        });
      }
      return;
    }

    // transcription events are not directly needed here – your main Chat handles user speech.
  }

  // ---------- tool router ----------
  function routeTool(name, args) {
    if (!name) return;

    if (name === "emit_question_list") {
      const raw = Array.isArray(args?.questions) ? args.questions : [];
      const items = raw
        .map((q) => String(q || "").trim())
        .filter(Boolean);
      setQuestionList(items);
      onAgentMessage?.({
        who: "system",
        msg: items.length
          ? `Consultant prepared ${items.length} structured questions for this case.`
          : "Consultant did not define a structured question list.",
      });
      return;
    }

    if (name === "emit_assessment") {
      const assessment_md = (args?.assessment_md || "").trim();
      const plan_md = (args?.plan_md || "").trim();
      const ddx = Array.isArray(args?.ddx) ? args.ddx : [];

      // clear question list once the assessment is ready
      setQuestionList([]);

      const mdParts = [];
      if (assessment_md) {
        mdParts.push("### Assessment", assessment_md);
      }
      if (plan_md) {
        mdParts.push("", "### Plan", plan_md);
      }
      const md = mdParts.join("\n");

      if (md) {
        onAgentMessage?.({
          who: "bot",
          msg: md,
        });
      }

      const payload = { assessment_md, plan_md, ddx };
      onDone?.(payload);
      return;
    }

    if (name === "emit_ddx") {
      const ddx = Array.isArray(args?.ddx) ? args.ddx : [];
      if (ddx.length && onDone) {
        onDone({ ddx });
      }
      return;
    }

    if (name === "consult_set_question_count") {
      const n = Number(args?.count || 6);
      const nn = Math.max(1, Math.min(20, n));
      setQuestionCount(nn);
      onAgentMessage?.({
        who: "system",
        msg: `Consultant adjusted to ~${nn} questions.`,
      });
      return;
    }

    if (name === "referral_create") {
      const specialty = (args?.specialty || "").trim();
      const urgency = (args?.urgency || "").trim();
      const reason = (args?.reason || "").trim();
      const lines = [
        "**Referral suggestion**",
        specialty ? `- Specialty: ${specialty}` : null,
        urgency ? `- Urgency: ${urgency}` : null,
        reason ? `- Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      if (lines) {
        onAgentMessage?.({ who: "bot", msg: lines });
      }
      return;
    }
  }

  // ---------- lifecycle ----------
  useEffect(() => {
    if (!active) return;
    // auto-start when overlay opens
    (async () => {
      try {
        await primeContext();
        await connectRTC();
        dcSend({ type: "response.create", conversation: { id: "consult" } });
      } catch (err) {
        console.error("Consultant auto-start error:", err);
      }
    })();

    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- render ----------
  return (
    <>
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          style={{ display: "none" }}
        />

        {/* ORB */}
        <div className="ha-orb">
          <div className="ha-orb-ring" aria-hidden="true" />
          <Orb boost={5.5} className="ha-orb-canvas" />
        </div>

        {/* Top controls */}
        <div className="va-controls">
          <button
            className="va-btn is-ghost"
            onClick={primeContext}
            title="Resend context"
          >
            <FaPaperPlane />
            &nbsp;Sync Context
          </button>

          <div
            className="va-mini"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <label style={{ fontSize: 12, opacity: 0.8 }}>Q:</label>
            <select
              value={questionCount}
              onChange={(e) => {
                const v = Number(e.target.value || 6);
                setQuestionCount(v);
                dcSend({
                  type: "session.update",
                  session: { instructions: buildInstructions(v) },
                });
                onAgentMessage?.({
                  who: "system",
                  msg: `Consultant will ask ~${v} questions.`,
                });
              }}
              style={{ fontSize: 12, padding: "2px 6px", borderRadius: 8 }}
              aria-label="Question count"
            >
              {[4, 5, 6, 7, 8, 9, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <button
            className="va-btn is-danger"
            onClick={stopAll}
            title="End session & reset"
          >
            <FaBroom />
            &nbsp;End Session
          </button>
          <button className="close-btn" onClick={onClose} title="Close">
            <FaTimes />
          </button>
        </div>

        {/* Main content row: left = questions, right = header + wave */}
        <div
          className="assistant-content"
          style={{ overflow: "hidden", display: "flex", gap: 12 }}
        >
          {/* Left: Question list column */}
          <div
            className="consult-questions-column"
            style={{
              width: 240,
              maxWidth: 260,
              minWidth: 180,
              borderRadius: 12,
              border: "1px solid var(--card-border)",
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              background:
                "var(--card-bg, rgba(15, 23, 42, 0.92))",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                opacity: 0.85,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Consultant questions</span>
              <span
                style={{
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 11,
                  opacity: 0.8,
                }}
              >
                {questionList.length ? questionList.length : "0"}
              </span>
            </div>

            <div
              style={{
                marginTop: 4,
                maxHeight: 190,
                overflowY: "auto",
                paddingRight: 2,
              }}
            >
              {questionList.length ? (
                questionList.map((q, idx) => (
                  <div
                    key={idx}
                    style={{
                      marginBottom: 4,
                      padding: "4px 6px",
                      borderRadius: 8,
                      border:
                        "1px solid var(--card-border-soft, rgba(148, 163, 184, 0.4))",
                      background:
                        "linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(15, 23, 42, 0.7))",
                      fontSize: 12,
                      lineHeight: 1.25,
                      display: "flex",
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        opacity: 0.7,
                        marginRight: 2,
                        minWidth: 16,
                        textAlign: "right",
                      }}
                    >
                      {idx + 1}.
                    </span>
                    <span>{q}</span>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.6,
                    fontStyle: "italic",
                  }}
                >
                  The consultant will prepare a short question flow once the
                  case context is loaded.
                </div>
              )}
            </div>
          </div>

          {/* Right: status + audio wave */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="va-header" style={{ marginBottom: 12 }}>
              <div className="va-title">
                <FaUserMd style={{ marginRight: 8 }} /> Consultant Agent
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

            <div
              style={{
                border: "1px solid var(--card-border)",
                borderRadius: 12,
                padding: 8,
              }}
            >
              <AudioWave stream={waveStream} />
            </div>
          </div>
        </div>

        {/* Mic FAB */}
        <button
          className={`mic-btn ${micActive ? "mic-active" : ""}`}
          onClick={() => {
            if (!localStreamRef.current) return;
            const enabled = !micActive;
            localStreamRef.current
              .getAudioTracks()
              .forEach((t) => (t.enabled = enabled));
            setMicActive(enabled);
          }}
          title={micActive ? "Mute mic" : "Unmute mic"}
          aria-label="Toggle microphone"
        >
          <FaMicrophoneAlt />
        </button>
      </div>
    </>
  );
});

export default ConsultantAgent;



