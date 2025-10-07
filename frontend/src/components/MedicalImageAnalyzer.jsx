/* eslint-disable no-unused-vars */
import React, { useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/MedicalVision.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const VISION_URL = `${BACKEND_BASE}/vision/analyze`;

export default function MedicalImageAnalyzer({ onResult }) {
  const inputRef = useRef(null);

  // Busy + status/errors
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");

  // Two-phase flow
  const [phase, setPhase] = useState("idle");   // idle | questions | final
  const [imageId, setImageId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState([]);

  const onPick = () => inputRef.current?.click();

  const reset = () => {
    setBusy(false);
    setStatus("");
    setErr("");
    setPhase("idle");
    setImageId(null);
    setMeta(null);
    setQuestions([]);
    setAnswers([]);
  };

  const onFile = async (file) => {
    setErr("");
    if (!file || !file.type.startsWith("image/")) {
      setErr("Please choose an image file.");
      return;
    }

    setBusy(true);
    setStatus("Uploading image and preparing follow-up questions…");

    try {
      const form = new FormData();
      form.append("image", file);
      try {
        const sid = localStorage.getItem("sessionId");
        if (sid) form.append("session_id", sid);
      } catch {}

      const res = await fetch(VISION_URL, { method: "POST", body: form });
      const data = await (async () => {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return { error: await res.text() };
      })();

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      // Always echo server text as a chat bubble
      const text = data?.text || "No analysis returned.";
      onResult?.(text, data?.meta || null);

      if (data?.phase === "questions") {
        setMeta(data?.meta || null);
        setImageId(data?.image_id || null);
        const qs = Array.isArray(data?.questions) ? data.questions : [];
        setQuestions(qs);
        setAnswers(qs.map(() => ""));
        setPhase("questions");
        setStatus("Please provide brief answers to the follow-up questions.");
      } else {
        setPhase("final");
        setStatus("Completed.");
      }
    } catch (e) {
      setErr(e.message || "Failed to analyze image.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = async () => {
    setErr("");
    if (!imageId) {
      setErr("Image session expired. Please re-upload the image.");
      return;
    }

    const trimmed = answers.map((a) => String(a || "").trim());
    const nonEmpty = trimmed.filter(Boolean);
    if (questions.length && nonEmpty.length === 0) {
      setErr("Please answer at least one follow-up question.");
      return;
    }

    setBusy(true);
    setStatus("Generating final report…");

    try {
      let session_id = null;
      try {
        const sid = localStorage.getItem("sessionId");
        if (sid) session_id = sid;
      } catch {}

      const res = await fetch(VISION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_id: imageId, answers: trimmed, session_id }),
      });
      const data = await (async () => {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return { error: await res.text() };
      })();

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const text = data?.text || "No report generated.";
      onResult?.(text, data?.meta || meta || null);

      setPhase("final");
      setStatus("Completed.");
    } catch (e) {
      setErr(e.message || "Failed to generate final report.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Drawer tile (small) */}
      <div className="vision-tool">
        <motion.button
          type="button"
          className={`vision-btn ${busy ? "is-busy" : ""}`}
          onClick={onPick}
          whileHover={{ scale: busy ? 1 : 1.02 }}
          whileTap={{ scale: busy ? 1 : 0.98 }}
          disabled={busy || phase === "questions"}
          title="Analyze medical image"
          aria-label="Analyze medical image"
          aria-busy={busy}
          aria-describedby="vision-status"
        >
          Analyze Image
        </motion.button>

        {/* External loader replaces the button while busy */}
        <div className="vision-loader">
          {busy && (
            <>
              <div className="rainbow-spinner" aria-hidden="true" />
              <div className="vision-loader__label">Analyzing the medical image…</div>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />

        <div id="vision-status" className="vision-status" aria-live="polite">
          {busy ? "" : status}
        </div>

        {err ? <div className="vision-error">{err}</div> : null}
      </div>

      {/* Flyout: fixed on the RIGHT (like the calculator), draggable, above all */}
      {phase === "questions" && (
        <motion.div
          className="vision-followup-flyout"
          initial={{ opacity: 0, scale: 0.98, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          drag
          dragMomentum={false}
          dragElastic={0.06}
        >
          <div className="vf-header" data-drag-handle>
            <div className="vf-title">Follow-up for medical image</div>
            <button type="button" className="vf-close" onClick={reset} disabled={busy}>
              Close
            </button>
          </div>

          <div className="vision-followup" role="dialog" aria-modal="true" aria-label="Vision follow-up form">
            <div className="vision-followup__title">Follow-up questions</div>

            <ol className="vision-qna__list">
              {questions.map((q, idx) => (
                <li key={idx} className="vision-qna__item">
                  <div className="vf-label">
                    <span>Q{idx + 1}</span>
                    <span className="vf-hint">brief answer</span>
                  </div>
                  <div className="vision-qna__q">{q}</div>
                  <textarea
                    className="vf-textarea"
                    placeholder="Your brief answer…"
                    value={answers[idx] || ""}
                    onChange={(e) => {
                      const next = answers.slice();
                      next[idx] = e.target.value;
                      setAnswers(next);
                    }}
                    rows={3}
                  />
                </li>
              ))}
            </ol>

            <div className="vf-actions">
              <button type="button" className="vf-btn vf-btn--ghost" onClick={reset} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="vf-btn vf-btn--primary"
                onClick={submitAnswers}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Submitting…" : "Submit Answers"}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}
