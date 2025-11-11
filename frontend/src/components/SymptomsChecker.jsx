/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-unused-vars */
import React, { useEffect, useState, useRef } from "react";
import * as d3 from "d3";
import "../styles/symptoms-checker.css";

export default function SymptomsChecker({ sessionId, transcript, backendBase }) {
  const [loading, setLoading] = useState(false);
  const [diagnoses, setDiagnoses] = useState([]);
  const [openId, setOpenId] = useState(null); // accordion / active diagnosis
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({}); // { [diagId]: { [questionId]: "yes"|"no"|"unsure" } }
  const [refining, setRefining] = useState(false);

  // Reset when session changes (new case)
  useEffect(() => {
    setDiagnoses([]);
    setOpenId(null);
    setAnswers({});
    setError("");
    setLoading(false);
    setRefining(false);
  }, [sessionId]);

  // Auto-start triage as soon as transcript is ready
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
      const diags = data.diagnoses || [];
      setDiagnoses(diags);
      setOpenId(diags[0]?.id || null);
    } catch (e) {
      setError(e.message || "Failed to analyze symptoms.");
    } finally {
      setLoading(false);
    }
  };

  // Flatten answers for all diagnoses and send to backend
  const refine = async () => {
    if (!transcript || !transcript.trim()) return;
    setRefining(true);
    setError("");

    const flatAnswers = Object.entries(answers).flatMap(
      ([diagId, diagAnswers]) =>
        Object.entries(diagAnswers).map(([question_id, answer]) => ({
          question_id,
          answer,
        }))
    );

    try {
      const res = await fetch(`${backendBase}/api/symptoms/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          transcript,
          answers: flatAnswers,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Refine failed");
      const diags = data.diagnoses || [];
      setDiagnoses(diags);
      setOpenId(diags[0]?.id || null);
      // clear answers after a new pass
      setAnswers({});
    } catch (e) {
      setError(e.message || "Failed to refine diagnosis.");
    } finally {
      setRefining(false);
    }
  };

  const handleAnswerChange = (diagId, questionId, value) => {
    setAnswers((prev) => ({
      ...prev,
      [diagId]: {
        ...(prev[diagId] || {}),
        [questionId]: value,
      },
    }));
  };

  return (
    <div className="sc-root">
      <div className="sc-header">
        <h2 className="sc-title">Symptoms Checker</h2>
        <p className="sc-subtitle">
          Based on this consultation, here are the possible conditions and how
          the symptoms relate.
        </p>
      </div>

      {error && <div className="sc-error">{error}</div>}

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

      {/* Accordion of diagnoses */}
      <div className="sc-diag-stack">
        {diagnoses.map((diag) => {
          const diagAnswers = answers[diag.id] || {};
          const questions = diag.questions || [];

          const firstUnansweredIndex = questions.findIndex(
            (q) => !diagAnswers[q.id]
          );
          const visibleQuestions =
            firstUnansweredIndex === -1
              ? questions
              : questions.slice(0, firstUnansweredIndex + 1);

          const allAnswered =
            questions.length > 0 &&
            questions.every((q) => Boolean(diagAnswers[q.id]));

          const likelihoodPct = Math.round(
            (diag.likelihood_score || 0) * 100
          );

          const isOpen = openId === diag.id;

          return (
            <div
              key={diag.id}
              className={`sc-diag-item ${isOpen ? "open" : ""}`}
            >
              <button
                className="sc-diag-header"
                onClick={() =>
                  setOpenId((prev) => (prev === diag.id ? null : diag.id))
                }
              >
                <div className="sc-diag-header-main">
                  <div className="sc-diag-name">{diag.name}</div>
                  <div className="sc-diag-chip">
                    {likelihoodPct}% likelihood
                  </div>
                </div>
                {diag.likelihood_text && (
                  <div className="sc-diag-header-sub">
                    {diag.likelihood_text}
                  </div>
                )}
                <div className={`sc-chevron ${isOpen ? "open" : ""}`} />
              </button>

              <AnimateHeight open={isOpen}>
                <div className="sc-card">
                  {/* short description */}
                  {diag.short_description && (
                    <p className="sc-desc">{diag.short_description}</p>
                  )}

                  {/* “6 out of 10 people…” style row */}
                  <PeopleRow likelihoodPct={likelihoodPct} />

                  {/* Read more */}
                  {(diag.long_description || diag.source) && (
                    <details className="sc-readmore">
                      <summary>Read more</summary>
                      {diag.long_description && (
                        <p>{diag.long_description}</p>
                      )}
                      {diag.source && (
                        <p className="sc-source">
                          Source:{" "}
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
                  )}

                  {/* D3 tree – rectangles, collapsible, root on left */}
                  <SymptomTreeRectangles diagnosis={diag} />

                  {/* Follow-up questions – revealed one by one */}
                  {questions.length > 0 && (
                    <div className="sc-questions">
                      <h4>Follow-up questions</h4>
                      {visibleQuestions.map((q) => (
                        <div key={q.id} className="sc-q">
                          <span>{q.text}</span>
                          <div className="sc-buttons">
                            {["yes", "no", "unsure"].map((a) => (
                              <button
                                key={a}
                                className={
                                  diagAnswers[q.id] === a ? "active" : ""
                                }
                                onClick={() =>
                                  handleAnswerChange(diag.id, q.id, a)
                                }
                              >
                                {a}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}

                      {!allAnswered && (
                        <div className="sc-q-all">
                          Answer the questions above to unlock the update
                          button.
                        </div>
                      )}

                      <button
                        className="sc-refine"
                        disabled={!allAnswered || refining}
                        onClick={refine}
                      >
                        {refining ? "Updating diagnosis…" : "Update diagnosis"}
                      </button>
                    </div>
                  )}
                </div>
              </AnimateHeight>
            </div>
          );
        })}
      </div>

      {/* Bottom segmented probability bar */}
      {diagnoses.length > 0 && (
        <div className="sc-piechart">
          {diagnoses.map((d) => (
            <div
              key={d.id}
              className={`sc-slice ${openId === d.id ? "active" : ""}`}
              style={{
                flex: Math.max(d.likelihood_score || 0.05, 0.05),
                backgroundColor: `hsl(${Math.round(
                  (d.likelihood_score || 0) * 140
                )},70%,50%)`,
              }}
              onClick={() =>
                setOpenId((prev) => (prev === d.id ? null : d.id))
              }
            >
              <span>{d.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Small helper for smooth open/close ---------- */

function AnimateHeight({ open, children }) {
  const ref = useRef(null);
  const [style, setStyle] = useState({ height: open ? "auto" : 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      const prev = el.getBoundingClientRect().height;
      el.style.height = prev + "px";
      requestAnimationFrame(() => {
        el.style.height = "auto";
      });
      setStyle({ height: "auto" });
    } else {
      const prev = el.getBoundingClientRect().height;
      el.style.height = prev + "px";
      requestAnimationFrame(() => {
        el.style.height = "0px";
        setStyle({ height: 0 });
      });
    }
  }, [open]);

  return (
    <div
      ref={ref}
      style={{
        overflow: "hidden",
        transition: "height 0.25s ease",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------- People row (likelihood icons) ---------- */

function PeopleRow({ likelihoodPct }) {
  const total = 10;
  const activeCount = Math.round((likelihoodPct / 100) * total);
  return (
    <div className="sc-people-row">
      <div className="sc-people-label">
        <span>
          {activeCount} out of {total} people with these symptoms had this
          condition.
        </span>
        <span className="sc-people-percent">{likelihoodPct}%</span>
      </div>
      <div className="sc-people-icons">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={`sc-person ${
              i < activeCount ? "sc-person--active" : ""
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- D3 rectangles tree (diagnosis on left, symptoms on right) ---------- */

function SymptomTreeRectangles({ diagnosis }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!diagnosis) return;

    const rawSymptoms = Array.isArray(diagnosis.symptoms)
      ? diagnosis.symptoms
      : [];

    const mapSymptomNode = (s) => ({
      name: s.name,
      subname:
        typeof s.weight === "number"
          ? `${Math.round(s.weight * 100)}% contribution`
          : "",
      fill: "#4b5563",
      children: Array.isArray(s.children)
        ? s.children.map(mapSymptomNode)
        : undefined,
    });

    const data = {
      name: diagnosis.name,
      subname: "Diagnosis",
      fill: "#4f46e5",
      children: rawSymptoms.map(mapSymptomNode),
    };

    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";

    const margin = { top: 10, right: 60, bottom: 10, left: 80 };
    const fullWidth = 720;
    const rectWidth = 150;
    const rectHeight = 52;

    const root = d3.hierarchy(data, (d) => d.children);
    const treeLayout = d3
      .tree()
      .nodeSize([rectHeight + 18, rectWidth + 44]); // vertical, horizontal gaps

    root.x0 = 0;
    root.y0 = 0;

    // keep root open, collapse deeper levels initially
    root.descendants().forEach((d, i) => {
      d.id = i;
      d._children = d.children;
      if (d.depth > 1) d.children = null;
    });

    const svg = d3
      .select(container)
      .append("svg")
      .attr("class", "sc-tree-svg")
      .attr("width", "100%")
      .attr("viewBox", [0, 0, fullWidth, rectHeight + margin.top + margin.bottom]);

    const g = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const gLink = g.append("g").attr("class", "sc-tree-links");
    const gNode = g.append("g").attr("class", "sc-tree-nodes");

    const duration = 300;

    const diagonal = (s, d) => {
      return `M ${s.y} ${s.x}
              C ${(s.y + d.y) / 2} ${s.x},
                ${(s.y + d.y) / 2} ${d.x},
                ${d.y} ${d.x}`;
    };

    const update = (source) => {
      treeLayout(root);
      const nodes = root.descendants();
      const links = root.descendants().slice(1);

      // normalize depth so root stays at far left
      nodes.forEach((d) => {
        d.y = d.depth * (rectWidth + 44);
      });

      // compute dynamic height
      let minX = Infinity;
      let maxX = -Infinity;
      nodes.forEach((d) => {
        if (d.x < minX) minX = d.x;
        if (d.x > maxX) maxX = d.x;
      });
      const height =
        maxX - minX + rectHeight + margin.top + margin.bottom + 30;
      svg.attr("viewBox", [0, minX - margin.top, fullWidth, height]);

      // NODES
      const node = gNode
        .selectAll("g.sc-tree-node")
        .data(nodes, (d) => d.id);

      const nodeEnter = node
        .enter()
        .append("g")
        .attr("class", "sc-tree-node")
        .attr(
          "transform",
          () => `translate(${source.y0 || 0},${source.x0 || 0})`
        )
        .attr("fill-opacity", 0)
        .attr("stroke-opacity", 0)
        .on("click", (event, d) => {
          if (d.children) {
            d._children = d.children;
            d.children = null;
          } else if (d._children) {
            d.children = d._children;
            d._children = null;
          }
          update(d);
        });

      nodeEnter
        .append("rect")
        .attr("class", (d) =>
          d.depth === 0 ? "sc-tree-rect sc-tree-rect-root" : "sc-tree-rect"
        )
        .attr("x", -rectWidth / 2)
        .attr("y", -rectHeight / 2)
        .attr("width", rectWidth)
        .attr("height", rectHeight)
        .attr("rx", 8)
        .attr("ry", 8)
        .style("fill", (d) => d.data.fill || "#4b5563");

      const label = nodeEnter
        .append("text")
        .attr("class", "sc-tree-label-rect")
        .attr("x", -rectWidth / 2 + 10)
        .attr("y", -4);

      label.append("tspan").text((d) => d.data.name);

      label
        .append("tspan")
        .attr("x", -rectWidth / 2 + 10)
        .attr("dy", "1.4em")
        .attr("class", "sc-tree-label-sub")
        .text((d) => d.data.subname || "");

      const nodeUpdate = nodeEnter
        .merge(node)
        .transition()
        .duration(duration)
        .attr("transform", (d) => `translate(${d.y},${d.x})`)
        .attr("fill-opacity", 1)
        .attr("stroke-opacity", 1);

      const nodeExit = node
        .exit()
        .transition()
        .duration(duration)
        .attr(
          "transform",
          () => `translate(${source.y || 0},${source.x || 0})`
        )
        .attr("fill-opacity", 0)
        .attr("stroke-opacity", 0)
        .remove();

      nodeExit.select("rect").attr("width", 1e-6);

      // LINKS
      const link = gLink
        .selectAll("path.sc-tree-link")
        .data(links, (d) => d.id);

      const linkEnter = link
        .enter()
        .insert("path", "g")
        .attr("class", "sc-tree-link")
        .attr("d", () => {
          const o = { x: source.x0 || 0, y: source.y0 || 0 };
          return diagonal(o, o);
        });

      linkEnter
        .merge(link)
        .transition()
        .duration(duration)
        .attr("d", (d) => diagonal(d, d.parent));

      link
        .exit()
        .transition()
        .duration(duration)
        .attr("d", () => {
          const o = { x: source.x || 0, y: source.y || 0 };
          return diagonal(o, o);
        })
        .remove();

      // stash old positions
      root.each((d) => {
        d.x0 = d.x;
        d.y0 = d.y;
      });
    };

    update(root);

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
