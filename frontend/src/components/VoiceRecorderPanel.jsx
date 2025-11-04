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
const normalize = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const VoiceRecorderPanel = ({
  transcribeUrl = "/transcribe",
  opinionUrl = "/case_second_opinion_stream",
  lastVisitLookupUrl = "/patient_last_visit",
  fileFieldName = "audio_data",
  onOpinion,
  onTranscriptReady,
}) => {
  const [dockOpen, setDockOpen] = useState(false);

  // Center pop-up (glassmorphic) gate
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [formMode, setFormMode] = useState("new"); // "new" | "existing"
  const [caseMetaSubmitted, setCaseMetaSubmitted] = useState(false);

  // NEW patient meta
  const [newMeta, setNewMeta] = useState({
    patientName: "",
    fileNumber: "",
    age: "",
    department: "",
  });

  // EXISTING patient meta
  const [existingMeta, setExistingMeta] = useState({
    fileNumber: "",
    visitType: "Follow-up",
    patientName: "",
    age: "",
    department: "",
    lastVisitLoaded: false,
    lastVisitDate: "",
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

  /* ================= TIMER ================= */
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
    const HH = pad2(hh), MM = pad2(mm), SS = pad2(ss), CS = pad2(cs);
    return { HH, MM, SS, CS, aria: `${HH}:${MM}:${SS}:${CS}` };
  };

  const startInterval = () => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setElapsedMs(pausedAccumRef.current + (performance.now() - startAtRef.current));
    }, 50);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  /* ================= Drawer coordination ================= */
  const closeDrawer = () => {
    try { window.dispatchEvent(new CustomEvent("tools:close")); } catch {}
  };

  /* ================= Persist / Rehydrate per-form ================= */
  useEffect(() => {
    try {
      const rawNew = localStorage.getItem("vrp_case_meta_new");
      if (rawNew) setNewMeta((s) => ({ ...s, ...JSON.parse(rawNew) }));
      const rawExisting = localStorage.getItem("vrp_case_meta_existing");
      if (rawExisting) setExistingMeta((s) => ({ ...s, ...JSON.parse(rawExisting) }));
    } catch {}
  }, []);

  /* ================= Validation ================= */
  const validateNew = () => {
    const errs = {};
    if (!newMeta.patientName.trim()) errs.patientName = "Required";
    if (!newMeta.fileNumber.trim()) errs.fileNumber = "Required";
    if (!newMeta.age.trim()) errs.age = "Required";
    if (newMeta.age && (Number.isNaN(+newMeta.age) || +newMeta.age <= 0)) errs.age = "Invalid";
    if (!newMeta.department.trim()) errs.department = "Required";
    return errs;
  };

  const validateExisting = () => {
    const errs = {};
    if (!existingMeta.fileNumber.trim()) errs.fileNumber = "Required";
    if (!existingMeta.visitType.trim()) errs.visitType = "Required";
    return errs;
  };

  /* ================= Controls ================= */
  const handleLauncherClick = () => {
    setDockOpen(true);
    setShowCaseForm(true);
    closeDrawer();
  };

  const stopInterval = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const startRecording = () => {
    if (!caseMetaSubmitted) return;
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

  /* ============ Existing Patient: Load Last Visit (footer only) ============ */
  const loadLastVisit = async () => {
    if (!existingMeta.fileNumber.trim()) return;
    try {
      setLoading(true);
      const resp = await fetch(lastVisitLookupUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_number: existingMeta.fileNumber }),
      });
      if (!resp.ok) throw new Error(`Lookup failed: ${resp.status}`);
      const data = await resp.json();

      const patientName = data.patient_name ?? existingMeta.patientName ?? "";
      const age = data.patient_age ?? existingMeta.age ?? "";
      const department = data.department ?? existingMeta.department ?? "";
      const lastVisitDate = data.last_visit_date ?? "";

      setExistingMeta((s) => ({
        ...s,
        patientName,
        age: String(age || ""),
        department,
        lastVisitLoaded: true,
        lastVisitDate,
      }));
    } catch (e) {
      console.error("Last visit lookup error:", e);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Upload after stop => transcribe ================= */
  const onStop = async (recordedBlob) => {
    try {
      if (!recordedBlob?.blob) return;
      const audioFile = new File([recordedBlob.blob], "temp.wav", { type: "audio/wav" });
      const form = new FormData();
      form.append(fileFieldName, audioFile);
      form.append("session_id", sessionId);

      if (formMode === "new") {
        form.append("form_mode", "new");
        form.append("patient_name", newMeta.patientName);
        form.append("patient_file_number", newMeta.fileNumber);
        form.append("patient_age", newMeta.age);
        form.append("patient_department", newMeta.department);
      } else {
        form.append("form_mode", "existing");
        form.append("patient_file_number", existingMeta.fileNumber);
        form.append("visit_type", existingMeta.visitType);
        if (existingMeta.patientName) form.append("patient_name", existingMeta.patientName);
        if (existingMeta.age) form.append("patient_age", existingMeta.age);
        if (existingMeta.department) form.append("patient_department", existingMeta.department);
        if (existingMeta.lastVisitLoaded && existingMeta.lastVisitDate) form.append("last_visit_date", existingMeta.lastVisitDate);
      }

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

    const payload =
      formMode === "new"
        ? { context: transcriptRef.current, session_id: sessionId, meta: { ...newMeta, form_mode: "new" } }
        : { context: transcriptRef.current, session_id: sessionId, meta: { ...existingMeta, form_mode: "existing" } };

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
      let done = false, aggregated = "";
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
  const Digits = ({ value }) => (
    <span className="digits">
      <span className="digit">{value[0]}</span>
      <span className="digit">{value[1]}</span>
    </span>
  );

  /* ===================== Searchable Combobox ===================== */
  function DepartmentCombobox({ value, onChange, error, labelId = "vrp-dept", placeholder = "Search & select department…" }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(value || "");
    const [activeIndex, setActiveIndex] = useState(0);
    const rootRef = useRef(null);
    const listId = useId();

    const filtered = React.useMemo(() => {
      const q = normalize(query);
      if (!q) return FLAT_DEPTS;
      return FLAT_DEPTS.filter(
        (opt) => normalize(opt.value).includes(q) || normalize(opt.group).includes(q)
      );
    }, [query]);

    useEffect(() => { setQuery(value || ""); }, [value]);

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
      <div className="vrp-field vrp-field--combo" ref={rootRef}>
        <label htmlFor={labelId}>Department</label>

        <input
          id={labelId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && filtered[activeIndex] ? `opt-${activeIndex}` : undefined}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(0);
            if (!e.target.value) onChange("");
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
          <div id={listId} role="listbox" className="vrp-combobox-panel">
            {(() => {
              let lastGroup = null;
              return filtered.map((opt, idx) => {
                const showGroup = opt.group !== lastGroup;
                lastGroup = opt.group;
                return (
                  <React.Fragment key={`${opt.group}-${opt.value}-${idx}`}>
                    {showGroup && <div aria-hidden className="vrp-combobox-group">{opt.group}</div>}
                    <div
                      id={`opt-${idx}`}
                      role="option"
                      aria-selected={idx === activeIndex}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectAt(idx)}
                      className={`vrp-combobox-option ${idx === activeIndex ? "active" : ""}`}
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
            {/* Topbar with RECT tabs (no header) */}
            <div className="vrp-topbar">
              <div className="vrp-tabs vrp-tabs--rect" role="tablist" aria-label="Form mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={formMode === "existing"}
                  className={`vrp-tab ${formMode === "existing" ? "active" : ""}`}
                  onClick={() => setFormMode("existing")}
                  id="tab-existing"
                >
                  Existing Patient
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={formMode === "new"}
                  className={`vrp-tab ${formMode === "new" ? "active" : ""}`}
                  onClick={() => setFormMode("new")}
                  id="tab-new"
                >
                  New Patient
                </button>
              </div>

              <button
                className="vrp-modal-close"
                type="button"
                aria-label="Close"
                onClick={() => { setShowCaseForm(false); }}
              >
                ×
              </button>
            </div>

            <form
              className="vrp-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (formMode === "new") {
                  const errs = validateNew();
                  setFormErrors(errs);
                  if (Object.keys(errs).length === 0) {
                    setCaseMetaSubmitted(true);
                    setShowCaseForm(false);
                    try { localStorage.setItem("vrp_case_meta_new", JSON.stringify(newMeta)); } catch {}
                  }
                } else {
                  const errs = validateExisting();
                  setFormErrors(errs);
                  if (Object.keys(errs).length === 0) {
                    setCaseMetaSubmitted(true);
                    setShowCaseForm(false);
                    try { localStorage.setItem("vrp_case_meta_existing", JSON.stringify(existingMeta)); } catch {}
                  }
                }
              }}
            >
              <div className="vrp-form-body">
                <motion.div
                  key={formMode}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  {formMode === "new" ? (
                    <>
                      <div className="vrp-field">
                        <label htmlFor="vrp-patient-name">Patient Name</label>
                        <input
                          id="vrp-patient-name"
                          type="text"
                          value={newMeta.patientName}
                          onChange={(e) => setNewMeta({ ...newMeta, patientName: e.target.value })}
                          placeholder="e.g., Sarah Ahmed"
                        />
                        {formErrors.patientName && <span className="vrp-err">{formErrors.patientName}</span>}
                      </div>

                      <div className="vrp-field">
                        <label htmlFor="vrp-file-number">File Number</label>
                        <input
                          id="vrp-file-number"
                          type="text"
                          value={newMeta.fileNumber}
                          onChange={(e) => setNewMeta({ ...newMeta, fileNumber: e.target.value })}
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
                            value={newMeta.age}
                            onChange={(e) => setNewMeta({ ...newMeta, age: e.target.value })}
                            placeholder="e.g., 42"
                          />
                          {formErrors.age && <span className="vrp-err">{formErrors.age}</span>}
                        </div>

                        <DepartmentCombobox
                          value={newMeta.department}
                          onChange={(val) => setNewMeta({ ...newMeta, department: val })}
                          error={formErrors.department}
                          labelId="vrp-dept-new"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="vrp-two-col">
                        <div className="vrp-field">
                          <label htmlFor="vrp-file-number-ex">File Number</label>
                          <input
                            id="vrp-file-number-ex"
                            type="text"
                            value={existingMeta.fileNumber}
                            onChange={(e) => setExistingMeta({ ...existingMeta, fileNumber: e.target.value })}
                            placeholder="e.g., DSAH-12345"
                          />
                          {formErrors.fileNumber && <span className="vrp-err">{formErrors.fileNumber}</span>}
                        </div>

                        <div className="vrp-field">
                          <label htmlFor="vrp-visit-type">Visit Type</label>
                          <select
                            id="vrp-visit-type"
                            value={existingMeta.visitType}
                            onChange={(e) => setExistingMeta({ ...existingMeta, visitType: e.target.value })}
                          >
                            <option>Follow-up</option>
                            <option>New Visit</option>
                          </select>
                          {formErrors.visitType && <span className="vrp-err">{formErrors.visitType}</span>}
                        </div>
                      </div>

                      <div className="vrp-field">
                        <label htmlFor="vrp-patient-name-ex">Patient Name</label>
                        <input
                          id="vrp-patient-name-ex"
                          type="text"
                          value={existingMeta.patientName}
                          onChange={(e) => setExistingMeta({ ...existingMeta, patientName: e.target.value })}
                          placeholder="(loaded from last visit or leave blank)"
                        />
                      </div>

                      <div className="vrp-two-col">
                        <div className="vrp-field">
                          <label htmlFor="vrp-age-ex">Age</label>
                          <input
                            id="vrp-age-ex"
                            type="number"
                            min="0"
                            inputMode="numeric"
                            value={existingMeta.age}
                            onChange={(e) => setExistingMeta({ ...existingMeta, age: e.target.value })}
                            placeholder="(loaded or leave blank)"
                          />
                        </div>

                        <DepartmentCombobox
                          value={existingMeta.department}
                          onChange={(val) => setExistingMeta({ ...existingMeta, department: val })}
                          labelId="vrp-dept-ex"
                          placeholder="Set department for this visit…"
                        />
                      </div>
                    </>
                  )}
                </motion.div>
              </div>

              <div className="vrp-actions">
                <div className="vrp-actions-left">
                  <button type="button" className="vrp-btn ghost" onClick={() => setShowCaseForm(false)}>
                    Cancel
                  </button>

                  {formMode === "existing" && (
                    <button
                      type="button"
                      className="vrp-btn secondary"
                      onClick={loadLastVisit}
                      disabled={loading || !existingMeta.fileNumber.trim()}
                      title="Load last visit details"
                    >
                      Load Last Visit
                    </button>
                  )}
                </div>

                <div className="vrp-actions-right">
                  <button type="submit" className="vrp-btn primary">
                    Save &amp; Continue
                  </button>
                </div>
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

                  <h2 className="timeroutput sr-only" role="timer">{t.aria}</h2>

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















