import React, { useRef, useState, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/* ===========================
   Stable data (module scope)
   =========================== */
const DEPARTMENTS = [
  { group: "Primary Care", items: ["Family Medicine", "Internal Medicine", "General Practice", "Geriatrics"] },
  {
    group: "Medicine Subspecialties",
    items: [
      "Cardiology",
      "Cardiovascular Medicine",
      "Endocrinology",
      "Gastroenterology",
      "Hepatology",
      "Nephrology",
      "Pulmonology / Respiratory Medicine",
      "Rheumatology",
      "Infectious Diseases",
      "Hematology",
      "Medical Oncology",
      "Neurology",
      "Allergy & Immunology",
      "Sleep Medicine",
      "Sports Medicine",
      "Palliative Care",
      "Pain Medicine",
    ],
  },
  {
    group: "Surgery",
    items: [
      "General Surgery",
      "Cardiothoracic Surgery",
      "Vascular Surgery",
      "Neurosurgery",
      "Orthopedic Surgery",
      "Plastic & Reconstructive Surgery",
      "Colorectal Surgery",
      "Hepatobiliary Surgery",
      "Bariatric / Metabolic Surgery",
      "Urology",
      "Oral & Maxillofacial Surgery",
      "Trauma Surgery",
      "ENT (Otolaryngology)",
      "Ophthalmology",
    ],
  },
  {
    group: "Women & Children",
    items: [
      "Obstetrics & Gynecology (OB/GYN)",
      "Reproductive Endocrinology & Infertility (IVF)",
      "Maternal-Fetal Medicine",
      "Pediatrics",
      "Neonatology (NICU)",
      "Pediatric Surgery",
    ],
  },
  {
    group: "Diagnostics & Imaging",
    items: [
      "Radiology",
      "Interventional Radiology",
      "Nuclear Medicine",
      "Anatomical Pathology",
      "Clinical Pathology / Laboratory Medicine",
      "Transfusion Medicine / Blood Bank",
      "Medical Genetics / Genomic Medicine",
    ],
  },
  { group: "Critical Care & Emergency", items: ["Emergency Medicine", "Intensive Care / Critical Care", "Anesthesiology"] },
  {
    group: "Rehabilitation & Allied Health",
    items: [
      "Physical Medicine & Rehabilitation (PM&R)",
      "Physical Therapy",
      "Occupational Therapy",
      "Speech-Language Pathology",
      "Nutrition & Dietetics",
      "Pharmacy",
    ],
  },
  { group: "Behavioral Health", items: ["Psychiatry", "Psychology / Behavioral Health"] },
  {
    group: "Dentistry",
    items: [
      "General Dentistry",
      "Orthodontics",
      "Periodontics",
      "Prosthodontics",
      "Endodontics",
      "Pediatric Dentistry",
      "Dental Radiology",
      "Oral Surgery (Dentistry)",
    ],
  },
  { group: "Public Health & Admin", items: ["Infection Control", "Occupational Health", "Community Medicine / Public Health"] },
];

const FLAT_DEPTS = DEPARTMENTS.flatMap((g) => g.items.map((value) => ({ value, group: g.group })));

/* Utility */
const normalize = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/**
 * VoiceRecorderPanel — Left Dock (outside drawer, not draggable)
 * Original behavior preserved; enhancements layered on top only.
 */
const VoiceRecorderPanel = ({
  transcribeUrl = "/transcribe",
  opinionUrl = "/case_second_opinion_stream",
  fileFieldName = "audio_data",
  onOpinion,
  onTranscriptReady,
}) => {
  // Left dock visibility (portal into <body>)
  const [dockOpen, setDockOpen] = useState(false);

  // Center pop-up (glassmorphic) gate
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [caseMetaSubmitted, setCaseMetaSubmitted] = useState(false);
  const [caseMeta, setCaseMeta] = useState({
    patientName: "",
    fileNumber: "",
    age: "",
    department: "",
  });
  const [formErrors, setFormErrors] = useState({});

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Flow state
  const [loading, setLoading] = useState(false);
  const [isTranscriptReady, setIsTranscriptReady] = useState(false);

  // Transcript storage
  const transcriptRef = useRef("");

  // Session ID aligned with chat.jsx
  const [sessionId] = useState(() => {
    const id = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  });

  /* ================= TIMER (anti-flicker) ================= */
  const [elapsedMs, setElapsedMs] = useState(0);
  const intervalRef = useRef(null);
  const startAtRef = useRef(0);
  const pausedAccumRef = useRef(0);

  const pad2 = (n) => (n < 10 ? "0" + n : String(n));

  const getParts = (ms) => {
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    const HH = pad2(hh),
      MM = pad2(mm),
      SS = pad2(ss),
      CS = pad2(cs);
    return { HH, MM, SS, CS, aria: `${HH}:${MM}:${SS}:${CS}` };
  };

  const startInterval = () => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setElapsedMs(pausedAccumRef.current + (performance.now() - startAtRef.current));
    }, 50);
  };

  // Unmount cleanup without depending on closures
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  /* ================= Drawer coordination ================= */
  const closeDrawer = () => {
    try {
      window.dispatchEvent(new CustomEvent("tools:close"));
    } catch {}
  };

  /* ================= form validation ================= */
  const validateCaseMeta = () => {
    const errs = {};
    if (!caseMeta.patientName.trim()) errs.patientName = "Required";
    if (!caseMeta.fileNumber.trim()) errs.fileNumber = "Required";
    if (!caseMeta.age.trim()) errs.age = "Required";
    if (caseMeta.age && (Number.isNaN(+caseMeta.age) || +caseMeta.age <= 0)) errs.age = "Invalid";
    if (!caseMeta.department.trim()) errs.department = "Required";
    return errs;
  };

  /* ================= Controls ================= */
  const handleLauncherClick = () => {
    setDockOpen(true);
    setShowCaseForm(true); // open gate form
    closeDrawer();
  };

  const stopInterval = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const startRecording = () => {
    if (!caseMetaSubmitted) return; // UI already disables; keep guard
    transcriptRef.current = "";
    setIsPaused(false);
    setIsTranscriptReady(false);

    pausedAccumRef.current = 0;
    startAtRef.current = performance.now();
    setElapsedMs(0);
    startInterval();

    setIsRecording(true);
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    stopInterval();
  };

  const togglePauseResume = () => {
    if (!isRecording) return;
    if (isPaused) {
      startAtRef.current = performance.now();
      startInterval();
      setIsPaused(false);
    } else {
      stopInterval();
      pausedAccumRef.current = elapsedMs;
      setIsPaused(true);
    }
  };

  const resetRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    setIsTranscriptReady(false);
    transcriptRef.current = "";
    setElapsedMs(0);
    pausedAccumRef.current = 0;
    stopInterval();
  };

  /* ================= Upload after stop => transcribe ================= */
  const onStop = async (recordedBlob) => {
    try {
      if (!recordedBlob?.blob) return;
      const audioFile = new File([recordedBlob.blob], "temp.wav", { type: "audio/wav" });
      const form = new FormData();
      form.append(fileFieldName, audioFile);
      form.append("session_id", sessionId);

      // append meta
      form.append("patient_name", caseMeta.patientName);
      form.append("patient_file_number", caseMeta.fileNumber);
      form.append("patient_age", caseMeta.age);
      form.append("patient_department", caseMeta.department);

      setLoading(true);
      const { data } = await axios.post(transcribeUrl, form, {
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: false,
      });

      const txt = String(data?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = Boolean(txt);
      setIsTranscriptReady(ready);
      if (ready && typeof onTranscriptReady === "function") onTranscriptReady(txt);
    } catch (err) {
      console.error("Transcription error:", err);
      setIsTranscriptReady(false);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Analyze Case (stream to chat) ================= */
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;
    closeDrawer();

    const payload = { context: transcriptRef.current, session_id: sessionId, meta: caseMeta };
    try {
      setLoading(true);
      const resp = await fetch(opinionUrl, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!resp.ok) {
        console.error("Stream request failed:", resp.status, resp.statusText);
        setLoading(false);
        return;
      }
      if (!resp.body) {
        const text = await resp.text();
        if (typeof onOpinion === "function") onOpinion(text, true);
        setLoading(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false,
        aggregated = "";
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          aggregated += chunk;
          if (typeof onOpinion === "function") onOpinion(chunk, false);
        }
      }
      if (typeof onOpinion === "function") onOpinion(aggregated, true);
    } catch (e) {
      console.error("Streaming error:", e);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Launcher — preserved ================= */
  const Launcher = (
    <button className="record-case-btn-left" onClick={handleLauncherClick} title="Record The Case">
      <span className="shine-content">Record The Case</span>
    </button>
  );

  /* ================= Fixed-width digit renderer ================= */
  const Digits = ({ value }) => {
    return (
      <span className="digits">
        <span className="digit">{value[0]}</span>
        <span className="digit">{value[1]}</span>
      </span>
    );
  };

  /* ===================== Searchable Combobox ===================== */
  function DepartmentCombobox({ value, onChange, error }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(value || "");
    const [activeIndex, setActiveIndex] = useState(0);
    const rootRef = useRef(null);
    const listId = useId();

    // Filter results by value OR group (FLAT_DEPTS is stable)
    const filtered = React.useMemo(() => {
      const q = normalize(query);
      if (!q) return FLAT_DEPTS;
      return FLAT_DEPTS.filter(
        (opt) => normalize(opt.value).includes(q) || normalize(opt.group).includes(q)
      );
    }, [query]);

    useEffect(() => {
      // keep input in sync if external value changes
      setQuery(value || "");
    }, [value]);

    // Close on outside click
    useEffect(() => {
      const onDocClick = (e) => {
        if (!rootRef.current) return;
        if (!rootRef.current.contains(e.target)) setOpen(false);
      };
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }, []);

    const selectAt = (idx) => {
      const opt = filtered[idx];
      if (!opt) return;
      onChange(opt.value);
      setQuery(opt.value);
      setOpen(false);
    };

    return (
      <div className="vrp-field" ref={rootRef} style={{ position: "relative" }}>
        <label htmlFor="vrp-dept">Department</label>

        <input
          id="vrp-dept"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && filtered[activeIndex] ? `opt-${activeIndex}` : undefined}
          placeholder="Search & select department…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
            if (!e.target.value) onChange(""); // clear selection if cleared
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              if (open) {
                e.preventDefault();
                selectAt(activeIndex);
              }
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />

        {error && <span className="vrp-err">{error}</span>}

        {open && filtered.length > 0 && (
          <div
            id={listId}
            role="listbox"
            style={{
              position: "absolute",
              zIndex: 2500,
              left: 0,
              right: 0,
              top: "calc(100% + 6px)",
              maxHeight: 260,
              overflowY: "auto",
              borderRadius: 12,
              border: "1px solid rgba(15,18,24,0.10)",
              background: "rgba(255,255,255,0.98)",
              boxShadow: "0 14px 34px rgba(15,18,24,0.18), 0 1px 0 rgba(15,18,24,0.03) inset",
              padding: 6,
            }}
          >
            {(() => {
              let lastGroup = null;
              return filtered.map((opt, idx) => {
                const showGroup = opt.group !== lastGroup;
                lastGroup = opt.group;
                return (
                  <React.Fragment key={`${opt.group}-${opt.value}-${idx}`}>
                    {showGroup && (
                      <div
                        aria-hidden
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          letterSpacing: ".02em",
                          margin: "8px 8px 4px",
                          opacity: 0.9,
                        }}
                      >
                        {opt.group}
                      </div>
                    )}
                    <div
                      id={`opt-${idx}`}
                      role="option"
                      aria-selected={idx === activeIndex}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault(); // prevent input blur before onClick
                      }}
                      onClick={() => selectAt(idx)}
                      style={{
                        padding: "10px 12px",
                        margin: "2px 6px",
                        borderRadius: 10,
                        cursor: "pointer",
                        background: idx === activeIndex ? "rgba(99,102,241,0.12)" : "transparent",
                        outline: idx === activeIndex ? "1px solid rgba(99,102,241,0.35)" : "none",
                      }}
                    >
                      {opt.value}
                    </div>
                  </React.Fragment>
                );
              });
            })()}
          </div>
        )}
      </div>
    );
  }

  /* ================= Case Meta Modal (portal) ================= */
  const caseMetaNode = !showCaseForm
    ? null
    : createPortal(
        <div className="vrp-modal-backdrop" role="dialog" aria-modal="true" aria-label="Case details">
          <div className="vrp-modal">
            <div className="vrp-modal-head">
              <h3>Case Details</h3>
              <button
                className="vrp-modal-close"
                type="button"
                aria-label="Cancel"
                onClick={() => {
                  setShowCaseForm(false);
                }}
              >
                ×
              </button>
            </div>

            <form
              className="vrp-form"
              onSubmit={(e) => {
                e.preventDefault();
                const errs = validateCaseMeta();
                setFormErrors(errs);
                if (Object.keys(errs).length === 0) {
                  setCaseMetaSubmitted(true);
                  setShowCaseForm(false);
                  try {
                    localStorage.setItem("vrp_case_meta", JSON.stringify(caseMeta));
                  } catch {}
                }
              }}
            >
              <div className="vrp-field">
                <label htmlFor="vrp-patient-name">Patient Name</label>
                <input
                  id="vrp-patient-name"
                  type="text"
                  value={caseMeta.patientName}
                  onChange={(e) => setCaseMeta({ ...caseMeta, patientName: e.target.value })}
                  placeholder="e.g., Sarah Ahmed"
                />
                {formErrors.patientName && <span className="vrp-err">{formErrors.patientName}</span>}
              </div>

              <div className="vrp-field">
                <label htmlFor="vrp-file-number">File Number</label>
                <input
                  id="vrp-file-number"
                  type="text"
                  value={caseMeta.fileNumber}
                  onChange={(e) => setCaseMeta({ ...caseMeta, fileNumber: e.target.value })}
                  placeholder="e.g., DSAH-12345"
                />
                {formErrors.fileNumber && <span className="vrp-err">{formErrors.fileNumber}</span>}
              </div>

              <div className="vrp-two-col">
                <div className="vrp-field">
                  <label htmlFor="vrp-age">Age</label>
                  <input
                    id="vrp-age"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={caseMeta.age}
                    onChange={(e) => setCaseMeta({ ...caseMeta, age: e.target.value })}
                    placeholder="e.g., 42"
                  />
                  {formErrors.age && <span className="vrp-err">{formErrors.age}</span>}
                </div>

                <DepartmentCombobox
                  value={caseMeta.department}
                  onChange={(val) => setCaseMeta({ ...caseMeta, department: val })}
                  error={formErrors.department}
                />
              </div>

              <div className="vrp-actions">
                <button type="button" className="vrp-btn ghost" onClick={() => setShowCaseForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="vrp-btn primary">
                  Save &amp; Continue
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      );

  /* ================= Left dock (portal) ================= */
  const dockNode = !dockOpen
    ? null
    : createPortal(
        <motion.div
          className="vrp-dock"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          role="region"
          aria-label="Voice Recorder"
        >
          <div className="overlay-head">
            <span className={`badge ${isRecording ? "live" : ""}`}>
              {isRecording ? "Voice Recorder • LIVE" : "Voice Recorder"}
            </span>
            <button className="close-x" onClick={() => setDockOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="wave-wrap">
            <ReactMic
              record={isRecording}
              pause={isPaused}
              onStop={onStop}
              strokeColor="#6366f1"
              visualSetting="frequencyBars"
              backgroundColor="#FFFFFF"
              className="sound-wave"
            />
          </div>

          <div className="recorder-buttons">
            <button
              onClick={startRecording}
              disabled={isRecording || !caseMetaSubmitted}
              title={!caseMetaSubmitted ? "Fill case details to enable recording" : "Start Recording"}
            >
              <span className="shine-content">Start Recording</span>
            </button>
            <button onClick={stopRecording} disabled={!isRecording}>
              <span className="shine-content">Stop Recording</span>
            </button>
            <button onClick={togglePauseResume} disabled={!isRecording}>
              <span className="shine-content">{isPaused ? "Resume Recording" : "Pause Recording"}</span>
            </button>
            <button onClick={resetRecording} disabled={!isTranscriptReady}>
              <span className="shine-content">New Recording</span>
            </button>

            {isTranscriptReady && (
              <button className="analyze" onClick={analyzeCase} disabled={loading}>
                <span className="shine-content">Analyze Case</span>
              </button>
            )}
          </div>

          {!caseMetaSubmitted && !isRecording && (
            <p className="vrp-gate-hint">Recording is locked. Please fill the case details first.</p>
          )}

          {isRecording &&
            (() => {
              const t = getParts(elapsedMs);
              return (
                <div className="vrp-timer-block" aria-live="polite">
                  <div className={`button-container ${isPaused ? "paused" : "running"}`}>
                    <div className={`button ${isRecording ? "square" : ""}`} />
                  </div>

                  <h2 className="timeroutput sr-only" role="timer">
                    {t.aria}
                  </h2>

                  <div className="timer-digits" aria-hidden="true">
                    <div className="time-group t-hours">
                      <Digits value={t.HH} />
                      <span className="label">hrs</span>
                    </div>
                    <span className="colon">:</span>
                    <div className="time-group t-mins">
                      <Digits value={t.MM} />
                      <span className="label">min</span>
                    </div>
                    <span className="colon">:</span>
                    <div className="time-group t-secs">
                      <Digits value={t.SS} />
                      <span className="label">sec</span>
                    </div>
                    <span className="colon dim">:</span>
                    <div className="time-group t-centis">
                      <Digits value={t.CS} />
                      <span className="label">cs</span>
                    </div>
                  </div>
                </div>
              );
            })()}

          {loading && (
            <div className="loaders">
              <div className="spinners" />
              <p>Processing…</p>
            </div>
          )}
        </motion.div>,
        document.body
      );

  return (
    <>
      {Launcher}
      {dockNode}
      {caseMetaNode}
    </>
  );
};

export default VoiceRecorderPanel;











