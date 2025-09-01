import React, { useCallback, useRef, useState } from "react";
import "../styles/MedicalImageAnalysisPage.css";

const MedicalImageAnalysisPage = () => {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [modality, setModality] = useState("xray");
  const [bodyRegion, setBodyRegion] = useState("chest");
  const [notes, setNotes] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const dropRef = useRef(null);

  const onFilePicked = (f) => {
    if (!f) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setResult(null);
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

    try {
      // TODO: Replace with your real backend endpoint.
      // const form = new FormData();
      // form.append("image", file);
      // form.append("modality", modality);
      // form.append("body_region", bodyRegion);
      // form.append("notes", notes);
      // const res = await fetch("/api/medimg/analyze", { method: "POST", body: form });
      // const data = await res.json();

      // Mocked response for now:
      await new Promise((r) => setTimeout(r, 1200));
      const data = {
        findings: [
          { label: "Possible Infiltrate", confidence: 0.82 },
          { label: "Mild Pleural Effusion", confidence: 0.63 },
        ],
        impression:
          "Pattern suggests a lower-lobe process; correlate clinically. Consider follow-up imaging if symptoms persist.",
        meta: {
          modality,
          bodyRegion,
          modelVersion: "demo-v0.1",
          processingMs: 1180,
        },
      };

      setResult(data);
    } catch (err) {
      console.error(err);
      setResult({ error: "Analysis failed. Please try again." });
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="mia">
      <header className="mia__header">
        <h1>Medical Image Analysis</h1>
        <p>Upload an image (PNG/JPG) exported from DICOM or a standard medical image, choose options, and run analysis.</p>
      </header>

      <section className="mia__panel mia__controls" aria-label="Analysis configuration">
        <div className="mia__control">
          <label htmlFor="modality">Modality</label>
          <select
            id="modality"
            value={modality}
            onChange={(e) => setModality(e.target.value)}
          >
            <option value="xray">X-ray</option>
            <option value="ct">CT</option>
            <option value="mri">MRI</option>
            <option value="ultrasound">Ultrasound</option>
            <option value="fundus">Fundus (ophthalmology)</option>
          </select>
        </div>

        <div className="mia__control">
          <label htmlFor="region">Body Region</label>
          <select
            id="region"
            value={bodyRegion}
            onChange={(e) => setBodyRegion(e.target.value)}
          >
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
        <input
          id="mia-file"
          type="file"
          accept="image/*"
          onChange={onInputChange}
          hidden
        />
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
          <button
            className="mia__btn"
            disabled={isAnalyzing}
            onClick={analyze}
          >
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
                <h2>Findings</h2>
                <ul className="mia__findings">
                  {result.findings.map((f, i) => (
                    <li key={i} className="mia__finding">
                      <div className="mia__findingHead">
                        <span className="mia__findingLabel">{f.label}</span>
                        <span className="mia__confidence">
                          {Math.round(f.confidence * 100)}%
                        </span>
                      </div>
                      <div className="mia__bar">
                        <div
                          className="mia__barFill"
                          style={{ width: `${Math.max(6, Math.round(f.confidence * 100))}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mia__panel">
                <h2>Impression</h2>
                <p className="mia__impression">{result.impression}</p>
              </div>

              <div className="mia__meta">
                <span>Modality: <b>{result.meta.modality.toUpperCase()}</b></span>
                <span>Region: <b>{result.meta.bodyRegion}</b></span>
                <span>Model: <b>{result.meta.modelVersion}</b></span>
                <span>Time: <b>{result.meta.processingMs} ms</b></span>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default MedicalImageAnalysisPage;
