/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/DosageCalculator.css";
import useDosageStore from "../store/dosageStore";

const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const URLS = {
  contextEnsure: `${API_BASE}/context-ensure`,
  suggestDrugs: `${API_BASE}/suggest-drugs`,
  calcStream: `${API_BASE}/calculate-dosage-stream-with-context`,
  calc: `${API_BASE}/calculate-dosage-with-context`,
};

const KEYPAD = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0", ".", "AC"],
];

export default function DosageCalculator({ onClose }) {
  const {
    sessionId,
    transcript,
    inputs,
    setInputs,
    results,
    setResults,
    loading,
    setLoading,
    error,
    setError,
  } = useDosageStore();

  const [drugSuggestions, setDrugSuggestions] = useState([]);
  const [useStream, setUseStream] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [screenText, setScreenText] = useState("0");
  const [activeField, setActiveField] = useState("age");
  const abortRef = useRef(null);

  // Fetch context (triggered once calculator is opened)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(URLS.contextEnsure, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, transcript }),
        });
        const j = await res.json();
        if (!cancelled && j && j.success) {
          const ctx = j.context || {};
          setInputs({
            drug: inputs.drug || (ctx.drug_suggestions?.[0] || ""),
            age: ctx.age_years ? String(ctx.age_years) : inputs.age,
            weight: ctx.weight_kg ? String(ctx.weight_kg) : inputs.weight,
            condition: ctx.condition || inputs.condition,
          });
          setDrugSuggestions(ctx.drug_suggestions || []);
        }
      } catch (e) {
        console.error("Context fetch failed:", e);
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, transcript]); // run when calculator mounts

  // Validation
  const validate = () => {
    if (!inputs.drug) return "Please select or enter a valid drug.";
    const ageNum = inputs.age === "" ? null : Number(inputs.age);
    const weightNum = inputs.weight === "" ? null : Number(inputs.weight);
    if (ageNum !== null && (!ageNum || ageNum <= 0)) return "Age must be positive.";
    if (weightNum !== null && (!weightNum || weightNum <= 0)) return "Weight must be positive.";
    return null;
  };

  const extractJsonDict = (text) => {
    if (!text) return null;
    const cleaned = text.replace(/```json|```/gi, "").trim();
    try { return JSON.parse(cleaned); } catch (_) {}
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) {}
    }
    return null;
  };

  // Handle Calculate click
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
          drug: inputs.drug,
          age: inputs.age === "" ? null : Number(inputs.age),
          weight: inputs.weight === "" ? null : Number(inputs.weight),
          condition: inputs.condition || null,
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
      setError(e.message || "Error calculating dosage.");
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
          drug: inputs.drug,
          age: inputs.age === "" ? null : Number(inputs.age),
          weight: inputs.weight === "" ? null : Number(inputs.weight),
          condition: inputs.condition || null,
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
        acc += decoder.decode(value, { stream: true });
        setScreenText(acc.slice(-28));
      }

      const parsed = extractJsonDict(acc);
      if (parsed) {
        setResults({
          dosage: parsed.dosage || "",
          regimen: parsed.regimen || "",
          notes: parsed.notes || "",
        });
        setScreenText(parsed.dosage || "0");
      } else {
        setError("Invalid JSON response.");
        setScreenText("Err");
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

  // Keypad handler
  const onKey = (k) => {
    const field = activeField === "age" ? "age" : "weight";
    const val = inputs[field] || "";
    if (k === "AC") {
      setInputs({ ...inputs, [field]: "" });
      setScreenText("0");
      return;
    }
    if (k === "." && val.includes(".")) return;
    const next = val + k;
    setInputs({ ...inputs, [field]: next });
    setScreenText(next || "0");
  };

  const canCalculate = !loading && !streaming && !!inputs.drug;
  const suggestionOptions = useMemo(
    () => (drugSuggestions || []).slice(0, 12),
    [drugSuggestions]
  );

  return (
    <motion.div className="dosage-calculator" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="dc-header">
        <div className="dc-title">Dosage Calculator</div>
        <div className="dc-actions">
          <button onClick={() => setUseStream(!useStream)} className="dc-icon-btn">
            {useStream ? "Stream: ON" : "Stream: OFF"}
          </button>
          <button onClick={() => { setInputs({ ...inputs, age: "", weight: "" }); setScreenText("0"); }} className="dc-icon-btn">
            AC
          </button>
          <button onClick={() => { try { abortRef.current?.abort(); } catch {} onClose?.(); }} className="dc-icon-btn">
            Close
          </button>
        </div>
      </div>

      <div className="dc-screen">{screenText}</div>

      <div className="dc-badges">
        <span className="dc-badge">Condition: {inputs.condition || "—"}</span>
      </div>

      <div className="dc-body">
        {error && <div className="dc-callout dc-error">⚠️ {error}</div>}

        <div className="dc-grid">
          <div className="dc-field" style={{ gridColumn: "1 / -1" }}>
            <label className="dc-label" htmlFor="drug">Drug</label>
            <input
              id="drug"
              className="dc-input"
              list="drug-suggestions"
              placeholder="Select or type a drug"
              value={inputs.drug}
              onChange={(e) => setInputs({ ...inputs, drug: e.target.value })}
            />
            <datalist id="drug-suggestions">
              {suggestionOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </datalist>
          </div>

          <div className="dc-field">
            <label className="dc-label" htmlFor="age">Age</label>
            <input
              id="age"
              className="dc-input"
              type="text"
              inputMode="decimal"
              value={inputs.age}
              onFocus={() => setActiveField("age")}
              onChange={(e) => setInputs({ ...inputs, age: e.target.value })}
            />
          </div>

          <div className="dc-field">
            <label className="dc-label" htmlFor="weight">Weight</label>
            <input
              id="weight"
              className="dc-input"
              type="text"
              inputMode="decimal"
              value={inputs.weight}
              onFocus={() => setActiveField("weight")}
              onChange={(e) => setInputs({ ...inputs, weight: e.target.value })}
            />
          </div>
        </div>

        <div className="dc-keypad">
          {KEYPAD.map((row, idx) => (
            <div className="dc-keypad-row" key={idx}>
              {row.map((k) => (
                <button key={k} className={`dc-key ${k === "AC" ? "danger" : ""}`} onClick={() => onKey(k)}>
                  {k}
                </button>
              ))}
            </div>
          ))}
          <div className="dc-keypad-row">
            <button className="dc-btn-primary wide" onClick={handleCalculate} disabled={!canCalculate}>
              {streaming ? "Streaming…" : loading ? "Calculating…" : "Calculate"}
            </button>
          </div>
        </div>

        {(results.dosage || results.regimen || results.notes) && (
          <div className="dc-callout dc-success">
            {results.dosage && <p><strong>Dosage:</strong> {results.dosage}</p>}
            {results.regimen && <p><strong>Regimen:</strong> {results.regimen}</p>}
            {results.notes && <p><strong>Notes:</strong> {results.notes}</p>}
          </div>
        )}
      </div>
    </motion.div>
  );
}
