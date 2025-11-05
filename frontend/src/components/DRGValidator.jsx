import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useDRGValidatorStore from "../store/useDRGValidatorStore";

function Pill({ kind = "status", value = "" }) {
  const v = String(value || "").toLowerCase();
  const cls =
    kind === "status"
      ? v === "validated" ? "status-pill validated" :
        v === "review" ? "status-pill review" : "status-pill flagged"
      : v === "ready" ? "nphies-pill ready" :
        v === "review" ? "nphies-pill review" :
        v === "risk" ? "nphies-pill risk" : "nphies-pill denied";
  return <span className={cls}>{value}</span>;
}

function RowActions({ row, onFix, onOptimize, onSubmit }) {
  const acts = Array.isArray(row.actions) ? row.actions : [];
  return (
    <div className="drg-actions">
      {acts.includes("Submit") && <button className="act-btn submit" onClick={() => onSubmit?.(row)}>Submit</button>}
      {acts.includes("Optimize") && <button className="act-btn optimize" onClick={() => onOptimize?.(row)}>Optimize</button>}
      {acts.includes("Fix") && <button className="act-btn fix" onClick={() => onFix?.(row)}>Fix</button>}
    </div>
  );
}

export default function DRGValidator({ backendBase, sessionId }) {
  const { rows, summary, loading, error, toggleOpen } = useDRGValidatorStore();
  const [hover, setHover] = useState(null); // row index for the pop-over

  const callFix = async (row) => {
    const res = await fetch(`${backendBase}/drg/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, row }),
      credentials: "include",
    });
    const j = await res.json();
    // simple toast-ish feedback
    alert((j?.suggested_fixes_md || []).join("\n• "));
  };

  return (
    <div className="drg-panel">
      <div className="drg-panel-head">
        <div>Active Claims ({rows.length})</div>
        <button className="drg-close" onClick={() => toggleOpen(false)} aria-label="Close">×</button>
      </div>

      {loading && <div className="drg-loading">Validating…</div>}
      {error && <div className="drg-error">{String(error)}</div>}

      <div className="drg-table-wrap">
        <table className="drg-table">
          <thead>
            <tr>
              <th>Patient ID</th>
              <th>DRG Code</th>
              <th>Status</th>
              <th>NPHIES</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr><td colSpan="5" style={{ padding: 12 }}><em>No claims yet.</em></td></tr>
            ) : rows.map((r, i) => (
              <tr key={i}>
                <td>{r.patient_id}</td>
                <td>
                  <div className="drg-code">
                    <div className="drg-code-code">{r?.drg_code?.code}</div>
                    <div className="drg-code-label">{r?.drg_code?.label}</div>
                  </div>
                </td>
                <td
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  className="drg-status-cell"
                >
                  <Pill kind="status" value={r.status} />
                  {String(r.status).toUpperCase() === "FLAGGED" && hover === i && (
                    <div className="drg-pop">
                      <div className="drg-pop-title">Why flagged</div>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {(r.reasons_md || []).map(s => `- ${s}`).join("\n")}
                      </ReactMarkdown>
                      <div className="drg-pop-title" style={{ marginTop: 8 }}>Suggested fixes</div>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {(r.suggested_fixes_md || []).map(s => `- ${s}`).join("\n")}
                      </ReactMarkdown>
                      <div className="drg-pop-actions">
                        <button className="act-btn fix" onClick={() => callFix(r)}>Fix</button>
                      </div>
                    </div>
                  )}
                </td>
                <td><Pill kind="nphies" value={r.nphies} /></td>
                <td>
                  <RowActions
                    row={r}
                    onFix={callFix}
                    onOptimize={callFix}
                    onSubmit={() => alert("Submitted")}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="drg-summary">
        <span className="sum ok">✔ {summary.validated} Validated</span>
        <span className="sum rev">⚠ {summary.review} Under Review</span>
        <span className="sum flg">✖ {summary.flagged} Flagged</span>
      </div>
    </div>
  );
}
