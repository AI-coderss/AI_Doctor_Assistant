/* eslint-disable no-useless-concat */
/* eslint-disable react-hooks/exhaustive-deps */
// src/components/VoiceRecorderPanel.jsx
import React, { useRef, useState, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { ReactMic } from "react-mic";
import { motion } from "framer-motion";
import axios from "axios";
import "../styles/VoiceRecorderPanel.css";

/* =========================
   Config / Defaults
   ========================= */
const API_BASE =  "https://ai-doctor-assistant-backend-server.onrender.com";
const TRANSCRIPTION_BASE="https://test-medic-transcriber-latest.onrender.com"
/* =========================
   Reference data (unchanged)
   ========================= */
const DEPARTMENTS = [
  { group: "Primary Care", items: ["Family Medicine", "Internal Medicine", "General Practice", "Geriatrics"] },
  { group: "Medicine Subspecialties", items: ["Cardiology","Cardiovascular Medicine","Endocrinology","Gastroenterology","Hepatology","Nephrology","Pulmonology / Respiratory Medicine","Rheumatology","Infectious Diseases","Hematology","Medical Oncology","Neurology","Allergy & Immunology","Sleep Medicine","Sports Medicine","Palliative Care","Pain Medicine"] },
  { group: "Surgery", items: ["General Surgery","Cardiothoracic Surgery","Vascular Surgery","Neurosurgery","Orthopedic Surgery","Plastic & Reconstructive Surgery","Colorectal Surgery","Hepatobiliary Surgery","Bariatric / Metabolic Surgery","Urology","Oral & Maxillofacial Surgery","Trauma Surgery","ENT (Otolaryngology)","Ophthalmology"] },
  { group: "Women & Children", items: ["Obstetrics & Gynecology (OB/GYN)","Reproductive Endocrinology & Infertility (IVF)","Maternal-Fetal Medicine","Pediatrics","Neonatology (NICU)","Pediatric Surgery"] },
  { group: "Diagnostics & Imaging", items: ["Radiology","Interventional Radiology","Nuclear Medicine","Anatomical Pathology","Clinical Pathology / Laboratory Medicine","Transfusion Medicine / Blood Bank","Medical Genetics / Genomic Medicine"] },
  { group: "Critical Care & Emergency", items: ["Emergency Medicine","Intensive Care / Critical Care","Anesthesiology"] },
  { group: "Rehabilitation & Allied Health", items: ["Physical Medicine & Rehabilitation (PM&R)","Physical Therapy","Occupational Therapy","Speech-Language Pathology","Nutrition & Dietetics","Pharmacy"] },
  { group: "Behavioral Health", items: ["Psychiatry","Psychology / Behavioral Health"] },
  { group: "Dentistry", items: ["General Dentistry","Orthodontics","Periodontics","Prosthodontics","Endodontics","Pediatric Dentistry","Dental Radiology","Oral Surgery (Dentistry)"] },
  { group: "Public Health & Admin", items: ["Infection Control","Occupational Health","Community Medicine / Public Health"] },
];

const FLAT_DEPTS = DEPARTMENTS.flatMap(g => g.items.map(value => ({ value, group: g.group })));
const normalize = (s) =>
  (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/* Debounce helper */
function useDebounceTimer() {
  const t = useRef(null);
  return (fn, ms = 500) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(fn, ms);
  };
}

const VoiceRecorderPanel = ({
  /* Existing endpoints (kept) */
  transcribeUrl = `${TRANSCRIPTION_BASE}/transcribe`,
  opinionUrl = `${API_BASE}/case_second_opinion_stream`,
  lastVisitLookupUrl = `${API_BASE}/patient_last_visit`,
  fileFieldName = "audio_data",
  onOpinion,         // (chunk, done:boolean)
  onTranscriptReady, // (fullText)

  /* NEW realtime + notes endpoints (safe defaults) */
  rtcConnectUrl = `${API_BASE}/api/rtc-transcribe-nodes-connect`,
  rtAnalyzeUrl  = `${API_BASE}/rt/analyze_turn`,
  notesUrl      = `${API_BASE}/notes/generate`,
}) => {
  /* ---------- UI state ---------- */
  const [dockOpen, setDockOpen] = useState(false);
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [formMode, setFormMode] = useState("existing"); // "new" | "existing"
  const [caseMetaSubmitted, setCaseMetaSubmitted] = useState(false);

  /* New / Existing meta */
  const [newMeta, setNewMeta] = useState({ patientName: "", fileNumber: "", age: "", department: "" });
  const [existingMeta, setExistingMeta] = useState({
    fileNumber: "", visitType: "Follow-up", patientName: "", age: "", department: "", lastVisitLoaded: false, lastVisitDate: ""
  });
  const [formErrors, setFormErrors] = useState({});

  /* Recording state */
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused]       = useState(false);
  const [isTranscriptReady, setIsTranscriptReady] = useState(false);
  const [loading, setLoading] = useState(false);

  /* WebRTC refs */
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const micStreamRef = useRef(null);
  const audioRef = useRef(null); // optional server TTS playback

  /* Transcript */
  const transcriptRef = useRef("");

  /* Session id aligned with chat.jsx */
  const [sessionId] = useState(() => {
    try {
      const existing = localStorage.getItem("sessionId");
      if (existing) return existing;
      const id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + "-" + Date.now();
      localStorage.setItem("sessionId", id);
      return id;
    } catch {
      return (Math.random().toString(36).slice(2)) + "-" + Date.now();
    }
  });

  /* Stopwatch */
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
    startAtRef.current = performance.now();
    intervalRef.current = setInterval(() => {
      setElapsedMs(pausedAccumRef.current + (performance.now() - startAtRef.current));
    }, 50);
  };
  const stopInterval = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };
  useEffect(() => () => stopInterval(), []);

  /* small event helper (Chat.jsx listens to these) */
  const emit = (name, detail) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  };

  /* Restore cached case meta */
  useEffect(() => {
    try {
      const rawNew = localStorage.getItem("vrp_case_meta_new");
      if (rawNew) setNewMeta((s) => ({ ...s, ...JSON.parse(rawNew) }));
      const rawExisting = localStorage.getItem("vrp_case_meta_existing");
      if (rawExisting) setExistingMeta((s) => ({ ...s, ...JSON.parse(rawExisting) }));
    } catch {}
  }, []);

  /* Validation */
  const validateExisting = () => {
    const e = {};
    if (!existingMeta.fileNumber.trim()) e.fileNumber = "Required";
    if (!existingMeta.visitType.trim()) e.visitType = "Required";
    return e;
  };

  /* ============ Existing Patient: Load Last Visit ============ */
  const loadLastVisit = async () => {
    if (!existingMeta.fileNumber.trim()) return;
    try {
      setLoading(true);
      const resp = await fetch(lastVisitLookupUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_number: existingMeta.fileNumber }),
      });
      if (!resp.ok) throw new Error(`Lookup failed: ${resp.status}`);
      const data = await resp.json();
      setExistingMeta((s) => ({
        ...s,
        patientName: data?.patient_name ?? s.patientName ?? "",
        age: String(data?.patient_age ?? s.age ?? ""),
        department: data?.department ?? s.department ?? "",
        lastVisitLoaded: true,
        lastVisitDate: data?.last_visit_date ?? ""
      }));
    } catch (e) {
      console.error("Last visit lookup error:", e);
    } finally {
      setLoading(false);
    }
  };

  /* =========================
     REALTIME (WebRTC + STT)
     ========================= */
  const rtBufRef = useRef(""); // accumulates latest STT chars
  const debounce = useDebounceTimer();

  const startRealtime = async () => {
    if (pcRef.current) return true; // already connected
    try {
      // 1) mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // 2) pc
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;
      stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));

      // optional TTS downlink
      pc.ontrack = (evt) => {
        if (!audioRef.current) return;
        const [s] = evt.streams;
        audioRef.current.srcObject = s;
        audioRef.current.muted = false;
        audioRef.current.play().catch(() => {});
      };

      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === "failed" || st === "disconnected" || st === "closed") {
          stopRealtime();
        }
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        try {
          // configure server-side real-time STT
          dc.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  transcription: { model: "gpt-4o-transcribe", language: "en" },
                  turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 }
                }
              },
              include: ["item.input_audio_transcription.logprobs"]
            }
          }));
          dc.send(JSON.stringify({ type: "response.create" }));
        } catch (e) {
          console.warn("session.update failed", e);
        }
      };

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === "conversation.log") return;

          if (msg?.type === "conversation.item.input_audio_transcription.delta") {
            const delta = msg?.delta || "";
            if (delta) {
              rtBufRef.current = (rtBufRef.current || "") + delta;

              const snapshot = rtBufRef.current;
              debounce(async () => {
                try {
                  const r = await fetch(rtAnalyzeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ session_id: sessionId, text: snapshot })
                  });
                  if (!r.ok) return;
                  const j = await r.json();

                  const detail = {
                    chiefComplaint: j?.chief_complaint || "",
                    diagnoses: Array.isArray(j?.provisional_diagnoses) ? j.provisional_diagnoses : [],
                    bullets: Array.isArray(j?.suggestions) ? j.suggestions : [],
                    lastUpdated: Date.now()
                  };
                  // Let Chat.jsx render real-time suggestions on the Suggestions tab
                  emit("vrp:rt-update", detail);
                  // Ensure analysis tabs are visible once streaming starts
                  emit("vrp:ensure-analysis", { from: "vrp" });
                } catch {}
              }, 600);
            }
          }

          if (msg?.type === "conversation.item.input_audio_transcription.completed") {
            rtBufRef.current = (rtBufRef.current || "") + " ";
          }
        } catch {
          /* ignore non-JSON frames */
        }
      };

      // 3) SDP
      let offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      offer.sdp = offer.sdp.replace(
        /a=rtpmap:\d+ opus\/48000\/2/g,
        "a=rtpmap:111 opus/48000/2\r\n" + "a=fmtp:111 minptime=10;useinbandfec=1"
      );
      await pc.setLocalDescription(offer);

      const url = rtcConnectUrl.includes("session_id=")
        ? rtcConnectUrl
        : `${rtcConnectUrl}?session_id=${encodeURIComponent(sessionId)}`;

      const ans = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp
      });
      if (!ans.ok) throw new Error(`rtc_connect ${ans.status}`);
      const sdp = await ans.text();
      await pc.setRemoteDescription({ type: "answer", sdp });

      // show analysis tabs as soon as we stream
      emit("vrp:ensure-analysis", { from: "vrp" });
      return true;
    } catch (e) {
      console.error("startRealtime failed:", e);
      stopRealtime();
      return false;
    }
  };

  const stopRealtime = () => {
    try { dcRef.current?.close(); } catch {}
    dcRef.current = null;

    try {
      if (pcRef.current) {
        pcRef.current.getSenders?.().forEach(s => s.track && s.track.stop());
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    if (micStreamRef.current) {
      try { micStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      micStreamRef.current = null;
    }

    rtBufRef.current = "";
    emit("vrp:recording-stopped", { sessionId });
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
      });

      const txt = String(data?.transcript ?? "");
      transcriptRef.current = txt;
      const ready = !!txt.trim();
      setIsTranscriptReady(!!ready);

      if (ready) {
        onTranscriptReady && onTranscriptReady(txt);
        // Enable Clinical Notes button on the Chat side
        emit("vrp:transcript-ready", { sessionId, length: txt.length });

        // Push final transcript into realtime analysis store for Notes generation
        try {
          await fetch(rtAnalyzeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, text: txt })
          });
        } catch {}
      }
    } catch (err) {
      console.error("Transcription error:", err);
      setIsTranscriptReady(false);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Controls (record/pause/stop/new) ================= */
  const startRecording = async () => {
    if (!caseMetaSubmitted) return;
    transcriptRef.current = "";
    setIsPaused(false);
    setIsTranscriptReady(false);
    pausedAccumRef.current = 0;
    setElapsedMs(0);
    startInterval();

    // start local WAV capture
    setIsRecording(true);

    // start realtime STT + suggestions
    const ok = await startRealtime();
    if (!ok) {
      console.warn("Realtime failed to start; proceeding with local recording only.");
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    stopInterval();
    stopRealtime();
  };

  const togglePauseResume = () => {
    if (!isRecording) return;
    if (isPaused) {
      startInterval();
      micStreamRef.current?.getTracks().forEach(t => (t.enabled = true));
      setIsPaused(false);
    } else {
      stopInterval();
      pausedAccumRef.current = elapsedMs;
      micStreamRef.current?.getTracks().forEach(t => (t.enabled = false));
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
    stopRealtime();
  };

  /* ================= Analyze Case (stream) ================= */
  const analyzeCase = async () => {
    if (!transcriptRef.current) return;
    emit("vrp:analyze-start", { sessionId });

    const payload =
      formMode === "new"
        ? { context: transcriptRef.current, session_id: sessionId, meta: { ...newMeta, form_mode: "new" } }
        : { context: transcriptRef.current, session_id: sessionId, meta: { ...existingMeta, form_mode: "existing" } };

    try {
      setLoading(true);
      const resp = await fetch(opinionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) { setLoading(false); return; }
      if (!resp.body) {
        const text = await resp.text();
        onOpinion && onOpinion(text, true);
        emit("vrp:second-opinion-ready", { text });
        setLoading(false);
        return;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder("utf-8");
      let done = false, acc = "";
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          const chunk = dec.decode(value, { stream: true });
          acc += chunk;
          onOpinion && onOpinion(chunk, false);
        }
      }
      onOpinion && onOpinion(acc, true);
      emit("vrp:second-opinion-ready", { text: acc });
    } catch (e) {
      console.error("analyzeCase error:", e);
    } finally {
      setLoading(false);
    }
  };

  /* ================= Clinical Notes (callable by Chat.jsx) ================= */
  // If you need to trigger this from here, wire a button or keep it event-driven from Chat.jsx.
  const generateNotes = async () => {
    if (!isTranscriptReady) return;
    try {
      setLoading(true);
      const r = await fetch(notesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId })
      });
      if (!r.ok) throw new Error(`notes ${r.status}`);
      const j = await r.json();
      emit("vrp:notes-ready", { notes: j });
    } catch (e) {
      console.error("notes error:", e);
      emit("vrp:notes-error", { message: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  };
  // Expose for other modules if needed
  useEffect(() => {
    window.__vrp_generateNotes = generateNotes;
    return () => { try { delete window.__vrp_generateNotes; } catch {} };
  }, [isTranscriptReady]);

  /* ================= UI components (keep classes/styles) ================= */
  const Launcher = (
    <button
      className="record-case-btn-left"
      onClick={() => { setDockOpen(true); setShowCaseForm(true); try { window.dispatchEvent(new CustomEvent("tools:close")); } catch {} }}
      title="Record The Case"
      type="button"
    >
      <span className="shine-content">Record The Case</span>
    </button>
  );

  const Digits = ({ value }) => (
    <span className="digits">
      <span className="digit">{value[0]}</span>
      <span className="digit">{value[1]}</span>
    </span>
  );

  function DepartmentCombobox({ value, onChange, error, labelId = "vrp-dept", placeholder = "Search & select department…" }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(value || "");
    const [activeIndex, setActiveIndex] = useState(0);
    const rootRef = useRef(null);
    const listId = useId();

    const filtered = React.useMemo(() => {
      const q = normalize(query);
      if (!q) return FLAT_DEPTS;
      return FLAT_DEPTS.filter(opt => normalize(opt.value).includes(q) || normalize(opt.group).includes(q));
    }, [query]);

    useEffect(() => { setQuery(value || ""); }, [value]);

    useEffect(() => {
      const onDocClick = (e) => { if (!rootRef.current) return; if (!rootRef.current.contains(e.target)) setOpen(false); };
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }, []);

    const selectAt = (idx) => {
      const opt = filtered[idx]; if (!opt) return;
      onChange(opt.value); setQuery(opt.value); setOpen(false);
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
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(0); if (!e.target.value) onChange(""); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActiveIndex(i => Math.min(i + 1, Math.max(0, filtered.length - 1))); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActiveIndex(i => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { if (open) { e.preventDefault(); selectAt(activeIndex); } }
            else if (e.key === "Escape") { setOpen(false); }
          }}
        />
        {error && <span className="vrp-err">{error}</span>}
        {open && filtered.length > 0 && (
          <div id={listId} role="listbox" className="vrp-combobox-panel">
            {(() => {
              let lastGroup = null;
              return filtered.map((opt, idx) => {
                const showGroup = opt.group !== lastGroup; lastGroup = opt.group;
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

  const caseMetaNode = !showCaseForm ? null : createPortal(
    <div className="vrp-modal-backdrop" role="dialog" aria-modal="true" aria-label="Case details">
      <div className="vrp-modal">
        <div className="vrp-topbar">
          <div className="vrp-tabs vrp-tabs--rect" role="tablist" aria-label="Form mode">
            <button type="button" role="tab" aria-selected={formMode === "existing"} className={`vrp-tab ${formMode === "existing" ? "active" : ""}`} onClick={() => setFormMode("existing")} id="tab-existing">Existing Patient</button>
            <button type="button" role="tab" aria-selected={formMode === "new"}       className={`vrp-tab ${formMode === "new" ? "active" : ""}`}       onClick={() => setFormMode("new")}      id="tab-new">New Patient</button>
          </div>
          <button className="vrp-modal-close" type="button" aria-label="Close" onClick={() => { setShowCaseForm(false); }}>×</button>
        </div>

        <form
          className="vrp-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (formMode === "new") {
              const errs = {
                ...(newMeta.patientName.trim() ? {} : { patientName: "Required" }),
                ...(newMeta.fileNumber.trim() ? {} : { fileNumber: "Required" }),
                ...(newMeta.age.trim() ? {} : { age: "Required" }),
                ...(!newMeta.department.trim() ? { department: "Required" } : {})
              };
              if (newMeta.age && (Number.isNaN(+newMeta.age) || +newMeta.age <= 0)) errs.age = "Invalid";
              setFormErrors(errs);
              if (!Object.keys(errs).length) {
                setCaseMetaSubmitted(true); setShowCaseForm(false);
                emit("vrp:case-meta",{sessionId,patientId: formMode === "new" ? newMeta.fileNumber : existingMeta.fileNumber});
                try { localStorage.setItem("vrp_case_meta_new", JSON.stringify(newMeta)); } catch {}
              }
            } else {
              const errs = validateExisting(); setFormErrors(errs);
              if (!Object.keys(errs).length) {
                setCaseMetaSubmitted(true); setShowCaseForm(false);
                emit("vrp:case-meta",{sessionId,patientId: formMode === "new" ? newMeta.fileNumber : existingMeta.fileNumber});
                try { localStorage.setItem("vrp_case_meta_existing", JSON.stringify(existingMeta)); } catch {}
              }
            }
          }}
        >
          <div className="vrb-form">
            <motion.div key={formMode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: "easeOut" }}>
              {formMode === "new" ? (
                <>
                  <div className="vrp-field">
                    <label htmlFor="vrp-patient-name">Patient Name</label>
                    <input id="vrp-patient-name" type="text" value={newMeta.patientName} onChange={(e) => setNewMeta({ ...newMeta, patientName: e.target.value })} placeholder="e.g., Sarah Ahmed" />
                    {formErrors.patientName && <span className="vrp-err">{formErrors.patientName}</span>}
                  </div>

                  <div className="vrp-field">
                    <label htmlFor="vrp-file-number">File Number</label>
                    <input id="vrp-file-number" type="text" value={newMeta.fileNumber} onChange={(e) => setNewMeta({ ...newMeta, fileNumber: e.target.value })} placeholder="e.g., DSAH-12345" />
                    {formErrors.fileNumber && <span className="vrp-err">{formErrors.fileNumber}</span>}
                  </div>

                  <div className="vrp-two-col">
                    <div className="vrp-field">
                      <label htmlFor="vrp-age">Age</label>
                      <input id="vrp-age" type="number" min="0" inputMode="numeric" value={newMeta.age} onChange={(e) => setNewMeta({ ...newMeta, age: e.target.value })} placeholder="e.g., 42" />
                      {formErrors.age && <span className="vrp-err">{formErrors.age}</span>}
                    </div>

                    <DepartmentCombobox
                      value={newMeta.department}
                      onChange={(val) => setNewMeta({ ...newMeta, department: val })}
                      labelId="vrp-dept-new"
                      placeholder="Set department for this visit…"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="vrp-two-col">
                    <div className="vrp-field">
                      <label htmlFor="vrp-file-number-ex">File Number</label>
                      <input id="vrp-file-number-ex" type="text" value={existingMeta.fileNumber} onChange={(e) => setExistingMeta({ ...existingMeta, fileNumber: e.target.value })} placeholder="e.g., DSAH-12345" />
                      {formErrors.fileNumber && <span className="vrp-err">{formErrors.fileNumber}</span>}
                    </div>

                    <div className="vrp-field">
                      <label htmlFor="vrp-visit-type">Visit Type</label>
                      <select id="vrp-visit-type" value={existingMeta.visitType} onChange={(e) => setExistingMeta({ ...existingMeta, visitType: e.target.value })}>
                        <option>Follow-up</option>
                        <option>New Visit</option>
                      </select>
                      {formErrors.visitType && <span className="vrp-err">{formErrors.visitType}</span>}
                    </div>
                  </div>

                  <div className="vrp-field">
                    <label htmlFor="vrp-patient-name-ex">Patient Name</label>
                    <input id="vrp-patient-name-ex" type="text" value={existingMeta.patientName} onChange={(e) => setExistingMeta({ ...existingMeta, patientName: e.target.value })} placeholder="(loaded from last visit or leave blank)" />
                  </div>

                  <div className="vrp-two-col">
                    <div className="vrp-field">
                      <label htmlFor="vrp-age-ex">Age</label>
                      <input id="vrp-age-ex" type="number" min="0" inputMode="numeric" value={existingMeta.age} onChange={(e) => setExistingMeta({ ...existingMeta, age: e.target.value })} placeholder="(loaded or leave blank)" />
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
              <button type="button" className="vrp-btn ghost" onClick={() => setShowCaseForm(false)}>Cancel</button>
              {formMode === "existing" && (
                <button type="button" className="vrp-btn secondary" onClick={loadLastVisit} disabled={loading || !existingMeta.fileNumber.trim()} title="Load last visit details">
                  Load Last Visit
                </button>
              )}
            </div>
            <div className="vrp-actions-right">
              <button type="submit" className="vrp-btn primary">Save &amp; Continue</button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );

  const dockNode = !dockOpen ? null : createPortal(
    <motion.div className="vrp-dock" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="overlay-head">
        <span className={`badge ${isRecording ? "live" : ""}`}>{isRecording ? "Voice Recorder • LIVE" : "Voice Recorder"}</span>
        <button className="close-x" onClick={() => { setDockOpen(false); resetRecording(); }} aria-label="Close">×</button>
      </div>

      <div className="wave-wrap">
        <audio ref={audioRef} style={{ display: "none" }} playsInline />
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
        <button onClick={startRecording} disabled={isRecording || !caseMetaSubmitted} title={!caseMetaSubmitted ? "Fill case details to enable recording" : "Start Recording"} type="button">
          <span className="shine-content">Start Recording</span>
        </button>
        <button onClick={stopRecording} disabled={!isRecording} type="button">
          <span className="shine-content">Stop Recording</span>
        </button>
        <button onClick={togglePauseResume} disabled={!isRecording} type="button">
          <span className="shine-content">{isPaused ? "Resume Recording" : "Pause Recording"}</span>
        </button>
        <button onClick={resetRecording} disabled={!isTranscriptReady} type="button">
          <span className="shine-content">New Recording</span>
        </button>

        {isTranscriptReady && (
          <button className="analyze" onClick={analyzeCase} disabled={loading} type="button">
            <span className="shine-content">Analyze Case</span>
          </button>
        )}
      </div>

      {!caseMetaSubmitted && !isRecording && (
        <p className="vrp-gate-hint">Recording is locked. Please fill the case details first.</p>
      )}

      {isRecording && (() => {
        const t = getParts(elapsedMs);
        return (
          <div className="vrp-timer-block" aria-live="polite">
            <div className={`button-container ${isPaused ? "paused" : "running"}`}>
              <div className={`button ${isRecording ? "square" : ""}`} />
            </div>
            <h2 className="timeroutput sr-only" role="timer">{t.aria}</h2>
            <div className="timer-digits" aria-hidden="true">
              <div className="time-group t-hours"><Digits value={t.HH} /><span className="label">hrs</span></div>
              <span className="colon">:</span>
              <div className="time-group t-mins"><Digits value={t.MM} /><span className="label">min</span></div>
              <span className="colon">:</span>
              <div className="time-group t-secs"><Digits value={t.SS} /><span className="label">sec</span></div>
              <span className="colon dim">:</span>
              <div className="time-group t-centis"><Digits value={t.CS} /><span className="label">cs</span></div>
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














