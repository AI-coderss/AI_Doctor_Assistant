/* eslint-disable no-use-before-define */
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaTimes, FaPaperPlane, FaMagic, FaFilePdf } from "react-icons/fa";
import "../styles/share-widget.css";

/**
 * Draggable Share Widget (portal, glass, compact height)
 * - Dictation is handled by OpenAI Realtime via LabVoiceAgent (no Web Speech API here).
 *
 * Props:
 *  - open: boolean
 *  - onClose: fn()
 *  - backendBase: string
 *  - sessionId: string
 *  - patient: { id?: string, name?: string }
 *  - pdfBlob: Blob
 *  - fileName: string
 *  - subjectDefault?: string
 *  - bodyDefault?: string
 *  - noteMarkdown?: string
 */
export default function ShareWidget({
  open,
  onClose,
  backendBase = "",
  sessionId = "",
  patient = {},
  pdfBlob,
  fileName = "clinical-note.pdf",
  subjectDefault = "",
  bodyDefault = "",
  noteMarkdown = "",
}) {
  const viewportRef = useRef(null);
  const widgetRef = useRef(null);

  // position (absolute inside .sw-viewport)
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef({ active: false, dx: 0, dy: 0, w: 560, h: 420 });

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(subjectDefault);
  const [body, setBody] = useState(bodyDefault);
  const [genBusy, setGenBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentOk, setSentOk] = useState(false);

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  // init placement when opened
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const el = widgetRef.current;
      const r = el ? el.getBoundingClientRect() : { width: 560, height: 420 };
      const x = Math.max(18, vw - r.width - 18);
      const y = Math.max(18, vh - r.height - 18);
      setPos({ x, y });
    };
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
  }, [open]);

  // keep in-bounds on resize
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const el = widgetRef.current;
      const r = el ? el.getBoundingClientRect() : { width: 560, height: 420 };
      setPos(p => ({
        x: clamp(p.x, 8, Math.max(8, vw - r.width - 8)),
        y: clamp(p.y, 8, Math.max(8, vh - r.height - 8)),
      }));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [open]);

  // dragging
  const onDragStart = (clientX, clientY) => {
    drag.current.active = true;
    const el = widgetRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      drag.current.w = r.width;
      drag.current.h = r.height;
    }
    drag.current.dx = clientX - pos.x;
    drag.current.dy = clientY - pos.y;
    document.body.classList.add("sw-noselect");
  };
  const onDragMove = (clientX, clientY) => {
    if (!drag.current.active) return;
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    const w = drag.current.w || 560;
    const h = drag.current.h || 420;
    setPos({
      x: clamp(clientX - drag.current.dx, m, Math.max(m, vw - w - m)),
      y: clamp(clientY - drag.current.dy, m, Math.max(m, vh - h - m)),
    });
  };
  const onDragEnd = () => { drag.current.active = false; document.body.classList.remove("sw-noselect"); };

  useEffect(() => {
    const up = () => onDragEnd();
    const mv = (e) => onDragMove(e.clientX, e.clientY);
    const tmv = (e) => { const t = e.touches?.[0]; if (t) onDragMove(t.clientX, t.clientY); };
    window.addEventListener("mouseup", up);
    window.addEventListener("mousemove", mv);
    window.addEventListener("touchend", up);
    window.addEventListener("touchmove", tmv, { passive: false });
    return () => {
      window.removeEventListener("mouseup", up);
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchmove", tmv);
    };
  }, []);

  // AI draft (extended / detailed)
  useEffect(() => {
    if (!open) return;
    if (subjectDefault || bodyDefault) return;
    let ignore = false;
    (async () => {
      try {
        setGenBusy(true);
        const payload = {
          session_id: sessionId,
          detail_level: "extended", // backend uses this for summary + rationale
          patient: { id: patient?.id || "", name: patient?.name || "" },
          note_markdown: noteMarkdown || "",
        };
        const r = await fetch(`${backendBase}/api/share/generate-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error("Draft failed");
        const j = await r.json();
        if (!ignore) {
          setSubject(j?.subject || `Clinical note for ${patient?.name || "patient"}`);
          setBody(j?.body || "");
        }
      } catch (e) {
        if (!ignore) setError("Could not auto-draft message. You can edit it manually.");
      } finally {
        if (!ignore) setGenBusy(false);
      }
    })();
    return () => { ignore = true; };
  }, [open, backendBase, sessionId, patient?.id, patient?.name, noteMarkdown, subjectDefault, bodyDefault]);

  const regenerate = async () => {
    setError("");
    try {
      setGenBusy(true);
      const payload = {
        session_id: sessionId,
        detail_level: "extended",
        patient: { id: patient?.id || "", name: patient?.name || "" },
        note_markdown: noteMarkdown || "",
      };
      const r = await fetch(`${backendBase}/api/share/generate-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("Draft failed");
      const j = await r.json();
      setSubject(j?.subject || subject);
      setBody(j?.body || body);
    } catch {
      setError("AI draft failed. Please edit the message manually.");
    } finally {
      setGenBusy(false);
    }
  };

  // ---- Voice-agent-driven field updates (share:* events) ----
  useEffect(() => {
    if (!open) return;

    const applyAppend = (prev, val) => {
      if (!prev) return val;
      const trimmedPrev = prev.endsWith(" ") ? prev : prev + " ";
      return trimmedPrev + val;
    };

    const onShareOpen = (e) => {
      const d = e.detail || {};
      if (d.to) setTo(d.to);
      if (d.subject) setSubject(d.subject);
      if (d.body) setBody(d.body);
    };

    const onShareFill = (e) => {
      const d = e.detail || {};
      const field = (d.field || "").toLowerCase();
      const value = (d.value || "").trim();
      const mode = (d.mode || "replace").toLowerCase();
      if (!field || !value) return;

      const isAppend = mode === "append";

      if (field === "to") {
        setTo(prev => isAppend ? applyAppend(prev, value) : value);
      } else if (field === "subject") {
        setSubject(prev => isAppend ? applyAppend(prev, value) : value);
      } else if (field === "body") {
        setBody(prev => isAppend ? applyAppend(prev, value) : value);
      }
    };

    const onShareSend = () => {
      // fire send as if user clicked the button
      send();
    };

    window.addEventListener("share:open", onShareOpen);
    window.addEventListener("share:fill", onShareFill);
    window.addEventListener("share:send", onShareSend);

    return () => {
      window.removeEventListener("share:open", onShareOpen);
      window.removeEventListener("share:fill", onShareFill);
      window.removeEventListener("share:send", onShareSend);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, send]);

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("File read failed"));
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(blob);
    });

  const send = async () => {
    setError(""); setSentOk(false);
    if (!to || !subject || !body) {
      setError("Please fill To, Subject, and Message.");
      return;
    }
    try {
      setSendBusy(true);
      let attachment = null;
      if (pdfBlob) {
        attachment = {
          filename: fileName,
          mime_type: "application/pdf",
          content_base64: await blobToBase64(pdfBlob),
        };
      }
      const payload = {
        session_id: sessionId,
        to, subject, body,
        patient: { id: patient?.id || "", name: patient?.name || "" },
        attachment,
      };
      const r = await fetch(`${backendBase}/api/share/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.text()) || "Send failed");
      setSentOk(true);
      setTimeout(() => onClose?.(), 1100);
    } catch (e) {
      setError(e?.message || "Failed to send message.");
    } finally {
      setSendBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div ref={viewportRef} className="sw-viewport" aria-hidden={!open}>
      <div
        ref={widgetRef}
        className="sw-widget"
        style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        role="dialog"
        aria-label="Share clinical note"
      >
        {/* Title bar = drag handle */}
        <div
          className="sw-titlebar"
          onMouseDown={(e) => {
            if (e.target.closest(".sw-actions")) return;
            onDragStart(e.clientX, e.clientY);
          }}
          onTouchStart={(e) => {
            if (e.target.closest(".sw-actions")) return;
            const t = e.touches?.[0];
            if (t) onDragStart(t.clientX, t.clientY);
          }}
        >
          <div className="sw-title">
            Share Note {patient?.name ? `• ${patient.name}` : ""}
          </div>
          <div className="sw-actions">
            {/* No local mic / Web Speech here: dictation is via LabVoiceAgent realtime. */}
            <button className="sw-icon-btn" onClick={onClose} aria-label="Close">
              <FaTimes />
            </button>
          </div>
        </div>

        <div className="sw-body">
          {error ? <div className="sw-error">{error}</div> : null}
          {sentOk ? <div className="sw-success">Message sent successfully.</div> : null}

          {/* Attachment */}
          <div className="sw-attach">
            <div className="sw-attach-icon"><FaFilePdf /></div>
            <div className="sw-attach-meta">
              <div className="sw-attach-name">{fileName}</div>
              <div className="sw-attach-sub">
                {pdfBlob ? `${(pdfBlob.size / 1024 / 1024).toFixed(2)} MB` : "No file"}
              </div>
            </div>
          </div>

          {/* To */}
          <div className="sw-field">
            <label>To</label>
            <input
              className="sw-input"
              placeholder="secretary@clinic.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <div className="sw-hint">Type an email or let the Lab Voice Agent fill it by voice.</div>
          </div>

          {/* Subject + AI */}
          <div className="sw-row">
            <div className="sw-field" style={{ flex: 1 }}>
              <label>Subject</label>
              <input
                className="sw-input"
                placeholder={`Clinical note for ${patient?.name || "patient"}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={`sw-mini ${genBusy ? "is-busy" : ""}`}
              onClick={regenerate}
              disabled={genBusy}
              title="Draft with AI"
            >
              {genBusy ? <><span className="sw-spinner" />Drafting…</> : <><FaMagic style={{ marginRight: 6 }} />AI Draft</>}
            </button>
          </div>

          {/* Body (shorter to keep widget compact) */}
          <div className="sw-field">
            <label>Message</label>
            <textarea
              className="sw-textarea"
              rows={6}
              placeholder="Dear Clinic Secretary, ..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="sw-footer">
            <button className="sw-btn ghost" onClick={onClose}>Cancel</button>
            <button className={`sw-btn primary ${sendBusy ? "is-busy" : ""}`} onClick={send} disabled={sendBusy}>
              {sendBusy ? <><span className="sw-spinner" />Sending…</> : <><FaPaperPlane style={{ marginRight: 6 }} />Send</>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
