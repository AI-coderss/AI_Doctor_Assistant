/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import "../styles/symptoms-checker.css";

export default function SymptomsChecker({ sessionId, transcript, backendBase }) {
  const [loading, setLoading] = useState(false);
  const [diagnoses, setDiagnoses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [refining, setRefining] = useState(false);

  const pieRef = useRef();

  // Reset when session changes (new case)
  useEffect(() => {
    setDiagnoses([]);
    setSelected(null);
    setAnswers({});
    setError("");
    setLoading(false);
    setRefining(false);
  }, [sessionId]);

  // Auto-start as soon as we have a transcript
  useEffect(() => {
    if (!transcript || !transcript.trim()) return;
    if (diagnoses.length > 0 || loading) return;
    fetchData();
  }, [transcript, diagnoses.length, loading]);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${backendBase}/api/symptoms/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Fetch failed");
      setDiagnoses(data.diagnoses || []);
      setSelected(data.diagnoses?.[0]?.id || null);
    } catch (e) {
      setError(e.message || "Failed to analyze symptoms.");
    } finally {
      setLoading(false);
    }
  };

  const refine = async () => {
    if (!transcript || !transcript.trim()) return;
    setRefining(true);
    setError("");
    try {
      const res = await fetch(`${backendBase}/api/symptoms/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          transcript,
          answers: Object.entries(answers).map(([question_id, answer]) => ({
            question_id,
            answer,
          })),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Refine failed");
      setDiagnoses(data.diagnoses || []);
      setSelected(data.diagnoses?.[0]?.id || null);
    } catch (e) {
      setError(e.message || "Failed to refine diagnosis.");
    } finally {
      setRefining(false);
    }
  };

  if (error) {
    return <div className="sc-error">{error}</div>;
  }

  const selectedDiag = diagnoses.find((d) => d.id === selected) || null;

  return (
    <div className="sc-root">
      <h2 className="sc-title">Symptoms Checker</h2>
      <p className="sc-subtitle">
        Based on this consultation, here are the possible conditions and how the symptoms relate.
      </p>

      {/* Pills for each diagnosis */}
      <div className="sc-diagnosis-list">
        {diagnoses.map((d) => (
          <motion.button
            key={d.id}
            layout
            className={`sc-pill ${selected === d.id ? "active" : ""}`}
            onClick={() => setSelected(d.id)}
          >
            {d.name}{" "}
            <span className="sc-percent">
              {Math.round((d.likelihood_score || 0) * 100)}%
            </span>
          </motion.button>
        ))}
      </div>

      {/* If still loading and nothing yet, show loader */}
      {loading && diagnoses.length === 0 && (
        <div className="sc-loader">Analyzing symptoms…</div>
      )}

      <AnimatePresence>
        {selectedDiag && !loading && (
          <motion.div
            key={selectedDiag.id}
            className="sc-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
          >
            <h3 className="sc-card-title">{selectedDiag.name}</h3>
            {selectedDiag.likelihood_text && (
              <p className="sc-likelihood">{selectedDiag.likelihood_text}</p>
            )}
            {selectedDiag.short_description && (
              <p className="sc-desc">{selectedDiag.short_description}</p>
            )}

            <details className="sc-readmore">
              <summary>Read more</summary>
              {selectedDiag.long_description && (
                <p>{selectedDiag.long_description}</p>
              )}
              {selectedDiag.source && (
                <p className="sc-source">
                  Source:{" "}
                  <a
                    href={selectedDiag.source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selectedDiag.source.title}
                  </a>
                </p>
              )}
            </details>

            {/* Tree visualization – “branches” for each symptom, weighted by strength */}
            <div className="sc-tree">
              {(selectedDiag.symptoms || []).map((s, i) => (
                <motion.div
                  key={s.name || i}
                  className="sc-branch"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  style={{
                    "--weight": Math.max(2, (s.weight || 0) * 10) + "px",
                    "--opacity": s.weight || 0.4,
                  }}
                >
                  <span className="sc-symptom">{s.name}</span>
                </motion.div>
              ))}
            </div>

            {/* Follow-up questions */}
            {selectedDiag.questions?.length > 0 && (
              <div className="sc-questions">
                <h4>Follow-up questions</h4>
                {selectedDiag.questions.map((q) => (
                  <div key={q.id} className="sc-q">
                    <span>{q.text}</span>
                    <div className="sc-buttons">
                      {["yes", "no", "unsure"].map((a) => (
                        <button
                          key={a}
                          className={answers[q.id] === a ? "active" : ""}
                          onClick={() =>
                            setAnswers((p) => ({ ...p, [q.id]: a }))
                          }
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  className="sc-refine"
                  disabled={refining}
                  onClick={refine}
                >
                  {refining ? "Refining..." : "Update diagnosis"}
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Pie-like bar: each slice clickable to show its tree */}
      {diagnoses.length > 0 && (
        <div className="sc-piechart" ref={pieRef}>
          {diagnoses.map((d) => (
            <div
              key={d.id}
              className={`sc-slice ${selected === d.id ? "active" : ""}`}
              style={{
                flex: Math.max(d.likelihood_score || 0.05, 0.05),
                backgroundColor: `hsl(${Math.round(
                  (d.likelihood_score || 0) * 120
                )},70%,50%)`,
              }}
              onClick={() => setSelected(d.id)}
            >
              <span>{d.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
