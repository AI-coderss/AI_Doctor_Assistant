/* eslint-disable no-unused-vars */
/* ClinicalNotes.jsx (centered modal, no restreams, ReactMarkdown preview) */
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../styles/clinical-notes.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

const DEFAULT_SOAP = [
    { key: "subjective", title: "Subjective", text: "" },
    { key: "objective", title: "Objective", text: "" },
    { key: "assessment", title: "Assessment", text: "" },
    { key: "plan", title: "Plan", text: "" },
];

const storageKey = (sid, mode) => `cn:${sid || "default"}:${mode || "markdown"}:v1`;

function parseMarkdownToSoap(md = "") {
    const out = DEFAULT_SOAP.map(x => ({ ...x }));
    const map = Object.fromEntries(out.map(s => [s.title.toLowerCase(), s]));
    const sections = md.split(/\n(?=##\s+)/g);
    for (const sec of sections) {
        const m = /^##\s+([^\n]+)\n?([\s\S]*)$/i.exec(sec.trim());
        if (!m) continue;
        const title = (m[1] || "").trim().toLowerCase();
        const body = (m[2] || "").trim();
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

function slugify(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64) || "custom_section";
}

export default function ClinicalNotes({
    sessionId,
    transcript,
    autostart = true,
}) {
    const [mode, setMode] = useState("markdown"); // 'markdown' | 'json'
    const [streaming, setStreaming] = useState(false);
    const [hasStreamed, setHasStreamed] = useState(false); // gate to prevent re-stream
    const [streamBuf, setStreamBuf] = useState("");
    const [soap, setSoap] = useState(DEFAULT_SOAP);
    const [editMode, setEditMode] = useState(true);        // Edit vs Preview
    const [organized, setOrganized] = useState(false);     // one-page organized view
    const [error, setError] = useState("");

    // Modal state
    const [showNewSection, setShowNewSection] = useState(false);
    const [insertIndex, setInsertIndex] = useState(-1); // -1=end, >=0 means based on section
    const [newSec, setNewSec] = useState({
        title: "Custom Section",
        key: "custom_section",
        defaultText: "",
        position: "after", // before|after|end
    });
    const [keyTouched, setKeyTouched] = useState(false);

    const controllerRef = useRef(null);
    const mountedRef = useRef(false);

    // ---- cache helpers ----
    const loadCache = () => {
        try {
            const raw = sessionStorage.getItem(storageKey(sessionId, mode));
            if (!raw) return null;
            return JSON.parse(raw);
        } catch { return null; }
    };
    const saveCache = (payload) => {
        try { sessionStorage.setItem(storageKey(sessionId, mode), JSON.stringify(payload)); } catch { }
    };

    // Derived markdown of current SOAP
    const mdNow = useMemo(() => stringifySoapMarkdown(soap), [soap]);

    // Start streaming (guarded to avoid re-streaming)
    const startStream = async (force = false) => {
        if (!transcript || streaming) return;
        if (hasStreamed && !force) return; // don't re-stream unless explicitly requested

        setError("");
        setStreaming(true);
        setStreamBuf("");

        // Abort any previous controller
        try { controllerRef.current?.abort(); } catch { }
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
                if (!mountedRef.current) break;
                setStreamBuf(acc);
            }

            // Parse into SOAP fields based on mode
            if (mode === "json") {
                try {
                    const obj = JSON.parse(acc.replace(/```json|```/gi, "").trim());
                    const parsed = DEFAULT_SOAP.map(s => ({
                        ...s,
                        text: String(obj[s.key] || obj[s.title?.toLowerCase()] || "—"),
                    }));
                    if (mountedRef.current) {
                        setSoap(parsed);
                        setHasStreamed(true);
                        saveCache({ soap: parsed, hasStreamed: true });
                    }
                } catch {
                    if (mountedRef.current) {
                        const fallback = DEFAULT_SOAP.map((s, i) => i === 0 ? { ...s, text: acc.trim() } : s);
                        setSoap(fallback);
                        setHasStreamed(true);
                        saveCache({ soap: fallback, hasStreamed: true });
                    }
                }
            } else {
                const parsed = parseMarkdownToSoap(acc);
                if (mountedRef.current) {
                    setSoap(parsed);
                    setHasStreamed(true);
                    saveCache({ soap: parsed, hasStreamed: true });
                }
            }
        } catch (e) {
            // Ignore AbortError (tab switch/unmount) -> prevents "Stream interrupted"
            const msg = String(e || "").toLowerCase();
            if (!(e?.name === "AbortError" || msg.includes("abort"))) {
                if (mountedRef.current) setError("Stream interrupted.");
            }
        } finally {
            if (mountedRef.current) setStreaming(false);
            controllerRef.current = null;
        }
    };

    const stopStream = () => {
        try { controllerRef.current?.abort(); } catch { }
        setStreaming(false);
        // silent stop; no error flash on tab switch/unmount
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
            // cache what we saved (so future mounts still skip streaming)
            saveCache({ soap, hasStreamed: true });
        } catch {
            setError("Failed to save the note.");
        }
    };

    // Mount / Unmount
    useEffect(() => {
        mountedRef.current = true;

        // Try to load from cache first to avoid re-streaming when returning to tab
        const cached = loadCache();
        if (cached && cached.soap) {
            setSoap(cached.soap);
            setHasStreamed(!!cached.hasStreamed);
        } else if (autostart && transcript) {
            // Only autostart if nothing cached
            startStream(false);
        }

        return () => {
            mountedRef.current = false;
            try { controllerRef.current?.abort(); } catch { }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]); // changing session resets this component

    // When title changes and key wasn’t manually touched, auto-suggest a key
    useEffect(() => {
        if (!showNewSection) return;
        if (!keyTouched) {
            setNewSec(prev => ({ ...prev, key: slugify(prev.title) }));
        }
    }, [newSec.title, keyTouched, showNewSection]);

    // ---- New Section modal helpers ----
    function openNewSectionModal(idx = -1) {
        setInsertIndex(typeof idx === "number" ? idx : -1);
        setNewSec({
            title: "Custom Section",
            key: "custom_section",
            defaultText: "",
            position: idx === -1 ? "end" : "after",
        });
        setKeyTouched(false);
        setShowNewSection(true);
    }

    function insertNewSection(e) {
        e?.preventDefault?.();
        const title = (newSec.title || "Custom Section").trim();
        const key = (newSec.key || slugify(title)).trim();
        const obj = { key, title, text: (newSec.defaultText || "").trim() };

        setSoap(prev => {
            const arr = [...prev];
            const where = newSec.position;
            if (insertIndex === -1 || where === "end") {
                arr.push(obj);
            } else if (where === "before") {
                arr.splice(insertIndex, 0, obj);
            } else {
                arr.splice(insertIndex + 1, 0, obj);
            }
            saveCache({ soap: arr, hasStreamed: hasStreamed || streaming });
            return arr;
        });
        setShowNewSection(false);
    }

    const SectionCard = ({ sec, idx }) => (
        <div className="cn-card" key={`${sec.key}-${idx}`}>
            <div className="cn-card-head">
                <input
                    className="cn-title"
                    value={sec.title}
                    onChange={(e) => {
                        const v = e.target.value;
                        const arr = soap.map((x, i) => i === idx ? { ...x, title: v } : x);
                        setSoap(arr);
                        saveCache({ soap: arr, hasStreamed: hasStreamed || streaming });
                    }}
                />
                <div className="cn-card-actions">
                    <button
                        className="cn-chip"
                        onClick={() => {
                            const arr = [...soap];
                            arr.splice(idx, 1);
                            setSoap(arr);
                            saveCache({ soap: arr, hasStreamed: hasStreamed || streaming });
                        }}
                        title="Remove section"
                    >Remove</button>
                    <button
                        className="cn-chip"
                        onClick={() => openNewSectionModal(idx)}
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
                    const arr = soap.map((x, i) => i === idx ? { ...x, text: v } : x);
                    setSoap(arr);
                    saveCache({ soap: arr, hasStreamed: hasStreamed || streaming });
                }}
            />
        </div>
    );

    return (
        <div className="cn-root">
            <div className="cn-toolbar">
                <div className="cn-tabs-inline">
                    <button className={`cn-chip ${mode === 'markdown' ? 'active' : ''}`} onClick={() => setMode("markdown")} disabled={streaming}>Markdown</button>
                    <button className={`cn-chip ${mode === 'json' ? 'active' : ''}`} onClick={() => setMode("json")} disabled={streaming}>JSON</button>
                </div>
                <div className="cn-spacer" />
                {!streaming && !hasStreamed ? (
                    <button className="cn-btn" onClick={() => startStream(false)} disabled={!transcript}>Generate</button>
                ) : !streaming && hasStreamed ? (
                    <button className="cn-btn" onClick={() => startStream(true)}>Regenerate</button>
                ) : (
                    <button className="cn-btn danger" onClick={stopStream}>Stop</button>
                )}
                <button className="cn-btn ghost" onClick={() => setEditMode(v => !v)}>{editMode ? "Preview" : "Edit"}</button>
                <button className="cn-btn ghost" onClick={() => setOrganized(v => !v)}>{organized ? "Ungroup" : "Organize"}</button>
                <button className="cn-btn primary" onClick={approveAndSave} disabled={streaming || !soap?.length}>Approve & Save</button>
                <button className="cn-btn ghost" onClick={() => openNewSectionModal(-1)} title="Add a new section at the end">+ New Section</button>
            </div>

            {error && <div className="cn-error">{error}</div>}

            {/* EDIT MODE */}
            {editMode ? (
                <div className="cn-grid">
                    {soap.map((sec, idx) => <SectionCard key={`${sec.key}-${idx}`} sec={sec} idx={idx} />)}
                </div>
            ) : (
                // PREVIEW MODE with ReactMarkdown
                <div className="cn-card">
                    {!organized ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {`# Clinical Note (SOAP)\n\n${mdNow}`}
                        </ReactMarkdown>
                    ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {`# Clinical Note (Organized)\n\n${mdNow}`}
                        </ReactMarkdown>
                    )}
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

            {/* New Section Modal */}
            {showNewSection && (
                <div className="cn-modal-overlay" onClick={() => setShowNewSection(false)}>
                    <div className="cn-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="cn-modal-header">
                            <div className="cn-modal-title">Add New Section</div>
                            <button className="cn-modal-close" onClick={() => setShowNewSection(false)}>✕</button>
                        </div>
                        <form onSubmit={insertNewSection}>
                            <div className="cn-field">
                                <label>Title</label>
                                <input
                                    className="cn-input"
                                    value={newSec.title}
                                    onChange={(e) => setNewSec(s => ({ ...s, title: e.target.value }))}
                                    placeholder="Custom Section"
                                    required
                                />
                            </div>
                            <div className="cn-field">
                                <label>Key</label>
                                <input
                                    className="cn-input"
                                    value={newSec.key}
                                    onChange={(e) => { setKeyTouched(true); setNewSec(s => ({ ...s, key: slugify(e.target.value) })); }}
                                    placeholder="custom_section"
                                />
                                <div className="cn-help">Lowercase, underscores only (auto-suggested from title).</div>
                            </div>
                            <div className="cn-field">
                                <label>Default Text</label>
                                <textarea
                                    className="cn-textarea"
                                    rows={4}
                                    value={newSec.defaultText}
                                    onChange={(e) => setNewSec(s => ({ ...s, defaultText: e.target.value }))}
                                    placeholder="Optional default content…"
                                />
                            </div>
                            <div className="cn-field">
                                <label>Insert Position</label>
                                <div className="cn-radio-row">
                                    <label><input type="radio" name="pos" checked={newSec.position === "before"} onChange={() => setNewSec(s => ({ ...s, position: "before" }))} /> Before current</label>
                                    <label><input type="radio" name="pos" checked={newSec.position === "after"} onChange={() => setNewSec(s => ({ ...s, position: "after" }))} /> After current</label>
                                    <label><input type="radio" name="pos" checked={newSec.position === "end"} onChange={() => setNewSec(s => ({ ...s, position: "end" }))} /> End</label>
                                </div>
                            </div>
                            <div className="cn-modal-actions">
                                <button type="button" className="cn-btn" onClick={() => setShowNewSection(false)}>Cancel</button>
                                <button type="submit" className="cn-btn primary">Add Section</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

