/* eslint-disable no-unused-vars */
import React, { useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/MedicalVision.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const VISION_URL = `${BACKEND_BASE}/vision/analyze`;

export default function MedicalImageAnalyzer({ onResult }) {
  const inputRef = useRef(null);

  // Busy + errors
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");   // shown below the button
  const [err, setErr] = useState("");

  // Two-phase flow state
  const [phase, setPhase] = useState("idle"); // "idle" | "questions" | "final"
  const [imageId, setImageId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [questions, setQuestions] = useState([]); // array of strings from server
  const [answers, setAnswers] = useState([]);     // same length as questions

  const onPick = () => inputRef.current?.click();

  // Reset to initial state (keeps UI tidy after a full run or cancel)
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

      // Pass the session so the backend can pull your case context
      try {
        const sid = localStorage.getItem("sessionId");
        if (sid) form.append("session_id", sid);
      } catch {}

      // Optional override:
      // form.append("prompt", "Focus on pneumothorax signs.");

      const res = await fetch(VISION_URL, { method: "POST", body: form });
      const data = await (async () => {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return { error: await res.text() };
      })();

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      // Handle both the new (two-phase) and legacy (single-phase) responses
      const phaseFromServer = data?.phase || null;
      const text = data?.text || "No analysis returned.";

      // Always echo the server's text as a chat bubble
      onResult?.(text, data?.meta || null);

      if (phaseFromServer === "questions") {
        // Phase A: we got follow-up questions
        setMeta(data?.meta || null);
        setImageId(data?.image_id || null);
        const qs = Array.isArray(data?.questions) ? data.questions : [];
        setQuestions(qs);
        setAnswers(qs.map(() => "")); // init empty answers
        setPhase("questions");
        setStatus("Please provide brief answers to the follow-up questions.");
      } else {
        // Legacy or final direct response
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

    // Build a compact answers array (trim empty lines but keep order)
    const trimmed = answers.map((a) => String(a || "").trim());
    const nonEmpty = trimmed.filter(Boolean);
    if (questions.length && nonEmpty.length === 0) {
      setErr("Please answer at least one follow-up question.");
      return;
    }

    setBusy(true);
    setStatus("Generating final report…");

    try {
      // Pull session_id again for safety
      let session_id = null;
      try {
        const sid = localStorage.getItem("sessionId");
        if (sid) session_id = sid;
      } catch {}

      const res = await fetch(VISION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_id: imageId,
          answers: trimmed,  // send all answers (empty allowed)
          session_id,
        }),
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
    <div className="vision-tool">
      {/* Upload / start button */}
      <motion.button
        type="button"
        className={`vision-btn ${busy ? "is-busy" : ""}`}
        onClick={onPick}
        whileHover={{ scale: busy ? 1 : 1.02 }}
        whileTap={{ scale: busy ? 1 : 0.98 }}
        disabled={busy || phase === "questions"}   // disable while waiting for answers
        title="Analyze medical image"
        aria-label="Analyze medical image"
        aria-busy={busy}
        aria-describedby="vision-status"
      >
        {busy ? <span className="rainbow-spinner" aria-hidden="true" /> : "Analyze Image"}
      </motion.button>

      {/* Hidden file input */}
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

      {/* Phase A: follow-up questions form */}
      {phase === "questions" && questions.length > 0 && (
        <div className="vision-qna">
          <div className="vision-qna__title">Follow-up questions</div>
          <ol className="vision-qna__list">
            {questions.map((q, idx) => (
              <li key={idx} className="vision-qna__item">
                <div className="vision-qna__q">{q}</div>
                <textarea
                  className="vision-qna__a"
                  placeholder="Your brief answer…"
                  value={answers[idx] || ""}
                  onChange={(e) => {
                    const next = answers.slice();
                    next[idx] = e.target.value;
                    setAnswers(next);
                  }}
                  rows={2}
                />
              </li>
            ))}
          </ol>

          <div className="vision-qna__actions">
            <button
              type="button"
              className="vision-send-btn"
              onClick={submitAnswers}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "Submitting…" : "Submit Answers"}
            </button>
            <button
              type="button"
              className="vision-cancel-btn"
              onClick={reset}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Status line below the button */}
      <div id="vision-status" className="vision-status" aria-live="polite">
        {busy ? (phase === "questions" ? "Submitting answers…" : status || "Analyzing the medical image…") : status}
      </div>

      {/* Error chip */}
      {err ? <div className="vision-error">{err}</div> : null}
    </div>
  );
}
