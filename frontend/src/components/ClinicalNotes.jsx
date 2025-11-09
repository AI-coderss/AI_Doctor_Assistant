/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx (centered modal, no restreams, ReactMarkdown preview, PDF download) */
/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx */
/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx — function-call aware, RAG-ready suggest endpoint,
   centered Add Section modal, horizontal mini buttons, responsive editor grid,
   and high-fidelity PDF export via @react-pdf/renderer (logo header, bold, lists, non-splitting table).
*/
/* ClinicalNotes.jsx — function-call aware, RAG-ready suggest endpoint,
   centered Add Section modal, horizontal mini buttons, responsive editor grid,
   and high-fidelity PDF export with logo header. */

/* ClinicalNotes.jsx — function-call aware, RAG-ready suggest endpoint,
   centered Add Section modal, horizontal mini buttons, responsive editor grid,
   high-fidelity PDF export (logo header, bold & bullets), and ICD-10 Finder.
*/

/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx — function-call aware, RAG-ready suggest endpoint,
   centered Add Section modal, horizontal mini buttons, responsive editor grid,
   high-fidelity PDF export (logo header, bold & bullets),
   ICD-10 Finder + Quick Search, and EDITABLE DDx table in Preview.
*/

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  PDFDownloadLink,
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
  pdf as pdfBuilder
} from "@react-pdf/renderer";
import { FaDownload, FaSearch, FaPlus, FaMinus } from "react-icons/fa";
import "../styles/clinical-notes.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const REMOTE_LOGO = "https://www.zchocolat.com/img/cms/Articles/Ramadan/drSamirHP.png";

/* ---- Interop-safe GFM plugin (prevents “is not a function”) ---- */
const gfm = typeof remarkGfm === "function" ? remarkGfm : remarkGfm?.default;

/* ---- SOAP defaults ---- */
const DEFAULT_SOAP = [
  { key: "subjective", title: "Subjective", text: "" },
  { key: "objective",  title: "Objective",  text: "" },
  { key: "assessment", title: "Assessment", text: "" },
  { key: "plan",       title: "Plan",       text: "" }
];

const storageKey = (sid, mode) => `cn:${sid || "default"}:${mode || "markdown"}:v1`;
const slugify = (s) =>
  (String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)) || "custom_section";

