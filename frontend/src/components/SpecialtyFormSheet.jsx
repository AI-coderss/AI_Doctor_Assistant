/* eslint-disable no-unused-vars */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable react-hooks/exhaustive-deps */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable jsx-a11y/label-has-associated-control */
// src/components/SpecialtyFormSheet.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useSpecialtyStore from "../store/useSpecialtyStore";
import { SPECIALTY_SCHEMAS, DEFAULT_SCHEMA, FIELD_TYPES, SPECIALTY_LABELS } from "../specialty/schema";
import "../styles/Specialty.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

export default function SpecialtyFormSheet({ onSubmitToChat, onSubmitToChatStream, sessionId }) {
  const { specialty, clearSpecialty } = useSpecialtyStore();
  const [open, setOpen] = useState(false);
  const schema = useMemo(() => SPECIALTY_SCHEMAS[specialty] || DEFAULT_SCHEMA, [specialty]);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState({});
  const [dragging, setDragging] = useState(false);
  const constraintsRef = useRef(null);

  useEffect(() => {
    if (open) document.body.classList.add("modal-open");
    else document.body.classList.remove("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  useEffect(() => {
    if (specialty) {
      setValues({});
      setStep(0);
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [specialty]);

  const close = () => {
    setOpen(false);
    setTimeout(() => {
      try { clearSpecialty(); } catch {}
    }, 120);
  };

  const onChange = (id, v) => setValues((prev) => ({ ...prev, [id]: v }));

  const renderField = (f) => {
    const v = values[f.id] ?? (f.type === FIELD_TYPES.TOGGLE ? false : "");
    const common = { id: f.id, value: v, onChange: (e) => onChange(f.id, e.target.value) };

    switch (f.type) {
      case FIELD_TYPES.TEXT:
        return (
          <div className="fld">
            <label htmlFor={f.id}>
              {f.label}{f.required && <span className="req">*</span>}
            </label>
            <input type="text" {...common} placeholder={f.placeholder || ""} />
          </div>
        );
      case FIELD_TYPES.TEXTAREA:
        return (
          <div className="fld span2">
            <label htmlFor={f.id}>
              {f.label}{f.required && <span className="req">*</span>}
            </label>
            <textarea {...common} rows={3} placeholder={f.placeholder || ""} />
          </div>
        );
      case FIELD_TYPES.NUMBER:
        return (
          <div className="fld">
            <label htmlFor={f.id}>
              {f.label}{f.unit && <em className="unit">{` (${f.unit})`}</em>}{f.required && <span className="req">*</span>}
            </label>
            <input type="number" inputMode="decimal" {...common} />
          </div>
        );
      case FIELD_TYPES.DATE:
        return (
          <div className="fld">
            <label htmlFor={f.id}>
              {f.label}{f.required && <span className="req">*</span>}
            </label>
            <input type="date" id={f.id} value={v} onChange={(e) => onChange(f.id, e.target.value)} />
          </div>
        );
      case FIELD_TYPES.SELECT:
        return (
          <div className="fld">
            <label htmlFor={f.id}>
              {f.label}{f.required && <span className="req">*</span>}
            </label>
            <select id={f.id} value={v} onChange={(e) => onChange(f.id, e.target.value)}>
              <option value="">— Select —</option>
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        );
      case FIELD_TYPES.RADIO:
        return (
          <div className="fld">
            <span className="lbl">
              {f.label}{f.required && <span className="req">*</span>}
            </span>
            <div className="radio-row">
              {f.options.map((o) => (
                <label key={o} className={`chip ${v === o ? "sel" : ""}`}>
                  <input
                    type="radio"
                    name={f.id}
                    checked={v === o}
                    onChange={() => onChange(f.id, o)}
                  />
                  {o}
                </label>
              ))}
            </div>
          </div>
        );
      case FIELD_TYPES.MULTISELECT:
        return (
          <div className="fld span2">
            <span className="lbl">{f.label}</span>
            <div className="chips">
              {f.options.map((o) => {
                const selected = Array.isArray(v) && v.includes(o);
                return (
                  <label key={o} className={`chip ${selected ? "sel" : ""}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        const set = new Set(Array.isArray(v) ? v : []);
                        if (e.target.checked) set.add(o);
                        else set.delete(o);
                        onChange(f.id, Array.from(set));
                      }}
                    />
                    {o}
                  </label>
                );
              })}
            </div>
          </div>
        );
      case FIELD_TYPES.TOGGLE:
        return (
          <div className="fld toggle">
            <label className="switch">
              <input
                type="checkbox"
                checked={!!v}
                onChange={(e) => onChange(f.id, e.target.checked)}
              />
              <span className="slider" />
            </label>
            <span className="lbl">{f.label}</span>
          </div>
        );
      default:
        return null;
    }
  };

  const section = schema.steps[step] || { fields: [] };
  const total = schema.steps.length;
  const next = () => setStep((s) => Math.min(s + 1, total - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  /** quick “wave” confirm on submission (form closes immediately) */
  const createSubmitPulse = () => {
    try {
      const el = document.createElement("div");
      el.className = "submit-pulse";
      document.body.appendChild(el);
      el.addEventListener("animationend", () => {
        try { document.body.removeChild(el); } catch {}
      });
    } catch {}
  };

  const streamFinalFromPrompt = async (finalPrompt) => {
    let started = false;
    try {
      const res = await fetch(`${BACKEND_BASE}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: finalPrompt, session_id: sessionId || "" }),
      });

      if (res.body && typeof onSubmitToChatStream === "function") {
        onSubmitToChatStream({ type: "start" });
        started = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) onSubmitToChatStream({ type: "chunk", data: chunk });
        }
        onSubmitToChatStream({ type: "done" });
      } else {
        const text = await res.text();
        onSubmitToChat?.(text || "Form submitted.");
      }
    } catch (e) {
      if (started) {
        onSubmitToChatStream?.({ type: "chunk", data: "\n[Network error while streaming.]" });
        onSubmitToChatStream?.({ type: "done" });
      } else {
        onSubmitToChat?.("Something went wrong submitting the form.");
      }
      console.error(e);
    }
  };

  const submit = async () => {
    // 1) immediate UI feedback + close sheet
    createSubmitPulse();
    const basePayload = {
      session_id: sessionId || "",
      specialty,
      form: values,
    };

    // Close *before* network
    close();

    // 2) Format with Prompt Formatter → then stream final from /stream
    try {
      // show loader in chat immediately
      onSubmitToChatStream?.({ type: "start" });

      const fmtRes = await fetch(`${BACKEND_BASE}/prompt-formatter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      });

      if (!fmtRes.ok) {
        // fallback: call legacy analyze endpoint if formatter fails
        console.warn("Prompt-formatter failed, falling back to analyze-form-case-stream");
        const legacy = await fetch(`${BACKEND_BASE}/analyze-form-case-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(basePayload),
        });

        if (legacy.body) {
          const reader = legacy.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) onSubmitToChatStream?.({ type: "chunk", data: chunk });
          }
          onSubmitToChatStream?.({ type: "done" });
          return;
        } else {
          const text = await legacy.text();
          onSubmitToChat?.(text || "Form submitted.");
          return;
        }
      }

      const { formatted_prompt } = await fmtRes.json();
      if (!formatted_prompt) {
        throw new Error("Formatter response missing 'formatted_prompt'.");
      }

      // stream final answer from /stream using the formatted prompt
      await streamFinalFromPrompt(formatted_prompt);
    } catch (e) {
      console.error("Submit pipeline error:", e);
      onSubmitToChatStream?.({ type: "chunk", data: "\n[Error preparing the response.]" });
      onSubmitToChatStream?.({ type: "done" });
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="sheet-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.28 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
          <div ref={constraintsRef} style={{ position: "fixed", inset: 0, zIndex: 2147483647 }}>
            <motion.aside
              className={`sheet ${dragging ? "dragging" : ""}`}
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              drag
              dragConstraints={constraintsRef}
              dragMomentum={false}
              dragElastic={0.08}
              onDragStart={() => setDragging(true)}
              onDragEnd={() => setDragging(false)}
            >
              <header className="sheet-head" style={{ cursor: "grab" }}>
                <div className="sheet-title">
                  <span className="spec-pill">
                    {SPECIALTY_LABELS[specialty] || schema.title}
                  </span>
                  <span className="step-info">Step {step + 1} / {total}</span>
                </div>
                <button className="icon-btn" onClick={close} aria-label="Close form">✖</button>
              </header>

              <div className="sheet-progress">
                <div className="bar" style={{ width: `${((step + 1) / total) * 100}%` }} />
              </div>

              <main className="sheet-body">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={section.id}
                    className="section-grid"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.18 }}
                  >
                    <h3 className="section-title">{section.title}</h3>
                    {section.fields.map((f) => (
                      <div key={f.id} className="field-wrap">{renderField(f)}</div>
                    ))}
                  </motion.div>
                </AnimatePresence>
              </main>

              <footer className="sheet-foot">
                <div className="foot-left">
                  <button className="btn ghost" onClick={back} disabled={step === 0}>Back</button>
                </div>
                <div className="foot-right">
                  {step < total - 1 ? (
                    <button className="btn primary" onClick={next}>Next</button>
                  ) : (
                    <button className="btn primary" onClick={submit}>Submit</button>
                  )}
                </div>
              </footer>
            </motion.aside>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
