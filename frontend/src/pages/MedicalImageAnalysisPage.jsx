import React, { useCallback, useRef, useState } from "react";
import "../styles/MedicalImageAnalysisPage.css";
import ChatInputWidget from "../components/ChatInputWidget";

const API_BASE = process.env.REACT_APP_API_BASE || ""; // e.g., "" for same origin, or "http://localhost:5000"

const MedicalImageAnalysisPage = () => {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [modality, setModality] = useState("xray");
  const [bodyRegion, setBodyRegion] = useState("chest");
  const [notes, setNotes] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [messages, setMessages] = useState([]); // {role:"user"|"assistant", text:string}

  const dropRef = useRef(null);

  const onFilePicked = (f) => {
    if (!f) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setResult(null);
    setSessionId(null);
    setMessages([]);
  };

  const onInputChange = (e) => {
    const f = e.target.files?.[0];
    onFilePicked(f);
  };

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.add("mia__drop--hover");
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove("mia__drop--hover");
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove("mia__drop--hover");
    const f = e.dataTransfer?.files?.[0];
    onFilePicked(f);
  }, []);

  const analyze = async () => {
    if (!file) return;
    setIsAnalyzing(true);
    setResult(null);
    setSessionId(null);
    setMessages([]);

    try {
      const form = new FormData();
      form.append("image", file);
      form.append("modality", modality === "xray" ? "radiology" : modality);
      form.append("body_region", bodyRegion);
      form.append("notes", notes);

      const res = await fetch(`${API_BASE}/api/medimg/analyze`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Analyze failed");
      setResult(data.result);
      setSessionId(data.session_id);
      setMessages([
        { role: "assistant", text: "Report generated. Ask any follow-up question below." },
      ]);
    } catch (err) {
      console.error(err);
      setResult({ error: "Analysis failed. Please try again." });
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Receive messages from ChatInputWidget
  const onSendMessage = async ({ text }) => {
    if (!text || !text.trim()) return;
    if (!sessionId) {
      setMessages((m) => [...m, { role: "assistant", text: "Please analyze an image first." }]);
      return;
    }
    setMessages((m) => [...m, { role: "user", text }]);
    setChatLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/medimg/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Chat failed");
      setMessages((m) => [...m, { role: "assistant", text: data.answer }]);
    } catch (e) {
      console.error(e);
      setMessages((m) => [...m, { role: "assistant", text: "Sorry—chat failed. Try again." }]);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="mia">
      <header className="mia__header">
        <h1>Medical Image Analysis</h1>
        <p>Upload an image (PNG/JPG), choose options, and generate a structured report. Then ask follow-up questions below.</p>
      </header>

      <section className="mia__panel mia__controls" aria-label="Analysis configuration">
        <div className="mia__control">
          <label htmlFor="modality">Modality</label>
          <select id="modality" value={modality} onChange={(e) => setModality(e.target.value)}>
            <option value="xray">X-ray</option>
            <option value="ct">CT</option>
            <option value="mri">MRI</option>
            <option value="ultrasound">Ultrasound</option>
            <option value="fundus">Fundus (ophthalmology)</option>
          </select>
        </div>

        <div className="mia__control">
          <label htmlFor="region">Body Region</label>
          <select id="region" value={bodyRegion} onChange={(e) => setBodyRegion(e.target.value)}>
            <option value="chest">Chest</option>
            <option value="abdomen">Abdomen</option>
            <option value="brain">Brain</option>
            <option value="musculoskeletal">Musculoskeletal</option>
            <option value="pelvis">Pelvis</option>
          </select>
        </div>

        <div className="mia__control mia__control--notes">
          <label htmlFor="notes">Clinical Notes (optional)</label>
          <textarea
            id="notes"
            value={notes}
            placeholder="e.g., cough, fever, post-op day 3…"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </section>

      <section
        className="mia__drop"
        ref={dropRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label="Upload area"
      >
        <input id="mia-file" type="file" accept="image/*" onChange={onInputChange} hidden />
        <label htmlFor="mia-file" className="mia__dropInner">
          <span className="mia__dropTitle">Drag & drop</span> an image here, or{" "}
          <span className="mia__browse">browse</span>
        </label>
      </section>

      {previewUrl && (
        <section className="mia__panel mia__preview" aria-label="Image preview">
          <figure className="mia__previewFigure">
            <img src={previewUrl} alt="Selected medical" />
          </figure>
          <button className="mia__btn" disabled={isAnalyzing} onClick={analyze}>
            {isAnalyzing ? "Analyzing…" : "Analyze"}
          </button>
        </section>
      )}

      {result && (
        <section className="mia__results" aria-live="polite" aria-label="Analysis results">
          {"error" in result ? (
            <div className="mia__panel mia__error">{result.error}</div>
          ) : (
            <>
              <div className="mia__panel">
                <h2>Structured Report (JSON)</h2>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>

              <div className="mia__panel">
                <h2>Follow-up Q&A</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: 12 }}>
                  {messages.map((m, i) => (
                    <div key={i} style={{
                      alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                      background: m.role === "user" ? "rgba(79,70,229,0.14)" : "rgba(15,23,42,0.06)",
                      borderRadius: 12,
                      padding: "10px 12px",
                      maxWidth: "min(680px, 100%)",
                      whiteSpace: "pre-wrap"
                    }}>
                      <b>{m.role === "user" ? "You" : "Assistant"}:</b> {m.text}
                    </div>
                  ))}
                  {chatLoading && (
                    <div style={{ fontStyle: "italic", color: "var(--mia-muted)" }}>
                      Thinking…
                    </div>
                  )}
                </div>

                {/* Chat input */}
                <ChatInputWidget onSendMessage={onSendMessage} />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default MedicalImageAnalysisPage;

