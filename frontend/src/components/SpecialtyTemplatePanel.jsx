// src/components/SpecialtyTemplatePanel.jsx
import React from "react";
import useSpecialtyStore from "../store/useSpecialtyStore";
import "../styles/Specialty.css";

export default function SpecialtyTemplatePanel({ onAsk }) {
  const { specialty, template, active } = useSpecialtyStore();
  if (!template) return null;

  const ask = (q) => onAsk?.({ text: q, skipEcho: false });

  return (
    <aside className="template-panel">
      <div className="template-header">
        <span className="badge">{active ? "ACTIVE" : "LOADED"}</span>
        <h4>Specialty: {specialty || "—"}</h4>
      </div>

      <div className="template-sections">
        {template.sections?.map((sec, idx) => (
          <section key={idx} className="template-section">
            <h5>{sec.title}</h5>
            <ul>
              {(sec.fields || []).map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </section>
        ))}
      </div>

      {!!(template.follow_up_questions || []).length && (
        <div className="template-fu">
          <h5>Suggested follow-ups</h5>
          <div className="fu-list">
            {template.follow_up_questions.slice(0, 8).map((q, i) => (
              <button key={i} className="fu-chip" onClick={() => ask(q)}>{q}</button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
