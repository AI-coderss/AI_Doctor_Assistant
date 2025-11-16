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

import React, {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import { createPortal } from "react-dom";
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

/**
 * Helper: check that a value is truly a MediaStream before sending it
 * to audioLevelAnalyzer → avoids "parameter 1 is not of type 'MediaStream'" errors.
 */
function isRealMediaStream(stream) {
  if (!stream) return false;
  if (typeof window === "undefined") return false;
  if (!("MediaStream" in window)) return false;
  return stream instanceof window.MediaStream;
}

/**
 * Build instructions string for the consultant agent.
 * Q-count is used to tell the model how many focused questions to ask.
 */
function buildInstructions(questionCount = 6) {
  const Q = Math.max(1, Math.min(20, Number(questionCount) || 6));

  return [
    "You are a senior consultant physician working with a clinician.",
    "You receive a full transcript + context of the case and must:",
    "",
    "1) Carefully review the transcript and context.",
    `2) Generate a structured list of about ${Q} high-value follow-up questions that will clarify the diagnosis, rule-out dangerous conditions, and refine the differential.`,
    "3) Immediately call the tool `emit_question_list` with the full ordered list of questions BEFORE you start asking them in conversation.",
    "4) Then, in natural conversation, ask the clinician one question at a time in the SAME order as the list.",
    "   • Wait for the answer to each question before moving to the next.",
    "   • Keep questions short, clear, and clinically meaningful.",
    "5) After all questions have been answered, synthesize a concise consultant assessment by calling `emit_assessment` with:",
    "   • assessment_md: short narrative assessment in Markdown.",
    "   • plan_md: key recommendations / plan in Markdown.",
    "   • ddx: a structured list of differential diagnoses with probabilities or qualitative likelihoods.",
    "6) Optionally call `emit_ddx` if you want to send a focused differential separately.",
    "7) Use `consult_set_question_count` ONLY if the clinician explicitly requests more/fewer questions.",
    "8) Use `referral_create` when a referral is clearly indicated.",
    "9) Use the share_* tools ONLY to help draft/share information when explicitly asked.",
  ].join(" ");
}

/**
 * ConsultantAgent – mirrors LabVoiceAgent layout:
 * - Right fixed voice panel with orb + AudioWave
 * - Left fixed dock for pending consultant questions (like lab pending list)
 */
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

  // ---------- State ----------
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [questionCount, setQuestionCount] = useState(6);
  const [vizSource, setVizSource] = useState("mic"); // 'mic' | 'agent'

  // Left-hand questions column (like pending lab list)
  const [questionList, setQuestionList] = useState([]); // [{ id, text }]

  // Tool call buffering for streaming function calls
  const toolBuffersRef = useRef(new Map());

  // For avoiding duplicate connect
  const connectedRef = useRef(false);

  // Audio visualizer store
  const { setAudioScale } = useAudioForVisualizerStore.getState();
  // You may or may not actually use this; kept for compatibility
  const { setAudioUrl } = useAudioStore();

  // ---------- Imperative handle ----------
  useImperativeHandle(ref, () => ({
    async start() {
      if (connectedRef.current) return;
      await primeContext();
      await connectRTC();
      // The agent will auto-start via response.create
      dcSend({ type: "response.create" });
    },
    async stop() {
      stopAll();
    },
    setQuestionCount(n) {
      const nn = Math.max(1, Math.min(20, Number(n) || 6));
      setQuestionCount(nn);
      dcSend({
        type: "session.update",
        session: { instructions: buildInstructions(nn) },
      });
      onAgentMessage?.({
        who: "system",
        msg: `Consultant will aim for ~${nn} questions.`,
      });
    },
  }));

  // ---------- React to `active` flag ----------
  useEffect(() => {
    if (active) {
      (async () => {
        try {
          await primeContext();
          await connectRTC();
          dcSend({ type: "response.create" });
        } catch (err) {
          console.error("ConsultantAgent connect failed:", err);
          setStatus("error");
        }
      })();
    } else {
      stopAll();
    }

    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---------- Prime context (transcript + extra context) ----------
  async function primeContext() {
    try {
      const payload = {
        session_id: sessionId,
        context: context || "",
      };
      await fetch(CONTEXT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      onAgentMessage?.({
        who: "system",
        msg: "Consultant received updated case context.",
      });
    } catch (err) {
      console.error("Failed to send consultant context:", err);
    }
  }

  // ---------- DataChannel send helper ----------
  function dcSend(obj) {
    try {
      const ch = dcRef.current;
      if (!ch || ch.readyState !== "open") return;
      ch.send(JSON.stringify(obj));
    } catch (err) {
      console.warn("Consultant DC send failed:", err);
    }
  }

  // ---------- Tools schema + session.update ----------
  function sendSessionUpdate() {
    const TOOLS = [
      {
        name: "emit_question_list",
        description:
          "Emit the full ordered list of consultant questions to populate the left-hand question column.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  text: { type: "string" },
                },
                required: ["text"],
              },
            },
          },
          required: ["questions"],
        },
      },
      {
        name: "emit_assessment",
        description:
          "Emit the final consultant assessment + plan + differential diagnosis once all questions are answered.",
        parameters: {
          type: "object",
          properties: {
            assessment_md: { type: "string" },
            plan_md: { type: "string" },
            ddx: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  probability: { type: "number" },
                  note: { type: "string" },
                },
              },
            },
          },
          required: ["assessment_md"],
        },
      },
      {
        name: "emit_ddx",
        description:
          "Emit a structured differential diagnosis focus block (DDx list) with likelihoods.",
        parameters: {
          type: "object",
          properties: {
            ddx: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  probability: { type: "number" },
                  note: { type: "string" },
                },
              },
            },
          },
          required: ["ddx"],
        },
      },
      {
        name: "consult_set_question_count",
        description:
          "Adjust how many follow-up questions you will ask overall.",
        parameters: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["count"],
        },
      },
      {
        name: "referral_create",
        description:
          "Create a referral recommendation with specialty, reason, and mode (urgent vs routine).",
        parameters: {
          type: "object",
          properties: {
            specialty: { type: "string" },
            reason: { type: "string" },
            mode: {
              type: "string",
              enum: ["urgent", "routine", "elective"],
            },
          },
          required: ["specialty", "reason"],
        },
      },
      {
        name: "share_open_widget",
        description:
          "Open the share widget so the clinician can review the email draft.",
        parameters: {
          type: "object",
          properties: {
            recipient_hint: { type: "string" },
          },
        },
      },
      {
        name: "share_update_field",
        description: "Update one field of the share widget: to, subject, body.",
        parameters: {
          type: "object",
          properties: {
            field: {
              type: "string",
              enum: ["to", "subject", "body"],
            },
            value: { type: "string" },
            append: { type: "boolean" },
          },
          required: ["field", "value"],
        },
      },
      {
        name: "share_send",
        description:
          "Trigger sending the email in the share widget after explicit clinician confirmation.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ];

    dcSend({
      type: "session.update",
      session: {
        voice: "alloy",
        turn_detection: { type: "server_vad", threshold: 0.5 },
        instructions: buildInstructions(questionCount),
        tools: TOOLS,
        tool_choice: { type: "auto" },
      },
    });
  }

  // ---------- Tool dispatcher ----------
  function routeTool(name, args) {
    if (!name) return;
    const a = args || {};

    // 1) New: question list → left column
    if (name === "emit_question_list") {
      const raw = Array.isArray(a.questions) ? a.questions : [];
      const normalized = raw
        .map((q, idx) => {
          if (typeof q === "string") {
            return { id: `q-${idx + 1}`, text: q };
          }
          const txt = (q.text || q.question || "").trim();
          if (!txt) return null;
          return { id: q.id || `q-${idx + 1}`, text: txt };
        })
        .filter(Boolean);

      setQuestionList(normalized);
      onAgentMessage?.({
        who: "system",
        msg: `Consultant prepared ${normalized.length} follow-up questions.`,
      });
      return;
    }

    // 2) Final assessment
    if (name === "emit_assessment") {
      const payload = {
        assessment_md: (a.assessment_md || "").trim(),
        plan_md: (a.plan_md || "").trim(),
        ddx: Array.isArray(a.ddx) ? a.ddx : [],
      };

      // Notify in chat stream
      onAgentMessage?.({
        who: "bot",
        msg: "**Consultant assessment is ready.** See the summary bubble below.",
        ddx: payload.ddx,
        type: "consultant-assessment",
      });

      // Clear questions once assessment is produced
      setQuestionList([]);

      // Hand back full CAS + DDX to Chat.jsx
      onDone?.(payload);
      return;
    }

    // 3) DDX-only emit
    if (name === "emit_ddx") {
      const ddx = Array.isArray(a.ddx) ? a.ddx : [];
      const lines = ddx.map((d, i) => {
        const label = d.label || d.diagnosis || `Diagnosis ${i + 1}`;
        const prob =
          typeof d.probability === "number"
            ? ` (${Math.round(d.probability * 100)}%)`
            : "";
        const note = d.note ? ` — ${d.note}` : "";
        return `- ${label}${prob}${note}`;
      });

      const md = [
        "### Differential Diagnosis",
        "",
        ...lines,
      ].join("\n");

      onAgentMessage?.({
        who: "bot",
        msg: md,
        ddx,
        type: "consultant-ddx",
      });
      return;
    }

    // 4) Question count adjustment
    if (name === "consult_set_question_count") {
      const nn = Math.max(1, Math.min(20, Number(a.count) || 6));
      setQuestionCount(nn);
      dcSend({
        type: "session.update",
        session: { instructions: buildInstructions(nn) },
      });
      onAgentMessage?.({
        who: "system",
        msg: `Consultant question budget set to ~${nn}.`,
      });
      return;
    }

    // 5) Referral
    if (name === "referral_create") {
      const specialty = (a.specialty || "").trim() || "Consultation";
      const reason = (a.reason || "").trim();
      const mode = (a.mode || "").trim();
      const modeLabel = mode ? ` (${mode})` : "";
      const msg = `Referral created: **${specialty}**${modeLabel}${
        reason ? ` — ${reason}` : ""
      }.`;

      onAgentMessage?.({ who: "bot", msg, type: "referral" });
      return;
    }

    // 6) Share widget tools via window events
    if (name === "share_open_widget") {
      const recipient_hint = (a.recipient_hint || "").trim();
      window.dispatchEvent(
        new CustomEvent("sw:open", {
          detail: { recipient_hint: recipient_hint || undefined },
        })
      );
      return;
    }

    if (name === "share_update_field") {
      const field = (a.field || "").trim().toLowerCase();
      const value = (a.value || "").trim();
      const append = !!a.append;
      if (!field || !value) return;
      if (!["to", "subject", "body"].includes(field)) return;

      window.dispatchEvent(
        new CustomEvent("sw:update", {
          detail: { field, value, append },
        })
      );
      return;
    }

    if (name === "share_send") {
      window.dispatchEvent(new CustomEvent("sw:send", { detail: {} }));
      onAgentMessage?.({
        who: "system",
        msg: "Share widget requested to send the email.",
      });
      return;
    }

    // Fallback
    console.log("Consultant tool (unhandled):", name, a);
  }

  // ---------- DataChannel wiring ----------
  function wireDataChannel(ch) {
    dcRef.current = ch;

    ch.onopen = () => {
      connectedRef.current = true;
      setStatus("connected");
      setMicActive(true);
      sendSessionUpdate();
    };

    ch.onclose = () => {
      connectedRef.current = false;
      setStatus("idle");
      setMicActive(false);
    };

    ch.onerror = (e) => {
      console.error("Consultant DC error:", e);
      setStatus("error");
    };

    ch.onmessage = (ev) => {
      const raw = String(ev.data || "");
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // --- Tool call streaming (OpenAI Realtime) ---
      if (
        msg?.type === "response.output_item.added" &&
        msg?.item?.type === "function_call"
      ) {
        const id = msg.item.call_id || msg.item.id || "default";
        const prev = toolBuffersRef.current.get(id) || {
          name: "",
          argsText: "",
        };
        prev.name = msg.item.name || prev.name;
        toolBuffersRef.current.set(id, prev);
        return;
      }

      if (
        msg?.type === "response.function_call_arguments.delta" ||
        msg?.type === "tool_call.delta"
      ) {
        const id = msg.call_id || msg.id || "default";
        const delta = msg.delta || msg.arguments_delta || "";
        const prev = toolBuffersRef.current.get(id) || {
          name: "",
          argsText: "",
        };
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
        try {
          args = JSON.parse(buf.argsText || "{}");
        } catch {
          args = {};
        }
        const name = buf.name || "";
        routeTool(name, args);
        return;
      }

      // You can add additional handling for plain assistant text here if needed
    };
  }

  // ---------- WebRTC connection ----------
  async function connectRTC() {
    try {
      setStatus("prepping");

      // Local mic stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      // 🔐 Guarded MediaStream monitoring → fixes the error you saw
      if (isRealMediaStream(stream)) {
        try {
          startVolumeMonitoring(stream, setAudioScale);
        } catch (err) {
          console.warn("startVolumeMonitoring (local) failed:", err);
        }
      }

      // Peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // DataChannel for OpenAI events
      const dc = pc.createDataChannel("oai-events");
      wireDataChannel(dc);

      // Send mic tracks
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

          el.play?.().catch(() => {});
        }

        // 🔐 Guarded remote monitoring
        if (isRealMediaStream(remoteStream)) {
          try {
            startVolumeMonitoring(remoteStream, setAudioScale);
          } catch (err) {
            console.warn("startVolumeMonitoring (remote) failed:", err);
          }
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
          setMicActive(true);
        } else if (
          ["failed", "disconnected", "closed"].includes(pc.connectionState)
        ) {
          setStatus("error");
          setMicActive(false);
          setVizSource("mic");
        }
      };

      // Offer/answer exchange with backend
      let offer = await pc.createOffer({ offerToReceiveAudio: true });
      offer.sdp = offer.sdp.replace(
        /a=rtpmap:\d+ opus\/48000\/2/g,
        "a=rtpmap:111 opus/48000/2\r\n" +
          "a=fmtp:111 minptime=10;useinbandfec=1"
      );
      await pc.setLocalDescription(offer);

      const res = await fetch(CONNECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`/consultant-agent/rtc-connect ${res.status}`);

      const answerSdp = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      console.error("ConsultantAgent connectRTC error:", err);
      setStatus("error");
    }
  }

  // ---------- Stop / cleanup ----------
  function stopAll() {
    try {
      if (pcRef.current) {
        pcRef.current.getSenders?.().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    try {
      localStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    try {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.pause?.();
        remoteAudioRef.current.src = "";
      }
    } catch {}
    remoteStreamRef.current = null;

    connectedRef.current = false;
    setStatus("idle");
    setMicActive(false);
    setVizSource("mic");
    setQuestionList([]);
  }

  // ---------- Visualizer stream selection ----------
  const waveStream =
    vizSource === "agent" && remoteStreamRef.current
      ? remoteStreamRef.current
      : localStreamRef.current || null;

  if (!active) return null;

  return (
    <>
      {/* ==== Right fixed voice panel (same as LabVoiceAgent) ==== */}
      <div className="voice-assistant" style={{ zIndex: 1000 }}>
        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          style={{ display: "none" }}
        />

        {/* Orb */}
        <div className="ha-orb">
          <div className="ha-orb-ring" aria-hidden="true" />
          <Orb boost={5.5} className="ha-orb-canvas" />
        </div>

        {/* Top-right controls + Q-selector */}
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
                const nn = Math.max(1, Math.min(20, v));
                setQuestionCount(nn);
                dcSend({
                  type: "session.update",
                  session: { instructions: buildInstructions(nn) },
                });
                onAgentMessage?.({
                  who: "system",
                  msg: `Consultant will aim for ~${nn} questions.`,
                });
              }}
              style={{ fontSize: 12, padding: "2px 6px", borderRadius: 8 }}
            >
              {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
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

          <button
            className="close-btn"
            onClick={() => {
              stopAll();
              onClose?.();
            }}
            title="Close"
          >
            <FaTimes />
          </button>
        </div>

        {/* Main content */}
        <div className="assistant-content" style={{ overflow: "hidden" }}>
          <div className="va-header" style={{ marginBottom: 12 }}>
            <div className="va-title">
              <FaUserMd style={{ marginRight: 8 }} />
              Consultant Agent
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
            className="va-section va-visualizer"
            style={{
              border: "1px solid var(--card-border)",
              borderRadius: 12,
              padding: 8,
            }}
          >
            <AudioWave stream={waveStream} />
          </div>
        </div>

        {/* Mic FAB (unchanged) */}
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

      {/* ==== Left fixed question dock (same layout as pending lab list) ==== */}
      {questionList.length > 0 &&
        createPortal(
          <div
            className="pending-dock pending-dock--left consultant-questions-dock"
            aria-live="polite"
          >
            <div className="dock-title">Consultant Questions</div>
            <div className="pending-list">
              {questionList.map((q, idx) => (
                <div key={q.id || idx} className="pending-item">
                  <div className="sug-title">
                    {`Q${idx + 1}. ${q.text}`}
                  </div>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
});

export default ConsultantAgent;


