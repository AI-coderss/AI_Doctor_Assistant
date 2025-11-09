// src/components/ShareWidget.jsx
import React, { useEffect, useRef, useState } from "react";
import { FaMicrophone, FaPaperPlane, FaWandMagicSparkles } from "react-icons/fa6";
import { pdf } from "@react-pdf/renderer";
import { FaTimes } from "react-icons/fa";

/**
 * ShareWidget
 * - Generates a PDF from the provided <NotePDF /> element
 * - Lets user dictate (record + /transcribe) and/or AI-compose via /api/share/compose
 * - Sends (placeholder) via /api/share/send
 */
export default function ShareWidget({
  open,
  onClose,
  backendBase,
  sessionId,
  transcript,
  patient = { name: "", id: "" },
  notePDFElement,        // React element <NotePDF ... />
  noteMarkdown = "",     // for AI compose context
}) {
  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdfMeta, setPdfMeta] = useState({ filename: "", base64: "", size: 0 });
  const [rec, setRec] = useState(null);
  const [recording, setRecording] = useState(false);

  // Generate PDF once opened
  useEffect(() => {
    let live = true;
    (async () => {
      if (!open || !notePDFElement) return;
      try {
        const blob = await pdf(notePDFElement).toBlob();
        if (!live) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          if (!live) return;
          const base64 = (reader.result || "").toString().split(",")[1] || "";
          const shortName = [
            "ClinicalNote",
            patient?.id ? `#${patient.id}` : null,
            patient?.name ? `-${patient.name.replace(/\s+/g,"_")}` : null,
          ].filter(Boolean).join("");
          const filename = `${shortName || "ClinicalNote"}.pdf`;
          setPdfMeta({ filename, base64, size: blob.size });
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        console.error("PDF gen error:", e);
      }
    })();
    return () => { live = false; };
  }, [open, notePDFElement, patient?.id, patient?.name]);

  const doCompose = async () => {
    if (!noteMarkdown) return;
    setBusy(true);
    try {
      const r = await fetch(`${backendBase}/api/share/compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          note_markdown: noteMarkdown,
          patient,
          to_email: toEmail,
          transcript
        })
      });
      const j = await r.json();
      if (j?.subject) setSubject(j.subject);
      if (j?.body) setMessage(j.body);
      if (j?.summary) setSummary(j.summary);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const doSend = async () => {
    if (!toEmail || !subject || !message) return;
    setBusy(true);
    try {
      const payload = {
        session_id: sessionId,
        to: toEmail,
        subject,
        body: message,
        attachment: pdfMeta.base64 ? { filename: pdfMeta.filename, content_base64: pdfMeta.base64 } : null
      };
      const r = await fetch(`${backendBase}/api/share/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      // no-op delivery; you can surface toast here
      if (j?.ok) onClose?.();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  // Dictation (records audio and posts to /transcribe)
  const chunksRef = useRef([]);
  useEffect(() => {
    if (!open) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    let mediaRecorder;
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        setRec(mediaRecorder);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data?.size > 0) chunksRef.current.push(e.data);
        };
        mediaRecorder.onstop = async () => {
          try {
            const blob = new Blob(chunksRef.current, { type: "audio/webm" });
            chunksRef.current = [];
            const fd = new FormData();
            fd.append("audio_data", new File([blob], "dictation.webm", { type: "audio/webm" }));
            const r = await fetch(`${backendBase}/transcribe`, { method: "POST", body: fd });
            const j = await r.json();
            const text = (j?.transcript || "").toString();
            if (text) setMessage((m) => (m ? m + (m.endsWith("\n") ? "" : "\n") + text : text));
          } catch (e) {
            console.error(e);
          } finally {
            setRecording(false);
          }
        };
      } catch (e) {
        console.error("Mic access error", e);
      }
    };
    init();
    return () => {
      try { mediaRecorder?.stream?.getTracks()?.forEach(t => t.stop()); } catch {}
      setRec(null);
    };
  }, [open, backendBase]);

  const toggleRecord = () => {
    if (!rec) return;
    if (recording) {
      try { rec.stop(); } catch {}
    } else {
      chunksRef.current = [];
      try { rec.start(); setRecording(true); } catch {}
    }
  };

  if (!open) return null;

  return (
    <div className="cn-share-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cn-share-card" onClick={(e)=>e.stopPropagation()}>
        <div className="cn-share-head">
          <div className="cn-modal-title">Share Clinical Note</div>
          <button className="cn-modal-close" onClick={onClose}><FaTimes /></button>
        </div>

        <div className="cn-field">
          <label>To</label>
          <input className="cn-input" type="email" placeholder="secretary@clinic.com"
                 value={toEmail} onChange={(e)=>setToEmail(e.target.value)} />
        </div>

        <div className="cn-row">
          <div className="cn-field" style={{flex: 1}}>
            <label>Patient Name</label>
            <input className="cn-input" value={patient?.name || ""} onChange={()=>{}} disabled />
          </div>
          <div className="cn-field" style={{flex: 1}}>
            <label>Patient File #</label>
            <input className="cn-input" value={patient?.id || ""} onChange={()=>{}} disabled />
          </div>
        </div>

        <div className="cn-field">
          <label>Subject</label>
          <input className="cn-input" placeholder="Subject…" value={subject} onChange={(e)=>setSubject(e.target.value)} />
        </div>

        <div className="cn-field">
          <label>Message</label>
          <textarea className="cn-textarea" rows={8} placeholder="Type or dictate…"
                    value={message} onChange={(e)=>setMessage(e.target.value)} />
          <div className="cn-help">AI can draft this for you; you can still edit before sending.</div>
        </div>

        {summary ? (
          <div className="cn-field">
            <label>Brief Summary (optional)</label>
            <textarea className="cn-textarea" rows={4} value={summary} onChange={(e)=>setSummary(e.target.value)} />
          </div>
        ) : null}

        <div className="cn-row" style={{alignItems:"center", justifyContent:"space-between"}}>
          <div className="cn-attach">
            {pdfMeta.filename ? (
              <span className="cn-attach-chip" title={`${(pdfMeta.size/1024).toFixed(1)} KB`}>
                {pdfMeta.filename}
              </span>
            ) : (
              <span className="cn-help">Preparing PDF…</span>
            )}
          </div>
          <div className="cn-row" style={{gap:8}}>
            <button className={`cn-mini ${recording ? "is-danger" : "is-ghost"}`} onClick={toggleRecord} title="Dictate">
              <FaMicrophone style={{marginRight:6}}/>{recording ? "Stop" : "Dictate"}
            </button>
            <button className="cn-mini is-primary" onClick={doCompose} disabled={busy || !noteMarkdown}>
              <FaWandMagicSparkles style={{marginRight:6}}/>{busy ? "Thinking…" : "Compose w/ AI"}
            </button>
            <button className="cn-mini is-primary" onClick={doSend} disabled={busy || !toEmail || !subject || !message}>
              <FaPaperPlane style={{marginRight:6}}/>Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

