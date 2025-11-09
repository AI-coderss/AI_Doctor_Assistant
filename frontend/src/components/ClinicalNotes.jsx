/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx */
import React, { useEffect, useMemo, useRef, useState } from "react";
import "../styles/clinical-notes.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

const DEFAULT_SOAP = [
  { key: "subjective", title: "Subjective", text: "" },
  { key: "objective",  title: "Objective",  text: "" },
  { key: "assessment", title: "Assessment", text: "" },
  { key: "plan",       title: "Plan",       text: "" },
];

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
  }
  return out;
}

function stringifySoapMarkdown(soapArr) {
  return (soapArr || DEFAULT_SOAP)
    .map(s => `## ${s.title}\n${(s.text || "").trim() || "—"}`)
    .join("\n\n");
}

export default function ClinicalNotes({
  sessionId,
  transcript,
  autostart = true,
}) {
  const [mode, setMode] = useState("markdown"); // 'markdown' | 'json'
  const [streaming, setStreaming] = useState(false);
  const [streamBuf, setStreamBuf] = useState("");
  const [soap, setSoap] = useState(DEFAULT_SOAP);
  const [editMode, setEditMode] = useState(true);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  const controllerRef = useRef(null);

  const startStream = async () => {
    if (!transcript || streaming) return;
    setError("");
    setStreaming(true);
    setStreamBuf("");
    setDirty(false);
    if (controllerRef.current) controllerRef.current.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;

    try {
      const res = await fetch(`${BACKEND_BASE}/api/clinical-notes/soap-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, transcript, mode }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        setError("Failed to stream clinical notes.");
        setStreaming(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;
        setStreamBuf(acc);
      }
      // on complete: if markdown, parse to fields; if json, convert to markdown-ish fields
      if (mode === "json") {
        try {
          const obj = JSON.parse(acc.replace(/```json|```/gi, "").trim());
          const parsed = DEFAULT_SOAP.map(s => ({
            ...s,
            text: String(obj[s.key] || obj[s.title?.toLowerCase()] || "—"),
          }));
          setSoap(parsed);
        } catch {
          // fallback: store raw in Subjective
          setSoap(DEFAULT_SOAP.map((s,i)=> i===0 ? {...s, text: acc.trim()} : s));
        }
      } else {
        setSoap(parseMarkdownToSoap(acc));
      }
    } catch (e) {
      setError("Stream interrupted.");
    } finally {
      setStreaming(false);
      controllerRef.current = null;
    }
  };

  const stopStream = () => {
    try { controllerRef.current?.abort(); } catch {}
    setStreaming(false);
  };

  const approveAndSave = async () => {
    try {
      setError("");
      const note_markdown = stringifySoapMarkdown(soap);
      const res = await fetch(`${BACKEND_BASE}/api/clinical-notes/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, note_markdown }),
      });
      if (!res.ok) throw new Error();
      setDirty(false);
    } catch {
      setError("Failed to save the note.");
    }
  };

  useEffect(() => {
    if (autostart && transcript) startStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, transcript, mode]);

  const mdNow = useMemo(() => stringifySoapMarkdown(soap), [soap]);

  return (
    <div className="cn-root">
      <div className="cn-toolbar">
        <div className="cn-tabs-inline">
          <button className={`cn-chip ${mode==='markdown'?'active':''}`} onClick={() => setMode("markdown")} disabled={streaming}>Markdown</button>
          <button className={`cn-chip ${mode==='json'?'active':''}`} onClick={() => setMode("json")} disabled={streaming}>JSON</button>
        </div>
        <div className="cn-spacer" />
        {!streaming ? (
          <button className="cn-btn" onClick={startStream} disabled={!transcript}>Generate</button>
        ) : (
          <button className="cn-btn danger" onClick={stopStream}>Stop</button>
        )}
        <button className="cn-btn ghost" onClick={() => setEditMode(v=>!v)}>{editMode ? "Preview" : "Edit"}</button>
        <button className="cn-btn primary" onClick={approveAndSave} disabled={streaming || !soap?.length}>Approve & Save</button>
      </div>

      {error && <div className="cn-error">{error}</div>}

      {editMode ? (
        <div className="cn-grid">
          {soap.map((sec, idx) => (
            <div className="cn-card" key={sec.key}>
              <div className="cn-card-head">
                <input
                  className="cn-title"
                  value={sec.title}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSoap(prev => prev.map((x,i)=> i===idx ? {...x, title: v} : x));
                    setDirty(true);
                  }}
                />
                <div className="cn-card-actions">
                  <button
                    className="cn-chip"
                    onClick={() => {
                      const arr = [...soap];
                      arr.splice(idx, 1);
                      setSoap(arr);
                      setDirty(true);
                    }}
                    title="Remove section"
                  >Remove</button>
                  <button
                    className="cn-chip"
                    onClick={() => {
                      // add a sibling section after
                      const name = window.prompt("Section title", "Custom Section");
                      if (!name) return;
                      const arr = [...soap];
                      arr.splice(idx+1, 0, { key: name.toLowerCase().replace(/\s+/g,"_"), title: name, text: "" });
                      setSoap(arr);
                      setDirty(true);
                    }}
                    title="Add section after"
                  >+ Section</button>
                </div>
              </div>
              <textarea
                className="cn-textarea"
                placeholder={`Write ${sec.title}…`}
                value={sec.text}
                onChange={(e) => {
                  const v = e.target.value;
                  setSoap(prev => prev.map((x,i)=> i===idx ? {...x, text: v} : x));
                  setDirty(true);
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <pre className="cn-preview">{mdNow}</pre>
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
