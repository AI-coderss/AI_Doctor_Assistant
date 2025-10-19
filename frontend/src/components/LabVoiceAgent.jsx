/* eslint-disable no-useless-concat */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import "../styles/lab-voice-agent.css";
import BaseOrb from "./BaseOrb.jsx";
import { FaMicrophoneAlt, FaCheck, FaFlask, FaTimes } from "react-icons/fa";

/**
 * LabVoiceAgent
 * Props:
 *  - isVisible: boolean
 *  - onClose: () => void
 *  - sessionId: string
 *  - backendBase: string (e.g. https://...onrender.com)
 *  - context: string  (combined transcript + narrative + prior approved labs)
 *  - onApproveLab: (item: {name, why?, priority?}) => void
 *
 * Backend (updated below):
 *  POST /lab-agent/context                 JSON: { session_id, context }
 *  POST /lab-agent/suggest-stream          JSON: { session_id }  -> line/ndjson or "data: ..." streaming
 *  POST /lab-agent/approve                 JSON: { session_id, item }
 *  GET  /lab-agent/list?session_id=...
 *
 *  NEW no-preflight SDP exchange:
 *  POST /lab-agent/rtc-connect             Content-Type: application/x-www-form-urlencoded
 *      body: session_id=<id>&sdp=<offer_sdp>
 *      returns: answer SDP as text/plain (or application/sdp)
 */