/* ---------- Helpers ---------- */
function parseMarkdownToSoap(md = "") {
  const out = DEFAULT_SOAP.map(x => ({...x}));
  const map = Object.fromEntries(out.map(s => [s.title.toLowerCase(), s]));
  const sections = md.split(/\n(?=##\s+)/g);
  for (const sec of sections) {
    const m = /^##\s+([^\n]+)\n?([\s\S]*)$/i.exec(sec.trim());
    if (!m) continue;
    const title = (m[1] || "").trim().toLowerCase();
    const body  = (m[2] || "").trim();
    const hit = map[title];
    if (hit) hit.text = body;
    else out.push({ key: slugify(m[1]), title: m[1].trim(), text: body });
  }
  return out;
}
function stringifySoapMarkdown(soapArr) {
  return (soapArr || DEFAULT_SOAP)
    .map(s => `## ${s.title}\n${(s.text || "").trim() || "—"}`)
    .join("\n\n");
}
function extractDdxFromSoap(sections) {
  const normalizeProb = (p) => {
    if (p === undefined || p === null || p === "") return null;
    if (typeof p === "string" && p.includes("%")) {
      const n = parseFloat(p.replace("%", "").trim());
      return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
    }
    const n = Number(p);
    if (!isFinite(n)) return null;
    return n <= 1 ? Math.round(n * 100) : Math.max(0, Math.min(100, n));
  };
  const ddxSection =
    sections.find(s => /^(differential\s+diagnosis|differentials?)$/i.test((s.title||"").trim())) ||
    sections.find(s => /(assessment|impression|diagnosis)/i.test((s.title||"").trim()));

  if (!ddxSection?.text) return [];
  let text = ddxSection.text;

  const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try {
      const obj = JSON.parse(jsonFence[1]);
      const arr = Array.isArray(obj) ? obj : (Array.isArray(obj?.items) ? obj.items : []);
      return (arr || [])
        .map(x => ({
          diagnosis: x.diagnosis || x.name || "",
          icd10: (x.icd10 || x.code || "").toString(),
          probability: normalizeProb(x.probability ?? x.prob ?? x.p)
        }))
        .filter(r => r.diagnosis);
    } catch {}
  }

  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // ignore markdown table separators if they exist
    if (/^[-\s|:]+$/.test(line)) continue;

    const parts = line.split("|").map(s => s.trim());
    let diagnosis = "", code = "", prob = null;

    if (parts.length >= 2) {
      diagnosis = parts[0].replace(/^(?:[-*]|\d+[.)])\s*/, "");
      code = parts[1].replace(/`/g, "");
      if (parts[2]) prob = normalizeProb(parts[2]);
    } else {
      const codeM = line.match(/\b([A-Z][0-9][A-Z0-9.]{1,6})\b/);
      if (codeM) code = codeM[1];
      const pPct = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      const pDec = !pPct && line.match(/\b(0\.\d+|1(?:\.0+)?)\b/);
      prob = normalizeProb(pPct ? pPct[1] : (pDec ? pDec[1] : null));
      diagnosis = line
        .replace(/^(?:[-*]|\d+[.)])\s*/, "")
        .replace(/\(.*?ICD[-–]?\s*10.*?\)/i,"")
        .replace(/\bICD[-–]?\s*10[: ]?[A-Z0-9.]+\b/i,"")
        .replace(/\s[-–]\s*\d+%/,"")
        .replace(/\s+\d+%$/,"")
        .trim();
    }
    if (!diagnosis) continue;
    out.push({ diagnosis, icd10: code || "—", probability: prob });
  }
  out.sort((a,b) => (b.probability ?? -1) - (a.probability ?? -1));
  return out;
}

/* ---------- PDF bits ---------- */
const pdfStyles = StyleSheet.create({
  page: { padding: 28, fontSize: 11, lineHeight: 1.35, fontFamily: "Helvetica" },
  header: { alignItems: "center", marginBottom: 12 },
  logo: { width: 160, height: 36, objectFit: "contain", marginBottom: 6 },
  title: { fontSize: 16, fontWeight: "bold" },
  hr: { height: 1, backgroundColor: "#ccc", marginVertical: 8 },

  sectionWrap: { marginBottom: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "bold", marginBottom: 4 },
  p: { marginBottom: 4 },
  bulletRow: { flexDirection: "row", marginBottom: 3 },
  bulletDot: { width: 10, textAlign: "center" },
  bulletText: { flex: 1 },
  bold: { fontWeight: "bold" },

  ddxBlock: { marginTop: 10, marginBottom: 4 },
  ddxTitle: { fontSize: 13, fontWeight: "bold", marginBottom: 6 },
  table: { display: "table", width: "auto", borderStyle: "solid", borderWidth: 1, borderColor: "#cbd5e1" },
  tableRow: { flexDirection: "row" },
  tableHeader: { backgroundColor: "#f3f4f6" },
  cellDiag: { width: "56%", padding: 6, borderStyle: "solid", borderWidth: 1, borderColor: "#cbd5e1" },
  cellICD:  { width: "18%", padding: 6, borderStyle: "solid", borderWidth: 1, borderColor: "#cbd5e1" },
  cellProb: { width: "26%", padding: 6, borderStyle: "solid", borderWidth: 1, borderColor: "#cbd5e1", textAlign: "right" },

  footer: { marginTop: 14, fontSize: 9, color: "#6b7280", textAlign: "center" },
});
function renderInlineBold(text = "") {
  const parts = [];
  const re = /(\*\*.*?\*\*)|([^*]+)/g;
  const tokens = text.match(re) || [];
  tokens.forEach((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**")) {
      parts.push(<Text style={pdfStyles.bold} key={i}>{tok.slice(2, -2)}</Text>);
    } else {
      parts.push(<Text key={i}>{tok}</Text>);
    }
  });
  return parts;
}
function SectionBody({ text }) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^#+\s.*$/gm, "")   // remove markdown headings
    .replace(/```[\s\S]*?```/g, "") // remove fenced code
    .trim();

  const lines = cleaned.split(/\n+/);
  return (
    <View>
      {lines.map((line, idx) => {
        const l = line.trim();
        if (!l) return <Text key={idx} style={pdfStyles.p}> </Text>;
        if (/^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l)) {
          const content = l.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
          return (
            <View style={pdfStyles.bulletRow} key={idx}>
              <Text style={pdfStyles.bulletDot}>•</Text>
              <Text style={pdfStyles.bulletText}>{renderInlineBold(content)}</Text>
            </View>
          );
        }
        return <Text key={idx} style={pdfStyles.p}>{renderInlineBold(l)}</Text>;
      })}
    </View>
  );
}
function NotePDF({ title = "Clinical Notes", soap, ddxRows, logoDataUrl }) {
  const today = new Date().toLocaleDateString();
  return (
    <Document>
      <Page size="A4" style={pdfStyles.page}>
        <View style={pdfStyles.header} wrap={false}>
          {logoDataUrl ? <Image src={logoDataUrl} style={pdfStyles.logo} /> : null}
          <Text style={pdfStyles.title}>{title}</Text>
        </View>
        <View style={pdfStyles.hr} />
        {(soap || []).map((s, i) => (
          <View key={`${s.key}-${i}`} style={pdfStyles.sectionWrap}>
            <Text style={pdfStyles.sectionTitle}>{s.title}</Text>
            <SectionBody text={s.text} />
          </View>
        ))}
        {ddxRows?.length ? (
          <View style={pdfStyles.ddxBlock} wrap={false}>
            <Text style={pdfStyles.ddxTitle}>Differential Diagnosis</Text>
            <View style={pdfStyles.table}>
              <View style={[pdfStyles.tableRow, pdfStyles.tableHeader]}>
                <Text style={pdfStyles.cellDiag}>Diagnosis</Text>
                <Text style={pdfStyles.cellICD}>ICD-10</Text>
                <Text style={pdfStyles.cellProb}>Probability</Text>
              </View>
              {ddxRows.map((r, idx) => (
                <View style={pdfStyles.tableRow} key={`${r.diagnosis}-${idx}`}>
                  <Text style={pdfStyles.cellDiag}>{r.diagnosis}</Text>
                  <Text style={pdfStyles.cellICD}>{r.icd10 || "—"}</Text>
                  <Text style={pdfStyles.cellProb}>
                    {r.probability != null ? `${r.probability}%` : "—"}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        <Text style={pdfStyles.footer}>
          Generated on {today}. This document is for clinical use.
        </Text>
      </Page>
    </Document>
  );
}

/* ---------- MAIN ---------- */
export default function ClinicalNotes({ sessionId, transcript, autostart = true, backendBase = BACKEND_BASE }) {
  const [mode, setMode] = useState("markdown");
  const [streaming, setStreaming] = useState(false);
  const [hasStreamed, setHasStreamed] = useState(false);
  const [streamBuf, setStreamBuf] = useState("");
  const [soap, setSoap] = useState(DEFAULT_SOAP);
  const [editMode, setEditMode] = useState(true);
  const [organized, setOrganized] = useState(false);
  const [error, setError] = useState("");

  const controllerRef = useRef(null);
  const mountedRef = useRef(false);
  const previewRef = useRef(null);

  /* PDF logo: prefetch to data-URL to avoid CORS-based silent failures */
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(REMOTE_LOGO, { mode: "cors" });
        if (!r.ok) throw new Error("logo fetch failed");
        const blob = await r.blob();
        const fr = new FileReader();
        fr.onload = () => { if (alive) setLogoDataUrl(fr.result); };
        fr.readAsDataURL(blob);
      } catch {
        setLogoDataUrl(null);
      }
    })();
    return () => { alive = false; };
  }, []);

  const mdNow = useMemo(() => stringifySoapMarkdown(soap), [soap]);
  const ddxRows = useMemo(() => extractDdxFromSoap(soap), [soap]);

  const loadCache = () => {
    try { const raw = sessionStorage.getItem(storageKey(sessionId, mode)); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  };
  const saveCache = (payload) => { try { sessionStorage.setItem(storageKey(sessionId, mode), JSON.stringify(payload)); } catch {} };

  const startStream = async (force = false) => {
    if (!transcript || streaming) return;
    if (hasStreamed && !force) return;

    setError(""); setStreaming(true); setStreamBuf("");
    try { controllerRef.current?.abort(); } catch {}
    const ctrl = new AbortController(); controllerRef.current = ctrl;

    try {
      const res = await fetch(`${backendBase}/api/clinical-notes/soap-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript, mode }),
        signal: ctrl.signal
      });
      if (!res.ok || !res.body) { setError("Failed to stream clinical notes."); setStreaming(false); return; }

      const reader = res.body.getReader(); const decoder = new TextDecoder(); let acc = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value, { stream: true }); acc += chunk;
        if (!mountedRef.current) break;
        setStreamBuf(acc);
      }

      if (mode === "json") {
        try {
          const obj = JSON.parse(acc.replace(/```json|```/gi, "").trim());
          const parsed = DEFAULT_SOAP.map(s => ({ ...s, text: String(obj[s.key] || obj[s.title?.toLowerCase()] || "—") }));
          if (mountedRef.current) { setSoap(parsed); setHasStreamed(true); saveCache({ soap: parsed, hasStreamed: true }); }
        } catch {
          if (mountedRef.current) {
            const fallback = DEFAULT_SOAP.map((s,i)=> i===0 ? {...s, text: acc.trim()} : s);
            setSoap(fallback); setHasStreamed(true); saveCache({ soap: fallback, hasStreamed: true });
          }
        }
      } else {
        const parsed = parseMarkdownToSoap(acc);
        if (mountedRef.current) { setSoap(parsed); setHasStreamed(true); saveCache({ soap: parsed, hasStreamed: true }); }
      }
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!(e?.name === "AbortError" || msg.includes("abort"))) {
        if (mountedRef.current) setError("Stream interrupted.");
      }
    } finally {
      if (mountedRef.current) setStreaming(false);
      controllerRef.current = null;
    }
  };

  const approveAndSave = async () => {
    try {
      setError("");
      const note_markdown = stringifySoapMarkdown(soap);
      const res = await fetch(`${backendBase}/api/clinical-notes/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, note_markdown }),
      });
      if (!res.ok) throw new Error();
      saveCache({ soap, hasStreamed: true });
    } catch { setError("Failed to save the note."); }
  };

  useEffect(() => {
    mountedRef.current = true;
    const cached = loadCache();
    if (cached?.soap) { setSoap(cached.soap); setHasStreamed(!!cached.hasStreamed); }
    else if (autostart && transcript) { startStream(false); }
    return () => { mountedRef.current = false; try { controllerRef.current?.abort(); } catch {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /* ===== Helper/Voice Agent event bridge ===== */
  useEffect(() => {
    const byKey = (k) => {
      const idx = (soap || []).findIndex(s => (s.key || "").toLowerCase() === String(k || "").toLowerCase());
      return [idx, idx >= 0 ? soap[idx] : null];
    };
    const setAndCache = (next) => { setSoap(next); saveCache({ soap: next, hasStreamed: hasStreamed || true }); };

    const onAdd = (e) => {
      const { title, key, text = "", position = "after", anchor_key } = e.detail || {};
      const obj = { key: key || slugify(title || "Custom Section"), title: title || "Custom Section", text: String(text || "") };
      if (!anchor_key || position === "end") { setAndCache([...(soap || []), obj]); return; }
      const [i] = byKey(anchor_key);
      if (i < 0) { setAndCache([...(soap || []), obj]); return; }
      const arr = [...soap];
      if (position === "before") arr.splice(i, 0, obj);
      else arr.splice(i + 1, 0, obj);
      setAndCache(arr);
    };
    const onRemove = (e) => {
      const { key } = e.detail || {};
      const [i] = byKey(key);
      if (i < 0) return;
      const arr = [...soap]; arr.splice(i, 1); setAndCache(arr);
    };
    const onUpdate = (e) => {
      const { key, text = "", append = false } = e.detail || {};
      const [i, sec] = byKey(key);
      if (i < 0) return;
      const arr = [...soap];
      arr[i] = { ...sec, text: append ? (sec.text ? `${sec.text}\n${text}` : text) : text };
      setAndCache(arr);
    };
    const onRename = (e) => {
      const { key, new_title, new_key } = e.detail || {};
      const [i, sec] = byKey(key);
      if (i < 0) return;
      const arr = [...soap];
      arr[i] = { ...sec, title: new_title || sec.title, key: new_key || slugify(new_title || sec.title) };
      setAndCache(arr);
    };
    const onApply = (e) => {
      const md = e.detail?.markdown || "";
      if (!md) return;
      const parsed = parseMarkdownToSoap(md);
      setAndCache(parsed);
      setHasStreamed(true);
    };
    const onAddOpen = (e) => {
      const d = e.detail || {};
      openAdd(d.title || "", d.anchor_key || (soap[soap.length-1]?.key), d.position || "after", d.style || "paragraph");
    };
    const onSave = () => { approveAndSave(); };
    const onPreview = () => { setEditMode(false); };

    window.addEventListener("cn:section.add", onAdd);
    window.addEventListener("cn:section.remove", onRemove);
    window.addEventListener("cn:section.update", onUpdate);
    window.addEventListener("cn:section.rename", onRename);
    window.addEventListener("cn:apply", onApply);
    window.addEventListener("cn:save", onSave);
    window.addEventListener("cn:preview", onPreview);
    window.addEventListener("cn:add.open", onAddOpen);

    return () => {
      window.removeEventListener("cn:section.add", onAdd);
      window.removeEventListener("cn:section.remove", onRemove);
      window.removeEventListener("cn:section.update", onUpdate);
      window.removeEventListener("cn:section.rename", onRename);
      window.removeEventListener("cn:apply", onApply);
      window.removeEventListener("cn:save", onSave);
      window.removeEventListener("cn:preview", onPreview);
      window.removeEventListener("cn:add.open", onAddOpen);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soap, hasStreamed]);

  /* ===== Add Section (centered modal) ===== */
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addAnchor, setAddAnchor] = useState("plan");
  const [addPos, setAddPos] = useState("after");
  const [addStyle, setAddStyle] = useState("paragraph");
  const [addPreview, setAddPreview] = useState("");
  const [adding, setAdding] = useState(false);
  const titleRef = useRef(null);

  const openAdd = (title = "", anchorKey, pos = "after", style = "paragraph") => {
    setAddTitle(title || "");
    setAddAnchor(anchorKey || (soap[soap.length-1]?.key) || "plan");
    setAddPos(pos);
    setAddStyle(style);
    setAddPreview("");
    setAddOpen(true);
    setError("");
  };
  const closeAdd = () => setAddOpen(false);

  useEffect(() => {
    if (!addOpen) return;
    const onEsc = (e) => { if (e.key === "Escape") closeAdd(); };
    window.addEventListener("keydown", onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => titleRef.current?.focus?.(), 30);
    return () => {
      window.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [addOpen]);

  const generateSuggestion = async () => {
    if (!addTitle.trim()) return;
    setAdding(true);
    setError("");
    try {
      const r = await fetch(`${backendBase}/api/clinical-notes/suggest-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          transcript,
          title: addTitle.trim(),
          style: addStyle
        })
      });
      const j = await r.json();
      if (!j?.ok) {
        setError(j?.error || "Failed to generate section");
        return;
      }
      const md = j.section?.markdown || j.markdown || j.text || "";
      setAddPreview(md);
    } catch (e) {
      setError("Network error while generating section");
    } finally {
      setAdding(false);
    }
  };

  const insertSuggestion = () => {
    const text = (addPreview || "—").trim();
    const obj = { title: addTitle.trim() || "Custom Section", key: slugify(addTitle||"Custom Section"), text };
    if (addPos === "end" || !addAnchor) {
      const next = [...soap, obj]; setSoap(next); saveCache({ soap: next, hasStreamed: true });
    } else {
      const idx = soap.findIndex(s => s.key === addAnchor);
      const arr = [...soap];
      if (idx < 0) arr.push(obj);
      else if (addPos === "before") arr.splice(idx, 0, obj);
      else arr.splice(idx+1, 0, obj);
      setSoap(arr); saveCache({ soap: arr, hasStreamed: true });
    }
    setAddOpen(false);
  };

  const AddSectionModal = addOpen ? (
    <div
      className="cn-modal-overlay cn-modal-overlay--blur"
      role="dialog"
      aria-modal="true"
      aria-label="Add Section Modal"
      onClick={closeAdd}
    >
      <div className="cn-modal cn-modal--center" onClick={(e)=>e.stopPropagation()}>
        <div className="cn-modal-header">
          <div className="cn-modal-title">Add Section</div>
          <button type="button" className="cn-modal-close" onClick={closeAdd}>×</button>
        </div>

        {error ? <div className="cn-error">{error}</div> : null}

        <div className="cn-add-body">
          <div className="cn-field">
            <label>Title</label>
            <input ref={titleRef} className="cn-input" value={addTitle} onChange={(e)=>setAddTitle(e.target.value)} placeholder="e.g., Investigations" />
          </div>

          <div className="cn-row">
            <div className="cn-field" style={{flex:1}}>
              <label>Anchor</label>
              <select className="cn-input" value={addAnchor} onChange={(e)=>setAddAnchor(e.target.value)}>
                {soap.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
              </select>
              <div className="cn-help">Where to insert relative to this section</div>
            </div>
            <div className="cn-field" style={{flex:1}}>
              <label>Position</label>
              <div className="cn-radio-row">
                {["before","after","end"].map(p => (
                  <label key={p}><input type="radio" name="addpos" value={p} checked={addPos===p} onChange={()=>setAddPos(p)} /> {p}</label>
                ))}
              </div>
            </div>
          </div>

          <div className="cn-field">
            <label>Style</label>
            <div className="cn-radio-row">
              <label><input type="radio" name="addstyle" value="paragraph" checked={addStyle==="paragraph"} onChange={()=>setAddStyle("paragraph")} /> Paragraph</label>
              <label><input type="radio" name="addstyle" value="bullets" checked={addStyle==="bullets"} onChange={()=>setAddStyle("bullets")} /> Bullets</label>
            </div>
          </div>

          <div className="cn-modal-actions">
            <button type="button" className="cn-btn" onClick={generateSuggestion} disabled={!addTitle || adding}>
              {adding ? "Generating…" : "Generate with AI"}
            </button>
            <div className="cn-spacer" />
            <button type="button" className="cn-btn ghost" onClick={closeAdd}>Cancel</button>
            <button type="button" className="cn-btn primary" onClick={insertSuggestion} disabled={!addTitle}>Insert</button>
          </div>

          <div className="cn-field" style={{marginTop: 10}}>
            <label>Preview / Edit</label>
            <textarea
              className="cn-textarea"
              rows={10}
              value={addPreview}
              onChange={(e)=>setAddPreview(e.target.value)}
              placeholder="(generated or manual content; you can edit before inserting)"
            />
          </div>
        </div>
      </div>
    </div>
  ) : null;

  /* ===== ICD-10 Finder (RAG) in Edit mode + Quick Search toolbar ===== */
  const [icdBusy, setIcdBusy] = useState({}); // { [dx]: true/false }
  const [icdResults, setIcdResults] = useState({}); // { [dx]: [{code, label}] }
  const [icdOpen, setIcdOpen] = useState(true);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickResults, setQuickResults] = useState([]);

  const currentCodeFor = (dx) => {
    const row = (ddxRows || []).find(
      (r) => (r.diagnosis || "").toLowerCase() === String(dx || "").toLowerCase()
    );
    return row?.icd10 || "—";
  };

  const searchICD = async (dx) => {
    if (!dx) return;
    setIcdBusy((p) => ({ ...p, [dx]: true }));
    try {
      const r = await fetch(`${backendBase}/api/clinical-notes/icd10-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, query: dx, transcript: transcript || "" }),
      });
      const j = await r.json().catch(() => ({}));
      const arr = j?.results || j?.items || j?.codes || [];
      const norm = arr.map((x) => ({ code: x.code || x.icd10 || x.id || "", label: x.label || x.name || x.title || "" }))
                      .filter((x) => x.code && x.label);
      setIcdResults((p) => ({ ...p, [dx]: norm }));
    } catch {
      setIcdResults((p) => ({ ...p, [dx]: [] }));
    } finally {
      setIcdBusy((p) => ({ ...p, [dx]: false }));
    }
  };

  const quickSearch = async () => {
    const q = quickQuery.trim();
    if (!q) return;
    setQuickBusy(true);
    try {
      const r = await fetch(`${backendBase}/api/clinical-notes/icd10-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, query: q, transcript: transcript || "" }),
      });
      const j = await r.json().catch(() => ({}));
      const arr = j?.results || [];
      const norm = arr.map(x => ({ code: x.code, label: x.label })).filter(x => x.code && x.label);
      setQuickResults(norm);
    } catch {
      setQuickResults([]);
    } finally {
      setQuickBusy(false);
    }
  };

  const addQuickResultToDdx = (it) => {
    // Append to DDx draft (below) or directly to soap if no draft started yet
    const draft = ddxDraftRows.length ? [...ddxDraftRows] : [...ddxRows];
    draft.push({ diagnosis: it.label, icd10: it.code, probability: null });
    setDdxDraftRows(draft);
  };

  const applyICD = (dx, code) => {
    // write/append into DDx section in SOAP as bullet lines
    writeDdxToSoap(
      ddxRows.map(r => r.diagnosis === dx ? { ...r, icd10: code } : r)
    );
  };

  /* ===== Editable DDx table (Preview) ===== */
  const [ddxDraftRows, setDdxDraftRows] = useState([]);
  // whenever we switch into preview or soap changes, refresh draft
  useEffect(() => {
    if (!editMode) {
      setDdxDraftRows(ddxRows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, soap]);

  const clampProb = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  const writeDdxToSoap = (rows) => {
    // serialize as bullet lines, which your parser handles robustly
    const lines = (rows || [])
      .filter(r => (r.diagnosis || "").trim())
      .map(r => {
        const prob = r.probability == null || r.probability === "" ? "—" : `${clampProb(r.probability)}%`;
        const code = (r.icd10 && r.icd10 !== "—") ? `\`${r.icd10}\`` : "`—`";
        return `- ${r.diagnosis} | ${code} | ${prob}`;
      });
    const mdBlock = lines.length ? lines.join("\n") : "—";

    const arr = [...soap];
    let idx = arr.findIndex(s => /^(differential\s+diagnosis|differentials?)$/i.test((s.title||"").trim()));
    if (idx < 0) {
      arr.push({ key: "differential_diagnosis", title: "Differential Diagnosis", text: mdBlock });
    } else {
      arr[idx] = { ...arr[idx], text: mdBlock };
    }
    setSoap(arr);
    saveCache({ soap: arr, hasStreamed: hasStreamed || true });
  };

  const applyDdxDraftToNote = () => {
    writeDdxToSoap(ddxDraftRows);
  };

  /* ===== Section Card ===== */
  const SectionCard = ({ sec, idx }) => (
    <div className="cn-card" key={`${sec.key}-${idx}`}>
      <div className="cn-card-head">
        <input
          className="cn-title"
          value={sec.title}
          onChange={(e) => {
            const v = e.target.value;
            const arr = soap.map((x,i)=> i===idx ? {...x, title: v, key: slugify(v)} : x);
            setSoap(arr); saveCache({ soap: arr, hasStreamed: hasStreamed || true });
          }}
        />
        <div className="cn-card-actions">
          <button
            type="button"
            className="cn-mini is-danger"
            onClick={() => {
              const arr = [...soap]; arr.splice(idx, 1);
              setSoap(arr); saveCache({ soap: arr, hasStreamed: hasStreamed || true });
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="cn-mini is-ghost"
            onClick={() => openAdd("", sec.key, "after", "paragraph")}
            title="Open Add Section popup"
          >
            + Section
          </button>
          <button
            type="button"
            className="cn-mini is-primary"
            onClick={() => openAdd("", sec.key, "after", "paragraph")}
            title="Add new section after this one (AI or manual)"
          >
            Add w/ AI
          </button>
        </div>
      </div>

      <textarea
        className="cn-textarea"
        placeholder={`Write ${sec.title}…`}
        value={sec.text}
        onChange={(e) => {
          const v = e.target.value;
          const arr = soap.map((x,i)=> i===idx ? {...x, text: v} : x);
          setSoap(arr); saveCache({ soap: arr, hasStreamed: hasStreamed || true });
        }}
      />
    </div>
  );

  /* ===== Manual PDF fallback ===== */
  const manualDownload = async () => {
    try {
      const blob = await pdfBuilder(
        <NotePDF title="Clinical Notes" soap={soap} ddxRows={ddxRows} logoDataUrl={logoDataUrl} />
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clinical-notes-${sessionId || "note"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error("PDF build failed", e);
      setError("PDF build failed. Try again.");
    }
  };

  return (
    <div className="cn-root">
      <div className="cn-toolbar">
        <div className="cn-tabs-inline">
          <button type="button" className={`cn-chip ${mode==='markdown'?'active':''}`} onClick={() => setMode("markdown")} disabled={streaming}>Markdown</button>
          <button type="button" className={`cn-chip ${mode==='json'?'active':''}`} onClick={() => setMode("json")} disabled={streaming}>JSON</button>
        </div>
        <div className="cn-spacer" />
        {!streaming && !hasStreamed ? (
          <button type="button" className="cn-btn" onClick={() => startStream(false)} disabled={!transcript}>Generate</button>
        ) : !streaming && hasStreamed ? (
          <button type="button" className="cn-btn" onClick={() => startStream(true)}>Regenerate</button>
        ) : (
          <button
            type="button"
            className="cn-btn danger"
            onClick={() => { try { controllerRef.current?.abort(); } catch {}; setStreaming(false); }}
          >
            Stop
          </button>
        )}
        <button type="button" className="cn-btn ghost" onClick={() => setEditMode(v=>!v)}>{editMode ? "Preview" : "Edit"}</button>
        <button type="button" className="cn-btn ghost" onClick={() => setOrganized(v=>!v)}>{organized ? "Ungroup" : "Organize"}</button>

        {/* Toolbar Add Section (opens same modal) */}
        <button type="button" className="cn-btn ghost" onClick={() => openAdd()}>Add Section</button>

        <button type="button" className="cn-btn primary" onClick={approveAndSave} disabled={streaming || !soap?.length}>Approve & Save</button>
      </div>

      {error && !addOpen ? <div className="cn-error">{error}</div> : null}

      {/* EDIT MODE: ICD-10 Finder + Quick Search */}
      {editMode && (
        <>
          <div className="cn-card" style={{ marginBottom: 10 }}>
            <div className="cn-card-head" style={{ marginBottom: 8 }}>
              <div className="cn-modal-title">ICD-10 Quick Search</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input
                className="cn-input"
                style={{ flex: "1 1 320px" }}
                placeholder="Search ICD-10 (e.g., migraine without aura)…"
                value={quickQuery}
                onChange={(e)=>setQuickQuery(e.target.value)}
              />
              <button className="cn-btn primary" onClick={quickSearch} disabled={quickBusy}>
                <FaSearch style={{ marginRight: 6 }} />
                {quickBusy ? "Searching…" : "Search"}
              </button>
            </div>

            {quickResults?.length ? (
              <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                {quickResults.map((it, i) => (
                  <div key={`${it.code}-${i}`} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", border: "1px solid var(--border)", borderRadius: 8, padding: 6 }}>
                    <div style={{ display: "grid", gap: 2 }}>
                      <div><strong>{it.code}</strong></div>
                      <div className="cn-help" style={{ maxWidth: 680 }}>{it.label}</div>
                    </div>
                    <button
                      className="cn-mini is-primary"
                      onClick={() => addQuickResultToDdx(it)}
                      title="Add as new DDx row"
                    >
                      Add to DDx
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {ddxRows?.length ? (
            <div className="cn-card" style={{ marginBottom: 10 }}>
              <div className="cn-card-head" style={{ marginBottom: 8 }}>
                <div className="cn-modal-title">ICD-10 Finder (by diagnosis)</div>
                <div className="cn-card-actions">
                  <button className="cn-mini is-ghost" onClick={() => setIcdOpen(v=>!v)}>{icdOpen ? "Hide" : "Show"}</button>
                </div>
              </div>

              {icdOpen && (
                <div style={{ display: "grid", gap: 6 }}>
                  {ddxRows.map((r, i) => {
                    const dx = r.diagnosis;
                    const results = icdResults[dx] || [];
                    const busy = !!icdBusy[dx];
                    return (
                      <div key={`${dx}-${i}`} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 8 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700 }}>{dx}</div>
                          <div style={{ marginLeft: "auto", opacity: 0.8 }}>Current: <code>{currentCodeFor(dx)}</code></div>
                          <button className="cn-mini is-primary" onClick={() => searchICD(dx)} disabled={busy}>
                            <FaSearch style={{ marginRight: 6 }} />
                            {busy ? "Searching…" : "Search ICD-10"}
                          </button>
                        </div>

                        {busy ? (
                          <div className="cn-help" style={{ marginTop: 6 }}>Looking up codes…</div>
                        ) : results.length ? (
                          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                            {results.map((it, j) => (
                              <div key={`${it.code}-${j}`} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", border: "1px solid var(--border)", borderRadius: 8, padding: 6 }}>
                                <div style={{ display: "grid", gap: 2 }}>
                                  <div><strong>{it.code}</strong></div>
                                  <div className="cn-help" style={{ maxWidth: 680 }}>{it.label}</div>
                                </div>
                                <button className="cn-mini is-primary" onClick={() => applyICD(dx, it.code)}>Apply</button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      {/* EDIT vs PREVIEW */}
      {editMode ? (
        <div className="cn-grid" role="region" aria-label="Edit Sections">
          {soap.map((sec, idx) => <SectionCard key={`${sec.key}-${idx}`} sec={sec} idx={idx} />)}
        </div>
      ) : (
        <div className="cn-card" ref={previewRef}>
          {/* Preview actions — robust PDF Download (two ways) */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <PDFDownloadLink
              document={<NotePDF title="Clinical Notes" soap={soap} ddxRows={ddxRows} logoDataUrl={logoDataUrl} />}
              fileName={`clinical-notes-${sessionId || "note"}.pdf`}
              className="cn-mini is-primary"
              style={{ textDecoration: "none" }}
            >
              {({ loading }) => (<><FaDownload style={{ marginRight: 6 }} />{loading ? "Building PDF…" : "Download PDF"}</>)}
            </PDFDownloadLink>

            <button className="cn-mini is-ghost" onClick={manualDownload} title="Alternate PDF builder (more robust in dev)">
              <FaDownload style={{ marginRight: 6 }} />
              Download PDF (Alt)
            </button>
          </div>

          {/* Markdown preview */}
          <div className="markdown">
            <ReactMarkdown remarkPlugins={gfm ? [gfm] : []}>
              {`# Clinical Note (${organized ? "Organized" : "SOAP"})\n\n${mdNow}\n`}
            </ReactMarkdown>
          </div>

          {/* Editable Differential Diagnosis table */}
          <div className="cn-ddx" style={{ marginTop: 16 }}>
            <h2> Differential Diagnosis (Editable) </h2>
            <div style={{ overflowX: "auto" }}>
              <table className="cn-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 240 }}>Diagnosis</th>
                    <th style={{ minWidth: 120 }}>ICD-10</th>
                    <th className="num" style={{ minWidth: 140 }}>Probability (%)</th>
                    <th className="num" style={{ minWidth: 120 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(ddxDraftRows || []).map((row, i) => (
                    <tr key={`ddx-edit-${i}`}>
                      <td>
                        <input
                          className="cn-input"
                          value={row.diagnosis || ""}
                          onChange={(e) => {
                            const next = [...ddxDraftRows];
                            next[i] = { ...next[i], diagnosis: e.target.value };
                            setDdxDraftRows(next);
                          }}
                          placeholder="Diagnosis name"
                        />
                      </td>
                      <td>
                        <input
                          className="cn-input"
                          value={row.icd10 || ""}
                          onChange={(e) => {
                            const next = [...ddxDraftRows];
                            next[i] = { ...next[i], icd10: e.target.value.toUpperCase() };
                            setDdxDraftRows(next);
                          }}
                          placeholder="e.g., G43.0"
                        />
                      </td>
                      <td className="num">
                        <input
                          className="cn-input"
                          type="number"
                          min={0}
                          max={100}
                          value={row.probability ?? ""}
                          onChange={(e) => {
                            const next = [...ddxDraftRows];
                            next[i] = { ...next[i], probability: e.target.value === "" ? null : clampProb(e.target.value) };
                            setDdxDraftRows(next);
                          }}
                          placeholder="0–100"
                          style={{ textAlign: "right" }}
                        />
                      </td>
                      <td className="num">
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            className="cn-mini is-ghost"
                            title="ICD-10 search for this diagnosis"
                            onClick={() => searchICD(row.diagnosis || "")}
                          >
                            <FaSearch />&nbsp;Find code
                          </button>
                          <button
                            className="cn-mini is-danger"
                            title="Remove row"
                            onClick={() => {
                              const next = [...ddxDraftRows];
                              next.splice(i, 1);
                              setDdxDraftRows(next);
                            }}
                          >
                            <FaMinus />&nbsp;Remove
                          </button>
                        </div>

                        {/* Inline suggestions if any */}
                        {(icdResults[row.diagnosis || ""] || []).length ? (
                          <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                            {(icdResults[row.diagnosis || ""] || []).slice(0, 4).map((it, j) => (
                              <button
                                key={`sugg-${i}-${j}`}
                                className="cn-mini is-primary"
                                onClick={() => {
                                  const next = [...ddxDraftRows];
                                  next[i] = { ...next[i], icd10: it.code };
                                  setDdxDraftRows(next);
                                }}
                              >
                                Use {it.code}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button
                className="cn-mini is-ghost"
                onClick={() => setDdxDraftRows([...ddxDraftRows, { diagnosis: "", icd10: "", probability: null }])}
              >
                <FaPlus />&nbsp;Add Row
              </button>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="cn-mini is-ghost" onClick={() => setDdxDraftRows(ddxRows)}>Rebuild from Note</button>
                <button className="cn-mini is-primary" onClick={applyDdxDraftToNote}>Apply to Note</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {streaming && (
        <div className="cn-streaming">
          <div className="cn-spinner" />
          <div className="cn-stream-box">
            <div className="cn-stream-title">Streaming clinical notes…</div>
            <pre>{streamBuf}</pre>
          </div>
        </div>
      )}

      {/* Centered modal */}
      {AddSectionModal}
    </div>
  );
}
