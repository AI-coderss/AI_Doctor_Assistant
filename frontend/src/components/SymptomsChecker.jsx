/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import "../styles/symptoms-checker.css";

export default function SymptomsChecker({ sessionId, transcript, backendBase }) {
  const [loading, setLoading] = useState(false);
  const [diagnoses, setDiagnoses] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [refining, setRefining] = useState(false);

  // Reset on new session (new case)
  useEffect(() => {
    setDiagnoses([]);
    setSelectedId(null);
    setAnswers({});
    setError("");
    setLoading(false);
    setRefining(false);
  }, [sessionId]);

  // Auto-start once we have a transcript
  useEffect(() => {
    if (!transcript || !transcript.trim()) return;
    if (diagnoses.length > 0 || loading) return;
    fetchInitial();
  }, [transcript, diagnoses.length, loading]);

  const fetchInitial = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${backendBase}/api/symptoms/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to analyze symptoms.");
      const list = Array.isArray(data.diagnoses) ? data.diagnoses : [];
      setDiagnoses(list);
      setSelectedId(list[0]?.id || null);
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
      if (!data.ok) throw new Error(data.error || "Failed to refine diagnosis.");
      const list = Array.isArray(data.diagnoses) ? data.diagnoses : [];
      setDiagnoses(list);
      setSelectedId(list[0]?.id || null);
    } catch (e) {
      setError(e.message || "Failed to refine diagnosis.");
    } finally {
      setRefining(false);
    }
  };

  const handleAnswer = (qId, answer) => {
    setAnswers((prev) => ({ ...prev, [qId]: answer }));
  };

  const renderTree = (diag) => {
    const symptoms = Array.isArray(diag.symptoms) ? diag.symptoms : [];
    if (!symptoms.length) return null;

    const count = symptoms.length;
    const width = 420;
    const height = Math.max(260, 60 + count * 26);
    const centerX = width - 40;
    const centerY = height / 2;
    const top = 40;
    const bottom = height - 40;
    const step = count > 1 ? (bottom - top) / (count - 1) : 0;

    return (
      <div className="sc-tree-shell">
        <svg
          className="sc-tree-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Branches */}
          {symptoms.map((s, idx) => {
            const y = top + idx * step;
            const strength = typeof s.weight === "number" ? s.weight : 0.4;
            const clamped = Math.max(0.1, Math.min(1, strength));
            const strokeWidth = 2 + clamped * 8;

            const startX = 150;
            const ctrlX1 = (startX + centerX) / 2;
            const ctrlX2 = ctrlX1 + 30;

            return (
              <path
                key={`path-${idx}-${s.name}`}
                d={`M ${startX} ${y} C ${ctrlX1} ${y}, ${ctrlX2} ${centerY}, ${centerX} ${centerY}`}
                stroke="url(#sc-branch-gradient)"
                strokeWidth={strokeWidth}
                fill="none"
                strokeLinecap="round"
                opacity={0.35 + clamped * 0.65}
              />
            );
          })}

          {/* Gradient for branches */}
          <defs>
            <linearGradient
              id="sc-branch-gradient"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="0%"
            >
              <stop offset="0%" stopColor="#64748b" />
              <stop offset="50%" stopColor="#4f46e5" />
              <stop offset="100%" stopColor="#0ea5e9" />
            </linearGradient>
          </defs>

          {/* Symptom labels on the left */}
          {symptoms.map((s, idx) => {
            const y = top + idx * step;
            return (
              <text
                key={`label-${idx}-${s.name}`}
                x={16}
                y={y + 4}
                className="sc-tree-symptom-label"
              >
                {s.name}
              </text>
            );
          })}

          {/* Central diagnosis node on the right */}
          <g className="sc-tree-dx-group">
            <circle
              cx={centerX}
              cy={centerY}
              r={18}
              className="sc-tree-dx-circle"
            />
            <foreignObject
              x={centerX + 14}
              y={centerY - 26}
              width={width - centerX - 20}
              height={52}
            >
              <div className="sc-tree-dx-label">{diag.name}</div>
            </foreignObject>
          </g>
        </svg>
      </div>
    );
  };

  const renderPeopleRow = (likelihoodScore = 0) => {
    const p = Math.max(0, Math.min(1, likelihoodScore || 0));
    const filled = Math.round(p * 10);

    return (
      <div className="sc-people-row">
        <div className="sc-people-label">
          Likelihood
          <span className="sc-people-percent">
            {Math.round(p * 100)}%
          </span>
        </div>
        <div className="sc-people-icons">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className={
                i < filled ? "sc-person sc-person--active" : "sc-person"
              }
            />
          ))}
        </div>
      </div>
    );
  };

  const renderFollowUps = (diag) => {
    const questions = Array.isArray(diag.questions) ? diag.questions : [];
    if (!questions.length) return null;

    const nextQuestion = questions.find((q) => !answers[q.id]);

    return (
      <div className="sc-questions">
        <h4>Follow-up questions</h4>
        {nextQuestion ? (
          <div className="sc-q">
            <span>{nextQuestion.text}</span>
            <div className="sc-buttons">
              {["yes", "no", "unsure"].map((a) => (
                <button
                  key={a}
                  className={answers[nextQuestion.id] === a ? "active" : ""}
                  onClick={() => handleAnswer(nextQuestion.id, a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="sc-q-all">
            All follow-up questions for this condition are answered.
          </p>
        )}

        <button
          className="sc-refine"
          disabled={refining}
          onClick={refine}
        >
          {refining ? "Refining…" : "Update diagnosis"}
        </button>
      </div>
    );
  };

  const selected = diagnoses.find((d) => d.id === selectedId) || null;

  return (
    <div className="sc-root">
      <div className="sc-header">
        <h2 className="sc-title">Symptoms Checker</h2>
        <p className="sc-subtitle">
          AI-assisted mapping between this consultation and likely conditions.
        </p>
      </div>

      {/* Loading overlay for initial analysis */}
      {loading && diagnoses.length === 0 && (
        <div className="sc-loader">
          <div className="sc-spinner" />
          <div className="sc-loader-text">
            <span>Analyzing symptoms</span>
            <span className="sc-loader-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="sc-error">
          {error}
        </div>
      )}

      {/* Stacked diagnosis cards (accordion) */}
      <div className="sc-diag-stack">
        {diagnoses.map((diag) => {
          const isOpen = selectedId === diag.id;
          const likelihood = diag.likelihood_score || 0;

          return (
            <motion.div
              key={diag.id}
              className={`sc-diag-item ${isOpen ? "open" : ""}`}
              layout
            >
              <button
                className="sc-diag-header"
                onClick={() =>
                  setSelectedId((prev) => (prev === diag.id ? null : diag.id))
                }
              >
                <div className="sc-diag-header-main">
                  <span className="sc-diag-name">{diag.name}</span>
                  <span className="sc-diag-chip">
                    {Math.round(likelihood * 100)}%
                  </span>
                </div>
                <div className="sc-diag-header-sub">
                  {diag.likelihood_text || "Tap to see details and symptoms"}
                </div>
                <span
                  className={`sc-chevron ${isOpen ? "open" : ""}`}
                  aria-hidden="true"
                />
              </button>

              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    className="sc-card"
                    initial={{ opacity: 0, y: 8, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, y: -4, height: 0 }}
                    transition={{ duration: 0.35, ease: "easeInOut" }}
                  >
                    {/* People-likelihood row */}
                    {renderPeopleRow(likelihood)}

                    {/* Description & read more */}
                    {diag.short_description && (
                      <p className="sc-desc">{diag.short_description}</p>
                    )}

                    <details className="sc-readmore">
                      <summary>Read more</summary>
                      {diag.long_description && (
                        <p>{diag.long_description}</p>
                      )}
                      {diag.source && (
                        <p className="sc-source">
                          Source{" "}
                          <a
                            href={diag.source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {diag.source.title}
                          </a>
                        </p>
                      )}
                    </details>

                    {/* Fan-style tree visualization */}
                    {renderTree(diag)}

                    {/* Follow-up questions (one by one) */}
                    {renderFollowUps(diag)}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>

      {/* Segmented likelihood bar at bottom */}
      {diagnoses.length > 0 && (
        <div className="sc-piechart">
          {diagnoses.map((d) => (
            <div
              key={d.id}
              className={`sc-slice ${
                selectedId === d.id ? "active" : ""
              }`}
              style={{
                flex: Math.max(d.likelihood_score || 0.05, 0.05),
                backgroundColor: `hsl(${Math.round(
                  (d.likelihood_score || 0) * 150
                )}, 70%, 50%)`,
              }}
              onClick={() => setSelectedId(d.id)}
            >
              <span>{d.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
