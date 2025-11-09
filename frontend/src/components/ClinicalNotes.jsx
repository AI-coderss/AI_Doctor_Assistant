/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx (centered modal, no restreams, ReactMarkdown preview, PDF download) */
/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx */
/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx — Preview shows a proper ICD-10 Differential Diagnosis table (no backend call) */
/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx — function-call aware, no restream on tab switch, DDx table in Preview */
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../styles/clinical-notes.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

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

/** extract DDx rows from current SOAP (same parser you saw before) */
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
    const parts = line.split("|").map(s => s.trim());
    let diagnosis = "", code = "", prob = null;

    if (parts.length >= 2) {
      diagnosis = parts[0];
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

export default function ClinicalNotes({ sessionId, transcript, autostart = true }) {
  const [mode, setMode] = useState("markdown");    // 'markdown' | 'json'
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

  const mdNow = useMemo(() => stringifySoapMarkdown(soap), [soap]);
  const ddxRows = useMemo(() => extractDdxFromSoap(soap), [soap]);

  const loadCache = () => {
    try { const raw = sessionStorage.getItem(storageKey(sessionId, mode)); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  const saveCache = (payload) => { try { sessionStorage.setItem(storageKey(sessionId, mode), JSON.stringify(payload)); } catch {} };

  const startStream = async (force = false) => {
    if (!transcript || streaming) return;
    if (hasStreamed && !force) return;

    setError(""); setStreaming(true); setStreamBuf("");
    try { controllerRef.current?.abort(); } catch {}
    const ctrl = new AbortController(); controllerRef.current = ctrl;

    try {
      const res = await fetch(`${BACKEND_BASE}/api/clinical-notes/soap-stream`, {
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
      const res = await fetch(`${BACKEND_BASE}/api/clinical-notes/save`, {
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

  /** ===== HelperAgent event bridge ===== **/
  useEffect(() => {
    const byKey = (k) => {
      const idx = (soap || []).findIndex(s => (s.key || "").toLowerCase() === String(k || "").toLowerCase());
      return [idx, idx >= 0 ? soap[idx] : null];
    };
    const setAndCache = (next) => { setSoap(next); saveCache({ soap: next, hasStreamed: hasStreamed || true }); };

    const onAdd = (e) => {
      const { title, key, text = "", position = "after", anchor_key } = e.detail || {};
      const obj = { key: key || slugify(title || "Custom Section"), title: title || "Custom Section", text: String(text || "") };
      if (!anchor_key || position === "end") {
        setAndCache([...(soap || []), obj]);
        return;
      }
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

    const onSave = () => { approveAndSave(); };
    const onPreview = () => { setEditMode(false); };

    window.addEventListener("cn:section.add", onAdd);
    window.addEventListener("cn:section.remove", onRemove);
    window.addEventListener("cn:section.update", onUpdate);
    window.addEventListener("cn:section.rename", onRename);
    window.addEventListener("cn:apply", onApply);
    window.addEventListener("cn:save", onSave);
    window.addEventListener("cn:preview", onPreview);

    return () => {
      window.removeEventListener("cn:section.add", onAdd);
      window.removeEventListener("cn:section.remove", onRemove);
      window.removeEventListener("cn:section.update", onUpdate);
      window.removeEventListener("cn:section.rename", onRename);
      window.removeEventListener("cn:apply", onApply);
      window.removeEventListener("cn:save", onSave);
      window.removeEventListener("cn:preview", onPreview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soap, hasStreamed]);

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
          <button className="cn-chip" onClick={() => {
            const arr = [...soap]; arr.splice(idx, 1); setSoap(arr); saveCache({ soap: arr, hasStreamed: hasStreamed || true });
          }}>Remove</button>
          <button className="cn-chip" onClick={() => {
            const custom = { title: "Custom Section", key: slugify("Custom Section"), text: "" };
            const arr = [...soap]; arr.splice(idx + 1, 0, custom);
            setSoap(arr); saveCache({ soap: arr, hasStreamed: hasStreamed || true });
          }}>+ Section</button>
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

  return (
    <div className="cn-root">
      <div className="cn-toolbar">
        <div className="cn-tabs-inline">
          <button className={`cn-chip ${mode==='markdown'?'active':''}`} onClick={() => setMode("markdown")} disabled={streaming}>Markdown</button>
          <button className={`cn-chip ${mode==='json'?'active':''}`} onClick={() => setMode("json")} disabled={streaming}>JSON</button>
        </div>
        <div className="cn-spacer" />
        {!streaming && !hasStreamed ? (
          <button className="cn-btn" onClick={() => startStream(false)} disabled={!transcript}>Generate</button>
        ) : !streaming && hasStreamed ? (
          <button className="cn-btn" onClick={() => startStream(true)}>Regenerate</button>
        ) : (
          <button className="cn-btn danger" onClick={() => { try { controllerRef.current?.abort(); } catch {}; setStreaming(false); }}>
            Stop
          </button>
        )}
        <button className="cn-btn ghost" onClick={() => setEditMode(v=>!v)}>{editMode ? "Preview" : "Edit"}</button>
        <button className="cn-btn ghost" onClick={() => setOrganized(v=>!v)}>{organized ? "Ungroup" : "Organize"}</button>
        <button className="cn-btn primary" onClick={approveAndSave} disabled={streaming || !soap?.length}>Approve & Save</button>
      </div>

      {error && <div className="cn-error">{error}</div>}

      {editMode ? (
        <div className="cn-grid">
          {soap.map((sec, idx) => <SectionCard key={`${sec.key}-${idx}`} sec={sec} idx={idx} />)}
        </div>
      ) : (
        <div className="cn-card" ref={previewRef}>
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
{`# Clinical Note (${organized ? "Organized" : "SOAP"})\n\n${mdNow}\n`}
            </ReactMarkdown>

            {ddxRows?.length ? (
              <div className="cn-ddx">
                <h2>Differential Diagnosis</h2>
                <table className="cn-table">
                  <thead>
                    <tr><th>Diagnosis</th><th>ICD-10</th><th className="num">Probability</th></tr>
                  </thead>
                  <tbody>
                    {ddxRows.map((r,i)=>(
                      <tr key={`${r.diagnosis}-${i}`}>
                        <td>{r.diagnosis}</td>
                        <td><code>{r.icd10 || "—"}</code></td>
                        <td className="num">{r.probability!=null ? `${r.probability}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
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
    </div>
  );
}

