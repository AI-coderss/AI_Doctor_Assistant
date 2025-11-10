/* eslint-disable no-use-before-define */
// src/components/ShareWidget.jsx
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-use-before-define */
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-use-before-define */
// src/components/ShareWidget.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaTimes, FaPaperPlane, FaMagic, FaFilePdf } from "react-icons/fa";
import "../styles/share-widget.css";

/**
 * Share Widget (fixed left column, glass, compact height)
 *
 * Props:
 *  - open: boolean          // initial trigger (not authoritative for persistence)
 *  - onClose: fn()
 *  - backendBase: string
 *  - sessionId: string
 *  - patient: { id?: string, name?: string }
 *  - pdfBlob: Blob
 *  - fileName: string
 *  - subjectDefault?: string
 *  - bodyDefault?: string
 *  - toDefault?: string
 *  - noteMarkdown?: string
 *  - autoSendSignal?: number (increments when voice agent wants to send)
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
  toDefault = "",
  noteMarkdown = "",
  autoSendSignal = 0,
}) {
  const viewportRef = useRef(null);
  const widgetRef = useRef(null);
  const bodyTextAreaRef = useRef(null); // auto-resize target

  // ---- Persistent visibility (per session) ----
  const [isVisible, setIsVisible] = useState(() => {
    try {
      if (typeof window === "undefined") return !!open;
      const saved = window.sessionStorage.getItem("shareWidget:isVisible");
      if (saved === "1") return true;
      if (saved === "0") return false;
      return !!open;
    } catch {
      return !!open;
    }
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      window.sessionStorage.setItem("shareWidget:isVisible", isVisible ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [isVisible]);

  // If parent toggles `open` to true, ensure widget becomes visible.
  // We deliberately do NOT auto-hide when `open` becomes false.
  useEffect(() => {
    if (open) setIsVisible(true);
  }, [open]);

  const [to, setTo] = useState(toDefault || "");
  const [subject, setSubject] = useState(subjectDefault || "");
  const [body, setBody] = useState(bodyDefault || "");
  const [genBusy, setGenBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentOk, setSentOk] = useState(false);

  // Sync defaults when widget (re)opens or defaults change
  useEffect(() => {
    if (!isVisible) return;
    setTo(toDefault || "");
  }, [toDefault, isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    setSubject(subjectDefault || "");
  }, [subjectDefault, isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    setBody(bodyDefault || "");
  }, [bodyDefault, isVisible]);

  // Auto-resize textarea whenever body changes
  useEffect(() => {
    if (!isVisible) return;
    const el = bodyTextAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [body, isVisible]);

  // Optional: auto-draft when opened and subject/body empty
  useEffect(() => {
    if (!isVisible) return;
    if (subjectDefault || bodyDefault) return;
    let ignore = false;
    (async () => {
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
        if (!ignore) {
          setSubject(
            j?.subject ||
              `Clinical note for ${patient?.name || "patient"}${
                patient?.id ? ` (${patient.id})` : ""
              }`
          );
          setBody(
            j?.body ||
              `Dear Clinic Secretary,\n\nPlease find attached the clinical note for ${
                patient?.name || "the patient"
              }${patient?.id ? ` (File #${patient.id})` : ""}.\n\nRegards,\n`
          );
        }
      } catch {
        if (!ignore) {
          setError("Could not auto-draft message. You can edit it manually.");
        }
      } finally {
        if (!ignore) setGenBusy(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [
    isVisible,
    backendBase,
    sessionId,
    patient?.id,
    patient?.name,
    noteMarkdown,
    subjectDefault,
    bodyDefault,
  ]);

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

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("File read failed"));
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(blob);
    });

  // Centralized close that respects persistence
  function closeWidget() {
    setIsVisible(false);
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem("shareWidget:isVisible", "0");
      }
    } catch {
      /* ignore */
    }
    onClose?.();
  }

  // HOISTED send handler
  async function handleSend() {
    setError("");
    setSentOk(false);
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
        to,
        subject,
        body,
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
      // After a short delay, close the widget via our unified closer
      setTimeout(() => {
        closeWidget();
      }, 1100);
    } catch (e) {
      setError(e?.message || "Failed to send message.");
    } finally {
      setSendBusy(false);
    }
  }

  // Optional auto-send trigger from parent (LabVoiceAgent -> ClinicalNotes -> ShareWidget)
  useEffect(() => {
    if (!isVisible) return;
    if (!autoSendSignal) return;
    if (!to || !subject || !body) return;
    handleSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSendSignal]);

  // ---- Function-calling bridge (global API + CustomEvents) ----
  useEffect(() => {
    const api = {
      /**
       * Open the widget and optionally prefill fields.
       * fields: { to?, subject?, body? }
       */
      open: (fields = {}) => {
        if (typeof fields.to === "string") setTo(fields.to);
        if (typeof fields.subject === "string") setSubject(fields.subject);
        if (typeof fields.body === "string") setBody(fields.body);
        setIsVisible(true);
      },
      /**
       * Update current fields without changing visibility.
       */
      update: (fields = {}) => {
        if (typeof fields.to === "string") setTo(fields.to);
        if (typeof fields.subject === "string") setSubject(fields.subject);
        if (typeof fields.body === "string") setBody(fields.body);
      },
      /**
       * Send the email. If fields are provided, override before sending.
       * fields: { to?, subject?, body? }
       */
      send: async (fields = {}) => {
        if (fields && typeof fields === "object") {
          if (typeof fields.to === "string") setTo(fields.to);
          if (typeof fields.subject === "string") setSubject(fields.subject);
          if (typeof fields.body === "string") setBody(fields.body);
        }
        // give React a tick if we just updated state, then send
        setTimeout(() => {
          handleSend();
        }, 0);
      },
      /**
       * Close widget (persistent).
       */
      close: () => {
        closeWidget();
      },
    };

    // Expose on window for direct function-calling from the Realtime agent
    try {
      if (typeof window !== "undefined") {
        window.shareWidgetAPI = api;
      }
    } catch {
      /* ignore */
    }

    // CustomEvent listeners (if LabVoiceAgent dispatches events)
    const onOpenEvt = (e) => api.open(e.detail || {});
    const onUpdateEvt = (e) => api.update(e.detail || {});
    const onSendEvt = (e) => api.send(e.detail || {});
    const onCloseEvt = () => api.close();

    if (typeof window !== "undefined") {
      window.addEventListener("share:widget.open", onOpenEvt);
      window.addEventListener("share:widget.update", onUpdateEvt);
      window.addEventListener("share:widget.send", onSendEvt);
      window.addEventListener("share:widget.close", onCloseEvt);
    }

    return () => {
      try {
        if (typeof window !== "undefined") {
          if (window.shareWidgetAPI === api) {
            delete window.shareWidgetAPI;
          }
          window.removeEventListener("share:widget.open", onOpenEvt);
          window.removeEventListener("share:widget.update", onUpdateEvt);
          window.removeEventListener("share:widget.send", onSendEvt);
          window.removeEventListener("share:widget.close", onCloseEvt);
        }
      } catch {
        /* ignore */
      }
    };
    // We intentionally do NOT depend on to/subject/body to avoid recreating handlers every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isVisible) return null;

  return createPortal(
    <div ref={viewportRef} className="sw-viewport" aria-hidden={!isVisible}>
      <div
        ref={widgetRef}
        className="sw-widget"
        role="dialog"
        aria-label="Share clinical note"
      >
        {/* Title bar (no drag now) */}
        <div className="sw-titlebar">
          <div className="sw-title">
            Share Note {patient?.name ? `• ${patient.name}` : ""}
          </div>
          <div className="sw-actions">
            <button
              className="sw-icon-btn"
              onClick={closeWidget}
              aria-label="Close"
            >
              <FaTimes />
            </button>
          </div>
        </div>

        <div className="sw-body">
          {error ? <div className="sw-error">{error}</div> : null}
          {sentOk ? <div className="sw-success">Message sent successfully.</div> : null}

          {/* Attachment */}
          <div className="sw-attach">
            <div className="sw-attach-icon">
              <FaFilePdf />
            </div>
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
            <div className="sw-hint">
              Type an email or let the LabVoiceAgent fill this.
            </div>
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
              {genBusy ? (
                <>
                  <span className="sw-spinner" />
                  Drafting…
                </>
              ) : (
                <>
                  <FaMagic style={{ marginRight: 6 }} />
                  AI Draft
                </>
              )}
            </button>
          </div>

          {/* Body (auto-resizing textarea) */}
          <div className="sw-field">
            <label>Message</label>
            <textarea
              ref={bodyTextAreaRef}
              className="sw-textarea"
              rows={4}
              placeholder="Dear Clinic Secretary, ..."
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                const el = bodyTextAreaRef.current;
                if (el) {
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }
              }}
            />
          </div>

          <div className="sw-footer">
            <button className="sw-btn ghost" onClick={closeWidget}>
              Cancel
            </button>
            <button
              className={`sw-btn primary ${sendBusy ? "is-busy" : ""}`}
              onClick={handleSend}
              disabled={sendBusy}
            >
              {sendBusy ? (
                <>
                  <span className="sw-spinner" />
                  Sending…
                </>
              ) : (
                <>
                  <FaPaperPlane style={{ marginRight: 6 }} />
                  Send
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

