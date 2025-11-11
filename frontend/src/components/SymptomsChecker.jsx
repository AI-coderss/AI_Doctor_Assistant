/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as d3 from "d3";
import "../styles/symptoms-checker.css";

export default function SymptomsChecker({ sessionId, transcript, backendBase }) {
  const [loading, setLoading] = useState(false);
  const [diagnoses, setDiagnoses] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [refining, setRefining] = useState(false);

  // Reset when session changes
  useEffect(() => {
    setDiagnoses([]);
    setSelectedId(null);
    setAnswers({});
    setError("");
    setLoading(false);
    setRefining(false);
  }, [sessionId]);

  // Auto-start when transcript is ready
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

      {/* Loader during first analysis */}
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

      {error && <div className="sc-error">{error}</div>}

      {/* Diagnosis accordion stack */}
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
                    {renderPeopleRow(likelihood)}

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

                    {/* D3 collapsible tree */}
                    <SymptomTreeD3 diagnosis={diag} />

                    {/* Follow-up questions */}
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

/* ---------- D3 TREE COMPONENT ---------- */

function SymptomTreeD3({ diagnosis }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!diagnosis) return;

    const symptoms = Array.isArray(diagnosis.symptoms)
      ? diagnosis.symptoms
      : [];

    // Build hierarchical data: root = diagnosis, children = symptoms
    const data = {
      name: diagnosis.name,
      children: symptoms.map((s) => ({
        name: s.name,
        weight: typeof s.weight === "number" ? s.weight : 0.4,
      })),
    };

    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const width = 480;
    const marginTop = 16;
    const marginRight = 24;
    const marginBottom = 16;
    const marginLeft = 24;

    const dx = 26;
    const root = d3.hierarchy(data);
    const dy = 120; // horizontal distance between columns

    const treeLayout = d3.tree().nodeSize([dx, dy]);
    const diagonal = d3
      .linkHorizontal()
      // Mirror horizontally so the root is on the right, symptoms on the left
      .x((d) => width - marginRight - d.y)
      .y((d) => d.x);

    // Prepare collapsible state
    root.x0 = 0;
    root.y0 = 0;
    root.descendants().forEach((d, i) => {
      d.id = i;
      d._children = d.children;
      // Start open for root; children collapsed by default is optional
      if (d.depth && d.depth > 1) d.children = null;
    });

    const svg = d3
      .select(container)
      .append("svg")
      .attr("class", "sc-tree-svg")
      .attr("width", "100%")
      .attr("viewBox", [0, 0, width, dx + marginTop + marginBottom]);

    const gLink = svg
      .append("g")
      .attr("class", "sc-tree-links")
      .attr(
        "transform",
        `translate(0,${marginTop})`
      );

    const gNode = svg
      .append("g")
      .attr("class", "sc-tree-nodes")
      .attr(
        "transform",
        `translate(0,${marginTop})`
      );

    function update(source) {
      // Compute new layout
      treeLayout(root);

      let left = root;
      let right = root;
      root.eachBefore((d) => {
        if (d.x < left.x) left = d;
        if (d.x > right.x) right = d;
      });

      const height = right.x - left.x + marginTop + marginBottom;

      svg
        .attr("viewBox", [0, left.x - marginTop, width, height])
        .attr("height", height);

      const nodes = root.descendants().reverse();
      const links = root.links();

      // Nodes
      const node = gNode.selectAll("g").data(nodes, (d) => d.id);

      const nodeEnter = node
        .enter()
        .append("g")
        .attr(
          "transform",
          () => `translate(${width - marginRight - source.y0},${source.x0})`
        )
        .attr("fill-opacity", 0)
        .attr("stroke-opacity", 0)
        .attr("class", (d) =>
          d.depth === 0
            ? "sc-tree-node sc-tree-node--root"
            : "sc-tree-node sc-tree-node--leaf"
        )
        .on("click", (event, d) => {
          // Only collapse/expand if the node has children/_children
          if (!d.children && !d._children) return;
          d.children = d.children ? null : d._children;
          update(d);
        });

      nodeEnter
        .append("circle")
        .attr("r", (d) => (d.depth === 0 ? 10 : 6))
        .attr("class", (d) =>
          d.depth === 0 ? "sc-tree-circle sc-tree-circle--root" : "sc-tree-circle"
        );

      nodeEnter
        .append("text")
        .attr("dy", "0.32em")
        .attr("x", (d) => (d.depth === 0 ? -14 : -10))
        .attr("text-anchor", "end")
        .text((d) => d.data.name)
        .attr("class", "sc-tree-label");

      const nodeUpdate = node
        .merge(nodeEnter)
        .transition()
        .duration(250)
        .attr(
          "transform",
          (d) =>
            `translate(${width - marginRight - d.y},${d.x})`
        )
        .attr("fill-opacity", 1)
        .attr("stroke-opacity", 1);

      const nodeExit = node
        .exit()
        .transition()
        .duration(250)
        .attr(
          "transform",
          () =>
            `translate(${width - marginRight - source.y},${source.x})`
        )
        .attr("fill-opacity", 0)
        .attr("stroke-opacity", 0)
        .remove();

      // Links
      const link = gLink.selectAll("path").data(links, (d) => d.target.id);

      const linkEnter = link
        .enter()
        .append("path")
        .attr("class", "sc-tree-link")
        .attr("d", () => {
          const o = { x: source.x0, y: source.y0 };
          return diagonal({ source: o, target: o });
        })
        .attr("stroke-width", (d) => {
          const w = d.target.data.weight || 0.4;
          return 1.2 + w * 4;
        });

      link
        .merge(linkEnter)
        .transition()
        .duration(250)
        .attr("d", diagonal);

      link
        .exit()
        .transition()
        .duration(250)
        .attr("d", () => {
          const o = { x: source.x, y: source.y };
          return diagonal({ source: o, target: o });
        })
        .remove();

      // Stash old positions
      root.eachBefore((d) => {
        d.x0 = d.x;
        d.y0 = d.y;
      });
    }

    // Initial positions
    root.x0 = 0;
    root.y0 = 0;
    update(root);

    // Cleanup on unmount / diagnosis change
    return () => {
      svg.remove();
    };
  }, [diagnosis]);

  if (!diagnosis) return null;

  return (
    <div className="sc-tree-shell">
      <div className="sc-tree-caption">
        Symptoms converging on{" "}
        <span className="sc-tree-caption-name">{diagnosis.name}</span>
      </div>
      <div ref={containerRef} className="sc-tree-container" />
    </div>
  );
}
