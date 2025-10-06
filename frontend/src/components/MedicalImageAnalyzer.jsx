/* eslint-disable no-unused-vars */
import React, { useRef, useState } from "react";
import { motion } from "framer-motion";
import "../styles/MedicalVision.css";

const BACKEND_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";
const VISION_URL = `${BACKEND_BASE}/vision/analyze`;

export default function MedicalImageAnalyzer({ onResult }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onPick = () => inputRef.current?.click();

  const onFile = async (file) => {
    setErr("");
    if (!file || !file.type.startsWith("image/")) {
      setErr("Please choose an image file.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("image", file);
      // Optional instruction override for a particular case:
      // form.append("prompt", "Focus on pneumothorax signs.");

      const res = await fetch(VISION_URL, { method: "POST", body: form });
      const data = await (async () => {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return { error: await res.text() };
      })();

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const text = data?.text || "No analysis returned.";
      onResult?.(text, data?.meta || null);
    } catch (e) {
      setErr(e.message || "Failed to analyze image.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vision-tool">
      <motion.button
        type="button"
        className="vision-btn"
        onClick={onPick}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        disabled={busy}
        title="Analyze medical image"
        aria-label="Analyze medical image"
      >
        {busy ? "Analyzing…" : "Analyze Image"}
      </motion.button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />

      {err ? <div className="vision-error">{err}</div> : null}
    </div>
  );
}
