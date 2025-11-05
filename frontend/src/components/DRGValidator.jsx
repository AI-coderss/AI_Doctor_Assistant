/* eslint-disable jsx-a11y/no-redundant-roles */
/* eslint-disable no-unused-vars */
// ./DRGValidator.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable jsx-a11y/no-redundant-roles */
/* eslint-disable no-unused-vars */
// ./DRGValidator.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useDRGValidatorStore from "../store/useDRGValidatorStore";

/* ---------- Tiny UI helpers ---------- */
function Pill({ kind = "status", value = "" }) {
  const v = String(value || "").toLowerCase();
  const cls =
    kind === "status"
      ? v === "validated"
        ? "status-pill validated"
        : v === "review"
        ? "status-pill review"
        : "status-pill flagged"
      : v === "ready"
      ? "nphies-pill ready"
      : v === "review"
      ? "nphies-pill review"
      : v === "risk"
      ? "nphies-pill risk"
      : "nphies-pill denied";
  return <span className={cls}>{value}</span>;
}

function RowActions({ row, onFix, onOptimize, onSubmit }) {
  const acts = Array.isArray(row.actions) ? row.actions : [];
  return (
    <div className="drg-actions">
      {acts.includes("Submit") && (
        <button className="act-btn submit" onClick={() => onSubmit?.(row)}>
          Submit
        </button>
      )}
      {acts.includes("Optimize") && (
        <button className="act-btn optimize" onClick={() => onOptimize?.(row)}>
          Optimize
        </button>
      )}
      {acts.includes("Fix") && (
        <button className="act-btn fix" onClick={() => onFix?.(row)}>
          Fix
        </button>
      )}
    </div>
  );
}

/* ---------- Main Component ---------- */
export default function DRGValidator({ backendBase, sessionId }) {
  const {
    rows = [],
    summary = { validated: 0, review: 0, flagged: 0 },
    loading,
    error,
    open,
    toggleOpen,
    validateNow,
  } = useDRGValidatorStore();

  const [hoverIdx, setHoverIdx] = useState(null);
  const [q, setQ] = useState("");

  // mount-time effect for body right-margin when panel is open (no Chat.jsx change needed)
  useEffect(() => {
    if (open) document.body.classList.add("drg-open");
    else document.body.classList.remove("drg-open");
    return () => document.body.classList.remove("drg-open");
  }, [open]);

  // ensure we actually have data when first opened (validate only once)
  useEffect(() => {
    if (open && typeof validateNow === "function" && !loading && rows.length === 0) {
      validateNow(backendBase, sessionId);
    }
  }, [open, loading, rows.length, validateNow, backendBase, sessionId]);

  const callFix = async (row) => {
    try {
      const res = await fetch(`${backendBase}/drg/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, row }),
        credentials: "include",
      });
      const j = await res.json();
      alert((j?.suggested_fixes_md || []).join("\n• "));
    } catch (e) {
      alert("Fix action failed. Please try again.");
    }
  };

  const searchText = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!searchText) return rows;
    const match = (s) => String(s || "").toLowerCase().includes(searchText);
    return rows.filter((r) => {
      const code = r?.drg_code?.code;
      const label = r?.drg_code?.label;
      const reasons = (r?.reasons_md || []).join(" ");
      const fixes = (r?.suggested_fixes_md || []).join(" ");
      return (
        match(r?.patient_id) ||
        match(code) ||
        match(label) ||
        match(r?.status) ||
        match(r?.nphies) ||
        match(reasons) ||
        match(fixes)
      );
    });
  }, [rows, searchText]);

  return (
    <>
      {/* Pulsing rectangular launcher button (replaces icon FAB) */}
      <div
        className="drg-fab"
        data-state={open ? "active" : "idle"}
        aria-hidden={false}
      >
        <button
          type="button"
          onClick={() => toggleOpen?.(!open)}
          aria-expanded={!!open}
          aria-controls="drg-validator-panel"
          className="btn"
        >
          <span className="btn-label">DRG Validator</span>
        </button>
      </div>

      {/* Right dock panel */}
      <aside
        id="drg-validator-panel"
        className={`drg-aside ${open ? "open" : ""}`}
        role="complementary"
        aria-label="DRG Validator"
      >
        <div className="drg-panel">
          {/* Header */}
          <div className="drg-panel-head">
            <div className="drg-title">
              Active Claims <span className="count">({filtered.length})</span>
            </div>
            <button
              className="drg-close"
              onClick={() => toggleOpen?.(false)}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Toolbar */}
          <div className="drg-toolbar">
            <input
              className="drg-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search (ID, code, label, status, NPHIES)…"
              aria-label="Search claims"
            />
            {q && (
              <button
                className="drg-clear"
                onClick={() => setQ("")}
                title="Clear search"
              >
                Clear
              </button>
            )}
          </div>

          {/* States */}
          {loading && <div className="drg-loading">Validating…</div>}
          {error && <div className="drg-error">{String(error)}</div>}

          {/* Table */}
          <div className="drg-table-wrap">
            <table className="drg-table drg-table--lined">
              <thead>
                <tr>
                  <th>Patient ID</th>
                  <th>DRG</th>
                  <th>Status</th>
                  <th>NPHIES</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!filtered.length ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 12 }}>
                      <em>No claims.</em>
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => (
                    <tr key={i}>
                      <td className="td-id">
                        <code>{r.patient_id}</code>
                      </td>
                      <td className="td-drg">
                        <div className="drg-code">
                          <div className="drg-code-code">{r?.drg_code?.code}</div>
                          <div className="drg-code-label">{r?.drg_code?.label}</div>
                        </div>
                      </td>
                      <td
                        className="drg-status-cell"
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(null)}
                      >
                        <Pill kind="status" value={r.status} />
                        {String(r.status).toUpperCase() === "FLAGGED" && hoverIdx === i && (
                          <div className="drg-pop">
                            <div className="drg-pop-head">
                              <div className="drg-pop-title">Why flagged</div>
                              <button
                                className="drg-pop-close"
                                onClick={() => setHoverIdx(null)}
                                aria-label="Close details"
                              >
                                ×
                              </button>
                            </div>

                            <div className="drg-pop-body">
                              <div>
                                <div className="drg-pop-title">Reasons</div>
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {(r.reasons_md || []).map((s) => `- ${s}`).join("\n")}
                                </ReactMarkdown>
                              </div>

                              <div>
                                <div className="drg-pop-title" style={{ marginTop: 8 }}>
                                  Suggested fixes
                                </div>
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {(r.suggested_fixes_md || [])
                                    .map((s) => `- ${s}`)
                                    .join("\n")}
                                </ReactMarkdown>

                                <div className="drg-pop-actions">
                                  <button className="act-btn fix" onClick={() => callFix(r)}>
                                    Fix
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="td-nphies">
                        <Pill kind="nphies" value={r.nphies} />
                      </td>
                      <td className="td-actions">
                        <RowActions
                          row={r}
                          onFix={callFix}
                          onOptimize={callFix}
                          onSubmit={() => alert("Submitted")}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Summary */}
          <div className="drg-summary">
            <span className="sum ok">✔ {summary.validated} Validated</span>
            <span className="sum rev">⚠ {summary.review} Under Review</span>
            <span className="sum flg">✖ {summary.flagged} Flagged</span>
          </div>
        </div>
      </aside>
    </>
  );
}