export default function LabVoiceAgent({
  isVisible,
  onClose,
  sessionId,
  backendBase,
  context,
  onApproveLab,
}) {
  const [status, setStatus] = useState("idle"); // idle | prepping | connected | error
  const [micActive, setMicActive] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [approvedLocal, setApprovedLocal] = useState([]);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const streamAbortRef = useRef(null);
  const textBufferRef = useRef("");

  // ========== Helpers ==========
  const appendText = (s) => {
    textBufferRef.current += s;
    setStreamingText(textBufferRef.current);
  };

  const resetAll = () => {
    textBufferRef.current = "";
    setStreamingText("");
    setSuggestions([]);
    setApprovedLocal([]);
  };

  // ========== Start/Stop ==========
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
        startSuggestStream(); // run concurrently
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

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // upstream mic
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // downstream agent voice
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteAudioRef.current) return;
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current
          .play()
          .catch((err) => console.warn("Agent audio play failed:", err));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
          setMicActive(true);
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          setStatus("error");
          setMicActive(false);
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      // Tweak Opus (optional)
      const modifiedOffer = {
        ...offer,
        sdp: offer.sdp.replace(
          /a=rtpmap:\d+ opus\/48000\/2/g,
          "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
        ),
      };
      await pc.setLocalDescription(modifiedOffer);

      // === IMPORTANT: no querystring, no custom headers, simple form POST ===
      const form = new URLSearchParams();
      form.set("session_id", sessionId);
      form.set("sdp", modifiedOffer.sdp);

      const res = await fetch(`${backendBase}/lab-agent/rtc-connect`, {
        method: "POST",
        headers: {
          // simple content-type => no preflight
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: form.toString(),
      });

      if (!res.ok) throw new Error(`/lab-agent/rtc-connect ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      console.error("startVoice error:", err);
      setStatus("error");
      setMicActive(false);
      throw err;
    }
  };

  const stopAll = () => {
    try {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    } catch {}
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
        remoteAudioRef.current.pause();
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.src = "";
      }
    } catch {}
    setMicActive(false);
    setStatus("idle");
  };

  // Toggle mic (enable/disable outbound tracks). VAD still applies server-side.
  const toggleMic = () => {
    if (!localStreamRef.current) return;
    const enabled = !micActive;
    localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = enabled));
    setMicActive(enabled);
  };

  // ========== Suggestion Stream ==========
  const startSuggestStream = async () => {
    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;

    try {
      const res = await fetch(`${backendBase}/lab-agent/suggest-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/lab-agent/suggest-stream ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let jsonStr = trimmed.startsWith("data:") ? trimmed.replace(/^data:\s*/, "") : trimmed;
          try {
            const msg = JSON.parse(jsonStr);
            if (msg.type === "text" || msg.type === "delta") {
              appendText(String(msg.content || ""));
            } else if (msg.type === "suggestion") {
              const itm = normalizeLabItem(msg.item || msg);
              if (itm?.name) {
                setSuggestions((prev) => {
                  if (prev.some((p) => p.name.toLowerCase() === itm.name.toLowerCase())) return prev;
                  return [...prev, itm];
                });
              }
            }
          } catch {
            appendText(trimmed + "\n");
          }
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.error("suggest-stream error:", e);
      appendText("\n\n[stream ended]");
    }
  };

  const normalizeLabItem = (raw) => {
    if (!raw) return null;
    const name = (raw.name || raw.test || "").toString().trim();
    if (!name) return null;
    return {
      name,
      why: raw.why ? String(raw.why).trim() : "",
      priority: raw.priority ? String(raw.priority).trim() : "",
    };
  };

  // ========== Approvals ==========
  const approveOne = async (item) => {
    const norm = normalizeLabItem(item);
    if (!norm) return;
    try {
      const res = await fetch(`${backendBase}/lab-agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, item: norm }),
      });
      if (!res.ok) console.error("approve failed", res.status);
    } catch (e) {
      console.error("approve error:", e);
    }
    setApprovedLocal((p) => [...p, norm]);
    setSuggestions((p) => p.filter((s) => s.name.toLowerCase() !== norm.name.toLowerCase()));
    try {
      onApproveLab?.(norm);
    } catch {}
  };

  const approveAll = async () => {
    const toApprove = [...suggestions];
    for (const s of toApprove) {
      // eslint-disable-next-line no-await-in-loop
      await approveOne(s);
    }
  };

  if (!isVisible) return null;

  return (
    <div className="voice-assistant">
      <audio ref={remoteAudioRef} playsInline style={{ display: "none" }} />
      <div className="assistant-orb"><BaseOrb className="base-orb" /></div>
      <button className="close-btn" onClick={() => { onClose?.(); }}><FaTimes /></button>

      <div className="assistant-content">
        <div className="va-header">
          <div className="va-title"><FaFlask style={{ marginRight: 8 }} /> Lab Agent</div>
          <div className={`va-status ${status}`}>{renderStatus(status, micActive)}</div>
        </div>

        <div className="va-section">
          <div className="va-subtitle">Conversation</div>
          <div className="va-stream">
            {streamingText ? streamingText : <em>Listening… Ask for labs you need to narrow the differential.</em>}
          </div>
        </div>

        <div className="va-section">
          <div className="va-subtitle">
            Suggestions <span className="pill">{suggestions.length}</span>
            {suggestions.length > 1 && (
              <button className="approve-all-btn" onClick={approveAll} title="Approve all">
                <FaCheck style={{ marginRight: 6 }} /> Approve All
              </button>
            )}
          </div>
          {suggestions.length === 0 ? (
            <div className="empty-hint">No suggestions yet — speak to the agent or wait for VAD to capture your request.</div>
          ) : (
            <div className="lab-suggestions">
              {suggestions.map((s, idx) => (
                <div key={`${s.name}-${idx}`} className="sug-card">
                  <div className="sug-title">{s.name}</div>
                  <div className="sug-meta">
                    {s.priority && <span className="badge">{s.priority}</span>}
                    {s.why && <span className="why">— {s.why}</span>}
                  </div>
                  <div className="sug-actions">
                    <button className="approve-btn" onClick={() => approveOne(s)}>
                      <FaCheck /> Approve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {approvedLocal.length > 0 && (
          <div className="va-section">
            <div className="va-subtitle">
              Approved (this session) <span className="pill">{approvedLocal.length}</span>
            </div>
            <div className="approved-list">
              {approvedLocal.map((a, i) => (
                <span key={`${a.name}-${i}`} className="chip-approved">
                  {a.name}{a.priority ? ` • ${a.priority}` : ""}{a.why ? ` — ${a.why}` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        className={`mic-btn ${micActive ? "mic-active" : ""}`}
        onClick={toggleMic}
        title={micActive ? "Mute mic" : "Unmute mic"}
        aria-label="Toggle microphone"
      >
        <FaMicrophoneAlt />
      </button>
    </div>
  );
}

function renderStatus(status, micActive) {
  if (status === "prepping") return "Preparing • sending context…";
  if (status === "connected") return micActive ? "Connected • VAD listening" : "Connected • mic muted";
  if (status === "error") return "Error • check connection";
  return "Idle";
}


