// components/SpecialtyFormDock.jsx
import React, { useEffect,  useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getFormSchema, composeFormPrompt } from "../api/specialtyTemplate";
import useSpecialtyStore from "../store/useSpecialtyStore";
import "../styles/SpecialtyFormDock.css";

export default function SpecialtyFormDock({
  open,
  onClose,
  sessionId,
  onSubmitPrompt, // (promptText) => void  -> parent (Chat) sends it to /stream
}) {
  const { specialty } = useSpecialtyStore();
  const [schema, setSchema] = useState(null);
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Load schema whenever opened or specialty changes
  useEffect(() => {
    let alive = true;
    async function load() {
      if (!open || !specialty) return;
      setLoading(true);
      setError("");
      try {
        const s = await getFormSchema(specialty);
        if (!alive) return;
        setSchema(s);
        // Reset values to empty per keys
        const init = {};
        (s.sections || []).forEach(sec =>
          (sec.fields || []).forEach(f => { init[f.key] = ""; })
        );
        setValues(init);
      } catch (e) {
        if (!alive) return;
        setError(e.message || "Failed to load schema");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [open, specialty]);

  const handleChange = (key, val) => setValues(v => ({ ...v, [key]: val }));

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!schema) return;
    setBusy(true);
    setError("");
    try {
      // Compose a clean clinical prompt (no JSON) on backend
      const { prompt } = await composeFormPrompt(sessionId, specialty, values);
      // Hand it to Chat to stream via /stream
      onSubmitPrompt?.(prompt);
      onClose?.();
    } catch (e) {
      setError(e.message || "Compose failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="sfd-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            onClick={() => onClose?.()}
          />
          <motion.div
            className="sfd-dock"
            role="dialog"
            aria-modal="true"
            aria-label="Specialty Intake"
            drag
            dragMomentum={false}
            dragElastic={0.12}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.2 }}
          >
            <header className="sfd-head">
              <h3>{schema?.title || `Intake (${specialty})`}</h3>
              <button className="sfd-close" onClick={() => onClose?.()} aria-label="Close">✖</button>
            </header>

            <div className="sfd-body">
              {loading && <div className="sfd-status">Loading form…</div>}
              {error && <div className="sfd-error">{error}</div>}

              {!loading && schema && (
                <form className="sfd-form" onSubmit={handleSubmit}>
                  {(schema.sections || []).map((sec) => (
                    <fieldset key={sec.title} className="sfd-section">
                      <legend>{sec.title}</legend>
                      <div className="sfd-grid">
                        {(sec.fields || []).map((f) => {
                          const id = `f_${f.key}`;
                          const val = values[f.key] ?? "";
                          if (f.type === "textarea") {
                            return (
                              <div className="sfd-field" key={f.key}>
                                <label htmlFor={id}>{f.label}{f.required ? " *" : ""}</label>
                                <textarea
                                  id={id}
                                  rows={f.rows || 3}
                                  placeholder={f.placeholder || ""}
                                  required={!!f.required}
                                  value={val}
                                  onChange={(e) => handleChange(f.key, e.target.value)}
                                />
                              </div>
                            );
                          }
                          if (f.type === "select") {
                            return (
                              <div className="sfd-field" key={f.key}>
                                <label htmlFor={id}>{f.label}{f.required ? " *" : ""}</label>
                                <select
                                  id={id}
                                  required={!!f.required}
                                  value={val}
                                  onChange={(e) => handleChange(f.key, e.target.value)}
                                >
                                  <option value="">— Select —</option>
                                  {(f.options || []).map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                              </div>
                            );
                          }
                          // default: text/number
                          return (
                            <div className="sfd-field" key={f.key}>
                              <label htmlFor={id}>{f.label}{f.required ? " *" : ""}</label>
                              <input
                                id={id}
                                type={f.type || "text"}
                                placeholder={f.placeholder || ""}
                                min={f.min}
                                max={f.max}
                                step={f.step}
                                required={!!f.required}
                                value={val}
                                onChange={(e) => handleChange(f.key, e.target.value)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}

                  <div className="sfd-actions">
                    <button type="button" className="sfd-btn ghost" onClick={() => onClose?.()}>Cancel</button>
                    <button type="submit" className="sfd-btn primary" disabled={busy}>
                      {busy ? "Preparing…" : "Submit & Generate"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
