/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useRef, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import "../styles/RealTimeCaseAnalysis.css";

// Reader for NDJSON or single-JSON bodies
async function* streamJSONFrames(resp) {
  if (!resp?.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  }
  try { const obj = JSON.parse(buf.trim()); yield obj; } catch {}
}

export default function RealTimeCaseAnalysisBubble({ backendBase, sessionId }) {
  const [transcript, setTranscript] = useState("");
  const [items, setItems] = useState([]);          // [{label, p, icd10:[]}]
  const [labs, setLabs] = useState([]);
  const [radiology, setRadiology] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [notes, setNotes] = useState("");

  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const abortRef = useRef(null);
  const lastSentRef = useRef("");
  const debouncedTimer = useRef(null);

  // Donut options per item
  const donutOptions = (label, p) => ({
    chart: { type: "pie", backgroundColor: "transparent", height: 140, width: 140, margin: [0,0,0,0] },
    title: { text: `${Math.round(p * 100)}%`, align: "center", verticalAlign: "middle", y: 6,
             style: { fontSize: "14px", fontWeight: "800" } },
    tooltip: { enabled: false },
    plotOptions: {
      pie: {
        innerSize: "70%",
        dataLabels: { enabled: false },
        states: { hover: { enabled: false } },
        animation: { duration: 250 }
      }
    },
    series: [{
      name: label,
      data: [[label, Math.max(0.001, p)], ["", 1 - Math.max(0.001, p)]]
    }],
    credits: { enabled: false },
    legend: { enabled: false }
  });

  const startWebRTC = async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    const dc = pc.createDataChannel("events");
    dataChannelRef.current = dc;

    // OpenAI Realtime sends transcript deltas while transcription session is active
    dc.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg?.type === "response.audio_transcript.delta" && typeof msg.delta === "string") {
          setTranscript(prev => (prev + (msg.delta || " ")).slice(-8000));
        }
      } catch {
        /* ignore */
      }
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    // NOTE: your backend already exposes this WebRTC bridge
    const res = await fetch(`${backendBase}/api/rtc-transcribe-connect`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  };

  // Debounce analyzer calls
  const kickAnalyze = () => {
    if (debouncedTimer.current) clearTimeout(debouncedTimer.current);
    debouncedTimer.current = setTimeout(async () => {
      const snapshot = transcript.trim();
      if (!snapshot || snapshot === lastSentRef.current) return;
      lastSentRef.current = snapshot;

      try { abortRef.current?.abort(); } catch {}
      abortRef.current = new AbortController();

      try {
        const resp = await fetch(`${backendBase}/case-analysis-live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortRef.current.signal,
          body: JSON.stringify({ session_id: sessionId, transcript: snapshot })
        });
        for await (const frame of streamJSONFrames(resp)) {
          if (frame?.diagnoses) setItems(frame.diagnoses);
          if (frame?.labs) setLabs(frame.labs);
          if (frame?.radiology) setRadiology(frame.radiology);
          if (frame?.recommendations) setRecommendations(frame.recommendations);
          if (frame?.notes !== undefined) setNotes(frame.notes);
        }
      } catch (e) {
        if (!(e && e.name === "AbortError")) console.warn("analyze error", e);
      }
    }, 500); // feels live, protects backend
  };

  useEffect(() => {
    startWebRTC();
    return () => {
      try { pcRef.current?.close(); } catch {}
      try { localStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
      try { dataChannelRef.current?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(kickAnalyze, [transcript]); // analyze on transcript growth

  const top = useMemo(() => items.slice(0, 4), [items]);

  return (
    <div className="rtca-bubble">
      <div className="rtca-donuts">
        {top.map((d) => (
          <div key={d.label} className="rtca-donut-card">
            <HighchartsReact
              highcharts={Highcharts}
              options={donutOptions(d.label, d.p)}
              containerProps={{ className: "rtca-donut-chart" }}
            />
            <div className="rtca-dx-label">{d.label}</div>
            {Array.isArray(d.icd10) && d.icd10.length > 0 && (
              <div className="rtca-icd">ICD-10: {d.icd10.slice(0, 3).join(", ")}</div>
            )}
          </div>
        ))}
      </div>

      <details className="rtca-accordion" open>
        <summary>Recommended lab tests &amp; investigations</summary>
        <ul className="rtca-list">
          {labs.map((t, i) => (<li key={i}>{t}</li>))}
        </ul>
      </details>

      <details className="rtca-accordion">
        <summary>Radiology</summary>
        <ul className="rtca-list">
          {radiology.map((t, i) => (<li key={i}>{t}</li>))}
        </ul>
      </details>

      <details className="rtca-accordion">
        <summary>Recommendations to the doctor</summary>
        <ul className="rtca-list">
          {recommendations.map((t, i) => (<li key={i}>{t}</li>))}
        </ul>
      </details>

      <details className="rtca-accordion">
        <summary>Clinical notes (running)</summary>
        <div className="rtca-notes">{notes}</div>
      </details>

      <div className="rtca-transcript-peek">🎙️ {transcript.slice(-280)}</div>
    </div>
  );
}
