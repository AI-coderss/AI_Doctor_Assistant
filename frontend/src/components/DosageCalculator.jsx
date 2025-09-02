import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import useDosageStore from "../store/dosageStore";
import "../styles/DosageCalculator.css";

const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const STREAM_URL = `${API_BASE}/calculate-dosage-stream`;
const NON_STREAM_URL = `${API_BASE}/calculate-dosage`;

const DRUGS = [
  "Amoxicillin","Paracetamol","Ibuprofen","Ceftriaxone","Azithromycin","Metformin","Omeprazole",
];

function extractJsonDict(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    const candidate = m[0];
    try { return JSON.parse(candidate); } catch (_) {
      try {
        const fixed = candidate
          .replace(/(\w+)\s*:/g, '"$1":')
          .replace(/,\s*}/g, "}");
        return JSON.parse(fixed);
      } catch (_) {}
    }
  }
  return null;
}

const DosageCalculator = () => {
  const {
    isOpen, inputs, results, loading, error,
    toggleOpen, setInput, setInputs, setResults,
    setLoading, setError, resetResults
  } = useDosageStore();

  const [useStream, setUseStream] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);
  const screenRef = useRef(null);

  if (!isOpen) return null;

  const validate = () => {
    const age = Number(inputs.age);
    const weight = Number(inputs.weight);
    if (!inputs.drug) return "Please select or enter a valid drug.";
    if (!age || age <= 0) return "Age must be a positive number.";
    if (!weight || weight <= 0) return "Weight must be a positive number.";
    if (!inputs.condition?.trim()) return "Please enter the condition.";
    return null;
  };

  const handleCalculate = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setLoading(true);
    resetResults();
    setStreamText("");
    setCopied(false);

    if (useStream && "ReadableStream" in window) {
      await runStreaming();
    } else {
      await runNonStream();
    }
  };

  const runNonStream = async () => {
    try {
      const res = await fetch(NON_STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug: inputs.drug,
          age: Number(inputs.age),
          weight: Number(inputs.weight),
          condition: inputs.condition,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResults({
        dosage: data?.dosage || "",
        regimen: data?.regimen || "",
        notes: data?.notes || "",
      });
      requestAnimationFrame(() => screenRef.current?.scrollTo?.({ top: 0, behavior: "smooth" }));
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const runStreaming = async () => {
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch(STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug: inputs.drug,
          age: Number(inputs.age),
          weight: Number(inputs.weight),
          condition: inputs.condition,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) { await runNonStream(); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;
        setStreamText((prev) => (prev + chunk).slice(-5000));
      }

      const parsed = extractJsonDict(acc);
      if (!parsed) {
        setError("The model did not return valid JSON.");
      } else {
        setResults({
          dosage: String(parsed.dosage || "").trim(),
          regimen: String(parsed.regimen || "").trim(),
          notes: String(parsed.notes || "").trim(),
        });
        if (!parsed.dosage || !parsed.regimen) {
          setError("Incomplete dosage JSON from model.");
        }
        requestAnimationFrame(() => screenRef.current?.scrollTo?.({ top: 0, behavior: "smooth" }));
      }
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message || "Streaming failed. Please try again.");
    } finally {
      setStreaming(false);
      setLoading(false);
    }
  };

  const handleClose = () => {
    try { abortRef.current?.abort(); } catch (_) {}
    toggleOpen(false);
  };

  const handleClear = () => {
    setInputs({ drug: "", age: "", weight: "", condition: "" });
    resetResults();
    setError(null);
    setStreamText("");
    setCopied(false);
  };

  const copyResult = async () => {
    const text =
      `Dosage: ${results.dosage || "-"}\n` +
      `Regimen: ${results.regimen || "-"}\n` +
      `Notes: ${results.notes || "-"}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  };

  const hasResult = results.dosage || results.regimen || results.notes;

  return createPortal(
    <motion.div
      className="dosage-calculator"
      initial={{ opacity: 0, scale: 0.96, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 6 }}
      drag
      dragMomentum={false}
      dragElastic={0.12}
      role="dialog"
      aria-modal="true"
      aria-label="Dosage Calculator"
    >
      {/* Header (drag handle) */}
      <div className="dc-header" data-drag-handle>
        <div className="dc-title">Dosage Calculator</div>
        <div className="dc-actions">
          <button
            className="dc-icon-btn"
            onClick={() => setUseStream(v => !v)}
            title={useStream ? "Streaming ON" : "Streaming OFF"}
            aria-pressed={useStream}
          >
            {useStream ? "Stream: ON" : "Stream: OFF"}
          </button>
          <button className="dc-icon-btn" onClick={handleClear} title="Clear fields">Clear</button>
          <button className="dc-icon-btn" onClick={handleClose} title="Close">Close</button>
        </div>
      </div>

      {/* SCREEN (live stream / final) */}
      <div ref={screenRef} className="dc-screen" aria-live="polite">
        {hasResult ? (
          <div className="dc-screen-result">
            <div className="dc-screen-line"><strong>Dosage:</strong> {results.dosage}</div>
            <div className="dc-screen-line"><strong>Regimen:</strong> {results.regimen}</div>
            {results.notes && <div className="dc-screen-line"><strong>Notes:</strong> {results.notes}</div>}
          </div>
        ) : (
          <pre className="dc-screen-stream">
            {(streaming && (streamText || "…streaming…")) || "Enter details and press Calculate"}
          </pre>
        )}
      </div>

      {/* Body */}
      <div className="dc-body">
        {error && <div className="dc-callout dc-error">⚠️ {error}</div>}

        {/* Inputs */}
        <div className="dc-grid">
          <div className="dc-field">
            <label className="dc-label" htmlFor="drug">Drug</label>
            <input
              id="drug"
              className="dc-input"
              list="drug-list"
              placeholder="Select or type a drug"
              value={inputs.drug}
              onChange={(e) => setInput("drug", e.target.value)}
            />
            <datalist id="drug-list">
              {DRUGS.map((d) => <option key={d} value={d}>{d}</option>)}
            </datalist>
          </div>

          <div className="dc-field">
            <label className="dc-label" htmlFor="age">Age (years)</label>
            <input
              id="age"
              className="dc-input"
              type="number"
              min="0"
              step="1"
              placeholder="e.g. 45"
              value={inputs.age}
              onChange={(e) => setInput("age", e.target.value)}
            />
          </div>

          <div className="dc-field">
            <label className="dc-label" htmlFor="weight">Weight (kg)</label>
            <input
              id="weight"
              className="dc-input"
              type="number"
              min="0"
              step="0.1"
              placeholder="e.g. 70"
              value={inputs.weight}
              onChange={(e) => setInput("weight", e.target.value)}
            />
          </div>

          <div className="dc-field" style={{ gridColumn: "1 / -1" }}>
            <label className="dc-label" htmlFor="condition">Condition</label>
            <textarea
              id="condition"
              className="dc-textarea"
              placeholder="e.g. Respiratory infection..."
              value={inputs.condition}
              onChange={(e) => setInput("condition", e.target.value)}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="dc-footer">
          <button
            className="dc-btn-primary"
            onClick={handleCalculate}
            disabled={loading || streaming}
          >
            {streaming ? "Streaming..." : loading ? "Calculating..." : "Calculate"}
          </button>

          {hasResult && (
            <button className="dc-btn-secondary" onClick={copyResult} title="Copy result">
              {copied ? "Copied!" : "Copy"}
            </button>
          )}

          <span className="dc-disclaimer">
            ⚠️ Supports clinical decision-making; final prescribing responsibility lies with the physician.
          </span>
        </div>
      </div>
    </motion.div>,
    document.body
  );
};

export default DosageCalculator;
