/* eslint-disable no-unused-vars */
import React, { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/DosageCalculator.css";
import useDosageStore from "../store/dosageStore";

/**
 * Classic calculator UI (NOT fixed). Glassmorphic, compact height,
 * LCD-like screen where streamed text appears.
 * Condition is extracted by the backend (no manual entry).
 * Drug suggestions come from backend based on extracted condition.
 *
 * Trigger model:
 *  - Pressing "Calculate" will:
 *      1) send transcript to backend + strict extract context (store)
 *      2) prefill condition/age/weight/drug suggestions from store
 *      3) call /calculate-dosage-(stream)-with-context
 */

const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const URLS = {
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
  // === Store wiring ===
  const {
    sessionId: storeSessionId,
    setSessionId,
    transcript: storeTranscript,
    prepareForCalculation,          // <-- from updated store
    inputs: storeInputs,            // { drug, age, weight, condition }
    context: storeContext,          // { drug_suggestions, ... }
  } = useDosageStore?.() || {};

  // Ensure a session id (persist it in store if available)
  const [sessionId] = useState(() => {
    const existing = storeSessionId;
    const gen =
      existing ||
      ((typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    if (!existing && typeof setSessionId === "function") setSessionId(gen);
    return gen;
  });

  const transcript = (storeTranscript || "").trim();

  // === Local UI state (mirrors store inputs, filled on demand) ===
  const [condition, setCondition] = useState("");
  const [drugSuggestions, setDrugSuggestions] = useState([]);
  const [drug, setDrug] = useState("");
  const [age, setAge] = useState("");       // keypad-friendly text
  const [weight, setWeight] = useState(""); // keypad-friendly text

  const [useStream, setUseStream] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [screenText, setScreenText] = useState("0");
  const [error, setError] = useState(null);
  const [results, setResults] = useState({ dosage: "", regimen: "", notes: "" });
  const [activeField, setActiveField] = useState("age");
  const abortRef = useRef(null);

  // ---------- Helpers ----------
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

  const handle400Error = async (res) => {
    try {
      const txt = await res.text();
      const data = JSON.parse(txt);
      const missing = Array.isArray(data?.missing) ? data.missing.join(", ") : null;
      const detail = missing ? `Missing: ${missing}` : (data?.error || txt);
      setError(detail || "Bad Request");
      setScreenText("Err");
    } catch {
      setError("Bad Request");
      setScreenText("Err");
    }
  };

  const suggestionOptions = useMemo(
    () => (drugSuggestions || []).slice(0, 12),
    [drugSuggestions]
  );

  /**
   * Pulls prepared data from the store into the calculator's local UI
   * WITHOUT clobbering what the user already typed here.
   */
  const syncFromStoreToLocal = () => {
    const sInputs = storeInputs || {};
    const sCtx = storeContext || {};

    if (!condition && sInputs.condition) setCondition(String(sInputs.condition));
    if (!age && sInputs.age !== "" && sInputs.age != null) setAge(String(sInputs.age));
    if (!weight && sInputs.weight !== "" && sInputs.weight != null) setWeight(String(sInputs.weight));

    const sugg = Array.isArray(sCtx.drug_suggestions) ? sCtx.drug_suggestions : [];
    if (!drugSuggestions.length && sugg.length) setDrugSuggestions(sugg);

    const candidateDrug = sInputs.drug || (sugg.length ? sugg[0] : "");
    if (!drug && candidateDrug) setDrug(String(candidateDrug));
  };

  // ---------- PREP STEP on Calculate: use the STORE to ensure context & fill fields ----------
  const ensureContextAndPrefill = async () => {
    // 1) End-to-end preparation (sends transcript, ensures context, suggests drugs)
    if (typeof prepareForCalculation === "function") {
      await prepareForCalculation();
    }
    // 2) Copy prepared values from store into local UI
    syncFromStoreToLocal();
    return true;
  };

  // ---------- Validation ----------
  const validate = () => {
    const d = drug || (drugSuggestions?.[0] || "");
    if (!d) return "Please select or enter a valid drug.";
    const ageNum = age === "" ? null : Number(age);
    const weightNum = weight === "" ? null : Number(weight);
    if (ageNum !== null && (!ageNum || ageNum <= 0)) return "Age must be a positive number.";
    if (weightNum !== null && (!weightNum || weightNum <= 0)) return "Weight must be a positive number.";
    return null;
  };

  // ---------- Calculate (single trigger) ----------
  const handleCalculate = async () => {
    setError(null);
    setResults({ dosage: "", regimen: "", notes: "" });
    setScreenText("…");
    setLoading(true);

    try {
      // A) Prepare context and prefill fields from backend (strict, via store)
      await ensureContextAndPrefill();

      // B) Validate UI inputs after prefill
      const v = validate();
      if (v) { setError(v); setLoading(false); setScreenText("Err"); return; }

      // C) If drug was still empty, auto-pick first suggestion
      if (!drug && drugSuggestions?.length) setDrug(drugSuggestions[0]);

      // D) Run calculation (stream or not)
      if (useStream && "ReadableStream" in window) await runStreaming();
      else await runNonStream();
    } catch (e) {
      setError(e.message || "Something went wrong.");
      setScreenText("Err");
    } finally {
      setLoading(false);
    }
  };

  // ---------- Non-streaming ----------
  const runNonStream = async () => {
    const res = await fetch(URLS.calc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        drug: drug || (drugSuggestions?.[0] || ""),
        age: age === "" ? null : Number(age),
        weight: weight === "" ? null : Number(weight),
        condition: condition || null,
        transcript: transcript || null,
      }),
    });

    if (res.status === 400) return handle400Error(res);
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    setResults({
      dosage: data?.dosage || "",
      regimen: data?.regimen || "",
      notes: data?.notes || "",
    });
    setScreenText(data?.dosage ? data.dosage : "0");
  };

  // ---------- Streaming ----------
  const runStreaming = async () => {
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch(URLS.calcStream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          drug: drug || (drugSuggestions?.[0] || ""),
          age: age === "" ? null : Number(age),
          weight: weight === "" ? null : Number(weight),
          condition: condition || null,
          transcript: transcript || null,
        }),
        signal: abortRef.current.signal,
      });

      if (res.status === 400) { await handle400Error(res); return; }
      if (!res.ok || !res.body) { await runNonStream(); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;
        // Show only a short tail in the LCD screen
        setScreenText(acc.slice(-28));
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
    }
  };

  // ---------- Keypad ----------
  const onKey = (k) => {
    const setFn = activeField === "age" ? setAge : setWeight;
    const val = activeField === "age" ? age : weight;
    if (k === "AC") { setFn(""); setScreenText("0"); return; }
    if (k === "." && String(val).includes(".")) return;
    const next = String(val || "") + k;
    setFn(next);
    setScreenText(next.length ? next : "0");
  };

  const canCalculate = !loading && !streaming;

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
