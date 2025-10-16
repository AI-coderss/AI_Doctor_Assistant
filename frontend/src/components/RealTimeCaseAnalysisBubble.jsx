import React, { useEffect, useMemo, useRef, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import "../styles/RealTimeCaseAnalysis.css";

/**
 * Read NDJSON or single-JSON responses as an async iterator of objects.
 */
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
      try {
        yield JSON.parse(line);
      } catch {
        /* ignore parse errors on partial frames */
      }
    }
  }
  try {
    const obj = JSON.parse(buf.trim());
    yield obj;
  } catch {
    /* ignore */
  }
}

export default function RealTimeCaseAnalysisBubble({
  backendBase,
  sessionId,
  topK = 4,
}) {
  const [transcript, setTranscript] = useState("");
  const [items, setItems] = useState([]); // [{label, p, icd10:[]}]
  const [labs, setLabs] = useState([]);
  const [radiology, setRadiology] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [notes, setNotes] = useState("");

  // WebRTC refs & guards
  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const mountedRef = useRef(false);
  const startingRef = useRef(false);

  // Analyzer control
  const abortRef = useRef(null);
  const lastSentRef = useRef("");
  const debouncedTimer = useRef(null);

  // Highcharts donut options
  const donutOptions = (label, p) => ({
    chart: {
      type: "pie",
      backgroundColor: "transparent",
      height: 140,
      width: 140,
      margin: [0, 0, 0, 0],
      styledMode: true, // style via CSS (see RealTimeCaseAnalysis.css)
    },
    title: {
      text: `${Math.round((p || 0) * 100)}%`,
      align: "center",
      verticalAlign: "middle",
      y: 6,
    },
    tooltip: { enabled: false },
    plotOptions: {
      pie: {
        innerSize: "70%",
        dataLabels: { enabled: false },
        states: { hover: { enabled: false } },
        animation: { duration: 250 },
      },
    },
    series: [
      {
        name: label,
        data: [
          { name: label, y: Math.max(0.001, p || 0) },
          { name: "other", y: 1 - Math.max(0.001, p || 0) },
        ],
      },
    ],
    credits: { enabled: false },
    legend: { enabled: false },
  });

  /**
   * Robust WebRTC start with lifecycle/race guards.
   * - Prevent double starts
   * - Recreate PC if it becomes 'closed' while awaiting getUserMedia
   * - Skip work if unmounted mid-flight
   */
  const startWebRTC = async () => {
    if (startingRef.current) return;
    startingRef.current = true;

    let pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // Create the data channel up-front (helps some browsers include it in the offer)
    const dc = pc.createDataChannel("events");
    dataChannelRef.current = dc;

    dc.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (
          msg?.type === "response.audio_transcript.delta" &&
          typeof msg.delta === "string"
        ) {
          setTranscript((prev) => (prev + (msg.delta || " ")).slice(-8000));
        }
      } catch {
        /* ignore */
      }
    };

    try {
      // Mic permission / capture
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {}
        return;
      }
      localStreamRef.current = stream;

      // If PC got closed while awaiting GUM, rebuild once
      if (!pc || pc.signalingState === "closed") {
        try {
          pc?.close();
        } catch {}
        pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc;
        const dc2 = pc.createDataChannel("events");
        dataChannelRef.current = dc2;
        dc2.onmessage = dc.onmessage;
      }

      // Add tracks safely
      if (pc.signalingState === "closed")
        throw new Error("PC closed before addTrack");
      try {
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      } catch (e) {
        // Recreate once if addTrack fails due to closed state
        try {
          pc?.close();
        } catch {}
        const pc2 = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc2;
        const dc3 = pc2.createDataChannel("events");
        dataChannelRef.current = dc3;
        dc3.onmessage = dc.onmessage;
        stream.getTracks().forEach((tr) => pc2.addTrack(tr, stream));
        pc = pc2;
      }

      // Offer/answer
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      if (!mountedRef.current || pc.signalingState === "closed") return;
      await pc.setLocalDescription(offer);

      // IMPORTANT: we use your EXISTING backend endpoint — no duplication
      const res = await fetch(`${backendBase}/api/rtc-transcribe-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      const answer = await res.text();
      if (!mountedRef.current || pc.signalingState === "closed") return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      console.warn("RTCA WebRTC start error", err);
    } finally {
      startingRef.current = false;
    }
  };

  /**
   * Debounced analyzer call whenever transcript grows.
   * The backend streams a single NDJSON frame per request; we poll as text changes.
   */
  const kickAnalyze = () => {
    if (debouncedTimer.current) clearTimeout(debouncedTimer.current);
    debouncedTimer.current = setTimeout(async () => {
      const snapshot = transcript.trim();
      if (!snapshot || snapshot === lastSentRef.current) return;
      lastSentRef.current = snapshot;

      try {
        abortRef.current?.abort();
      } catch {}
      abortRef.current = new AbortController();

      try {
        const resp = await fetch(`${backendBase}/case-analysis-live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortRef.current.signal,
          body: JSON.stringify({ session_id: sessionId, transcript: snapshot }),
        });

        for await (const frame of streamJSONFrames(resp)) {
          if (frame?.diagnoses) setItems(Array.isArray(frame.diagnoses) ? frame.diagnoses : []);
          if (frame?.labs) setLabs(Array.isArray(frame.labs) ? frame.labs : []);
          if (frame?.radiology) setRadiology(Array.isArray(frame.radiology) ? frame.radiology : []);
          if (frame?.recommendations)
            setRecommendations(Array.isArray(frame.recommendations) ? frame.recommendations : []);
          if (frame?.notes !== undefined) setNotes(typeof frame.notes === "string" ? frame.notes : "");
          // visuals are already used by charts if you choose to wire them directly;
          // here we compute donuts from diagnoses for simplicity.
        }
      } catch (e) {
        if (!(e && e.name === "AbortError")) console.warn("analyze error", e);
      }
    }, 500); // ~real-time without spamming server
  };

  // Mount/unmount lifecycle
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        await startWebRTC();
      } catch (e) {
        console.warn("RTCA start failed", e);
      }
    })();
    return () => {
      mountedRef.current = false;
      try {
        dataChannelRef.current?.close();
      } catch {}
      try {
        pcRef.current?.getSenders?.().forEach((s) => s.track?.stop());
      } catch {}
      try {
        localStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch {}
      try {
        pcRef.current?.close();
      } catch {}
      dataChannelRef.current = null;
      pcRef.current = null;
      localStreamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kick analyzer on transcript growth
  useEffect(kickAnalyze, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps

  // Top-k diagnoses for donut minis
  const top = useMemo(() => (Array.isArray(items) ? items.slice(0, topK) : []), [items, topK]);

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
          {labs.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </details>

      <details className="rtca-accordion">
        <summary>Radiology</summary>
        <ul className="rtca-list">
          {radiology.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </details>

      <details className="rtca-accordion">
        <summary>Recommendations to the doctor</summary>
        <ul className="rtca-list">
          {recommendations.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
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
