import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/DosageCalculator.css";

/**
 * Classic calculator UI (NOT fixed). Glassmorphic, compact height,
 * LCD-like screen where streamed text appears. Condition is taken from context
 * (no manual entry). Drug suggestions are dynamic from backend.
 */

const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const URLS = {
  contextGet: (sid) => `${API_BASE}/context?session_id=${encodeURIComponent(sid)}`,
  suggestDrugs: `${API_BASE}/suggest-drugs`,
  calcStream: `${API_BASE}/calculate-dosage-stream`,
  calc: `${API_BASE}/calculate-dosage`,
};

const KEYPAD = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0", ".", "AC"],
];

export default function DosageCalculator({ onClose }) {
  const [sessionId] = useState(() =>
    (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );

  // Context-driven values (condition cannot be entered manually)
  const [condition, setCondition] = useState("");
  const [drugSuggestions, setDrugSuggestions] = useState([]);

  // Inputs
  const [drug, setDrug] = useState("");
  const [age, setAge] = useState("");       // keypad-friendly text
  const [weight, setWeight] = useState(""); // keypad-friendly text

  // UI state
  const [useStream, setUseStream] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [screenText, setScreenText] = useState("0");
  const [error, setError] = useState(null);
  const [results, setResults] = useState({ dosage: "", regimen: "", notes: "" });
  const [activeField, setActiveField] = useState("age"); // "age" | "weight"
  const abortRef = useRef(null);

  // Load context on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(URLS.contextGet(sessionId));
        const j = await r.json();
        if (!cancelled && j && j.exists) {
          if (j.condition) setCondition(j.condition);
          if (j.age_years != null) setAge(String(j.age_years));
          if (j.weight_kg != null) setWeight(String(j.weight_kg));
          if (Array.isArray(j.drug_suggestions) && j.drug_suggestions.length) {
            setDrugSuggestions(j.drug_suggestions);
            setDrug(prev => prev || j.drug_suggestions[0]);
          }
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If condition appears later (e.g., context arrives), refresh suggestions
  useEffect(() => {
    const c = (condition || "").trim();
    if (!c) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(URLS.suggestDrugs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, condition: c }),
        });
        const j = await r.json();
        if (!cancelled && Array.isArray(j.drugs)) {
          setDrugSuggestions(j.drugs);
          setDrug(prev => prev || j.drugs[0] || "");
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condition]);

  const validate = () => {
    if (!drug) return "Please select or enter a valid drug.";
    const ageNum = age === "" ? null : Number(age);
    const weightNum = weight === "" ? null : Number(weight);
    if (ageNum !== null && (!ageNum || ageNum <= 0)) return "Age must be a positive number.";
    if (weightNum !== null && (!weightNum || weightNum <= 0)) return "Weight must be a positive number.";
    return null;
  };

  const extractJsonDict = (text) => {
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
  };

  const handleCalculate = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setLoading(true);
    setResults({ dosage: "", regimen: "", notes: "" });
    setScreenText("…");

    if (useStream && "ReadableStream" in window) await runStreaming();
    else await runNonStream();
  };

  const runNonStream = async () => {
    try {
      const res = await fetch(URLS.calc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          drug,
          age: age === "" ? null : Number(age),
          weight: weight === "" ? null : Number(weight),
          condition: condition || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResults({
        dosage: data?.dosage || "",
        regimen: data?.regimen || "",
        notes: data?.notes || "",
      });
      setScreenText(data?.dosage ? data.dosage : "0");
    } catch (e) {
      setError(e.message || "Something went wrong.");
      setScreenText("Err");
    } finally {
      setLoading(false);
    }
  };

  const runStreaming = async () => {
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      const res = await fetch(URLS.calcStream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          drug,
          age: age === "" ? null : Number(age),
          weight: weight === "" ? null : Number(weight),
          condition: condition || null,
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
        // Show a short tail of the stream in the "LCD" screen only
        setScreenText(acc.slice(-28)); // tight, single-line feel
      }

      const parsed = extractJsonDict(acc);
      if (!parsed) {
        setError("The model did not return valid JSON.");
        setScreenText("Err");
      } else {
        setResults({
          dosage: String(parsed.dosage || "").trim(),
          regimen: String(parsed.regimen || "").trim(),
          notes: String(parsed.notes || "").trim(),
        });
        setScreenText(parsed.dosage || "0");
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message || "Streaming failed.");
        setScreenText("Err");
      }
    } finally {
      setStreaming(false);
      setLoading(false);
    }
  };

  const onKey = (k) => {
    const setFn = activeField === "age" ? setAge : setWeight;
    const val = activeField === "age" ? age : weight;
    if (k === "AC") { setFn(""); setScreenText("0"); return; }
    if (k === "." && String(val).includes(".")) return;
    const next = String(val || "") + k;
    setFn(next);
    setScreenText(next.length ? next : "0");
  };

  const canCalculate = !loading && !streaming && !!drug;

  const suggestionOptions = useMemo(
    () => (drugSuggestions || []).slice(0, 12),
    [drugSuggestions]
  );

  return (
    <motion.div
      className="dosage-calculator"
      initial={{ opacity: 0, scale: 0.98, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      drag
      dragMomentum={false}
      dragElastic={0.06}
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
            aria-pressed={useStream}
            title={useStream ? "Streaming ON" : "Streaming OFF"}
          >
            {useStream ? "Stream: ON" : "Stream: OFF"}
          </button>
          <button
            className="dc-icon-btn"
            onClick={() => { setAge(""); setWeight(""); setScreenText("0"); }}
            title="All Clear"
          >
            AC
          </button>
          <button
            className="dc-icon-btn"
            onClick={() => { try { abortRef.current?.abort(); } catch {} onClose?.(); }}
            title="Close"
          >
            Close
          </button>
        </div>
      </div>

      {/* LCD-like calculator SCREEN (single-line, right aligned) */}
      <div className="dc-screen" aria-live="polite">
        {screenText}
      </div>

      {/* Context badge (read-only condition) */}
      <div className="dc-badges">
        <span className="dc-badge" title="Condition from context">
          Condition: {condition || "—"}
        </span>
      </div>

      {/* Body */}
      <div className="dc-body">
        {error && <div className="dc-callout dc-error">⚠️ {error}</div>}

        <div className="dc-grid">
          {/* Drug (dynamic suggestions) */}
          <div className="dc-field" style={{ gridColumn: "1 / -1" }}>
            <label className="dc-label" htmlFor="drug">Drug</label>
            <input
              id="drug"
              className="dc-input"
              list="drug-suggestions"
              placeholder="Select or type suggested drug"
              value={drug}
              onChange={(e) => setDrug(e.target.value)}
            />
            <datalist id="drug-suggestions">
              {suggestionOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </datalist>
          </div>

          {/* Age / Weight */}
          <div className="dc-field">
            <label className="dc-label" htmlFor="age">Age (years)</label>
            <input
              id="age"
              className={`dc-input ${activeField === "age" ? "dc-focus" : ""}`}
              type="text"
              inputMode="decimal"
              placeholder="e.g. 45"
              value={age}
              onFocus={() => setActiveField("age")}
              onChange={(e) => setAge(e.target.value.replace(/[^\d.]/g, ""))}
            />
          </div>

          <div className="dc-field">
            <label className="dc-label" htmlFor="weight">Weight (kg)</label>
            <input
              id="weight"
              className={`dc-input ${activeField === "weight" ? "dc-focus" : ""}`}
              type="text"
              inputMode="decimal"
              placeholder="e.g. 70"
              value={weight}
              onFocus={() => setActiveField("weight")}
              onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ""))}
            />
          </div>
        </div>

        {/* Calculator keypad (compact height, 3D-ish keys) */}
        <div className="dc-keypad">
          {KEYPAD.map((row, idx) => (
            <div className="dc-keypad-row" key={idx}>
              {row.map((k) => (
                <button
                  key={k}
                  className={`dc-key ${k === "AC" ? "danger" : ""}`}
                  onClick={() => onKey(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          ))}
          <div className="dc-keypad-row">
            <button
              className="dc-btn-primary wide"
              onClick={handleCalculate}
              disabled={!canCalculate}
            >
              {streaming ? "Streaming…" : loading ? "Calculating…" : "Calculate"}
            </button>
          </div>
        </div>

        {/* Results (compact) */}
        {(results.dosage || results.regimen || results.notes) && (
          <div className="dc-callout dc-success" aria-live="polite">
            {results.dosage && <p><strong>Dosage:</strong> {results.dosage}</p>}
            {results.regimen && <p><strong>Regimen:</strong> {results.regimen}</p>}
            {results.notes && <p><strong>Notes:</strong> {results.notes}</p>}
          </div>
        )}
      </div>
    </motion.div>
  );
}
