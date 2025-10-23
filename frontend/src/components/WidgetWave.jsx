// src/components/WidgetWave.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef } from "react";
import "../styles/WidgetWave.css";

/**
 * Props:
 *  - stream: MediaStream (live mic). If null or no audio track, shows a soft idle shimmer.
 *  - height?: number (px) container height hint; canvas fills width (default 160)
 *  - sensitivity?: number amplitude multiplier (default 1.6)
 *  - layers?: number of stacked waves (default 10)
 *  - onLevel?: (0..1) => void (optional) for syncing a mic halo (--level)
 *
 * Design goals:
 *  - Center-emphasized oscillation (biggest motion around center line), like your reference.
 *  - Frequency-domain magnitude drives the sine displacements.
 *  - Smooth, natural feel with RMS-based overall gain.
 */
const WidgetWave = ({
  stream,
  height = 160,
  sensitivity = 1.6,
  layers = 10,
  onLevel,
}) => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const freqBufRef = useRef(null);
  const timeBufRef = useRef(null);
  const addTrackDetachRef = useRef(null);

  useEffect(() => {
    teardown();
    sizeToParent();

    // Observe size to keep canvas crisp
    const ro = new ResizeObserver(sizeToParent);
    if (wrapRef.current) ro.observe(wrapRef.current);

    // If we have a stream but tracks not ready, listen for addtrack
    if (stream) {
      const ensure = () => {
        if (hasAudio(stream)) {
          setupFromStream(stream);
          detach();
        } else {
          // idle shimmer while waiting
          animate(true);
        }
      };
      const detach = () => {
        try { stream.removeEventListener?.("addtrack", ensure); } catch {}
        if (stream.onaddtrack === ensure) stream.onaddtrack = null;
        addTrackDetachRef.current = null;
      };

      if (hasAudio(stream)) {
        setupFromStream(stream);
      } else {
        try { stream.addEventListener?.("addtrack", ensure); } catch {}
        const old = stream.onaddtrack;
        stream.onaddtrack = function (ev) { ensure(ev); if (typeof old === "function") old(ev); };
        addTrackDetachRef.current = detach;
        animate(true);
      }
    } else {
      // no stream -> idle shimmer
      animate(true);
    }

    return () => {
      try { ro.disconnect(); } catch {}
      if (addTrackDetachRef.current) addTrackDetachRef.current();
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, height, sensitivity, layers]);

  const hasAudio = (ms) => ms?.getAudioTracks?.().length > 0;

  const sizeToParent = () => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const dpr = window.devicePixelRatio || 1;

    const W = Math.max(320, wrap.clientWidth);
    const H = Math.max(80, height);

    if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
  };

  const teardown = () => {
    // stop RAF
    try { if (rafRef.current) cancelAnimationFrame(rafRef.current); } catch {}
    rafRef.current = null;
    // close audio
    try { audioCtxRef.current?.close?.(); } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;
    freqBufRef.current = null;
    timeBufRef.current = null;
  };

  const setupFromStream = (ms) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const analyser = ctx.createAnalyser();

      // close to your reference: small FFT for smoothness
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;

      const src = ctx.createMediaStreamSource(ms);
      src.connect(analyser);

      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      freqBufRef.current = new Uint8Array(analyser.frequencyBinCount);
      timeBufRef.current = new Uint8Array(analyser.frequencyBinCount);

      animate(false);
    } catch (e) {
      // Fall back to idle if anything fails
      animate(true);
    }
  };

  const animate = (idle) => {
    const canvas = canvasRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(() => animate(idle)); return; }
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    const baseLine = H / 2;
    const maxAmplitude = H / 3.5; // like your reference
    const turbulence = 0.25;
    const waveCount = Math.max(1, layers);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // gradient similar to your example
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "rgba(255, 25, 255, 0.20)");
    grad.addColorStop(0.5, "rgba(25, 255, 255, 0.75)");
    grad.addColorStop(1, "rgba(255, 255, 25, 0.20)");

    // Pull data
    let level = 0.03;
    let freq = [];
    if (!idle && analyserRef.current && freqBufRef.current && timeBufRef.current) {
      const an = analyserRef.current;
      const fb = freqBufRef.current;
      const tb = timeBufRef.current;

      an.getByteFrequencyData(fb);   // for the wave modulation (0..255)
      an.getByteTimeDomainData(tb);  // for a smooth RMS level

      // compute RMS in time domain for a stable overall amplitude
      let sum = 0;
      for (let i = 0; i < tb.length; i++) {
        const v = (tb[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / tb.length);
      level = Math.max(0, Math.min(1, rms * 2.0));

      // Copy the frequency data into a regular array (cheap)
      freq = Array.from(fb);
    } else {
      // Build a fake gentle spectrum for idle shimmer
      const n = 128;
      const t = performance.now() / 1000;
      freq = Array.from({ length: n }, (_, i) => {
        const x = i / n;
        const env = Math.sin(Math.PI * x);
        return 64 + 48 * Math.sin(2 * Math.PI * (x * 2 + t * 0.35)) * env;
      });
      level = 0.05;
    }

    // Share level with parent (for mic halo)
    if (typeof onLevel === "function") onLevel(level);

    // Center-weighted, multi-layer drawing like your reference
    const sliceWidth = W / freq.length;
    const now = performance.now() / 1000;
    for (let j = 0; j < waveCount; j++) {
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = grad;
      ctx.shadowColor = "rgba(59,130,246,.35)";
      ctx.shadowBlur = 4;

      let x = 0;
      let lastX = 0;
      let lastY = baseLine;

      for (let i = 0; i < freq.length; i++) {
        const v = freq[i] / 128.0; // ~0..2 (center around ~1)
        const mid = freq.length / 2;
        const distanceFromMid = Math.abs(i - mid) / mid;          // 0 at center → 1 at edges
        const dampFactor = 1 - Math.pow((2 * i) / freq.length - 1, 2); // parabola peak at center

        // Emphasize the center region visibly
        const midBoost = 0.6 + 0.4 * (1 - distanceFromMid);

        // Overall amplitude scales with visual sensitivity and live level
        const A =
          maxAmplitude *
          dampFactor *
          (1 - distanceFromMid) *
          midBoost *
          (0.65 + 0.35 * level) * // slightly inflate with level
          sensitivity;

        const flipped = j % 2 ? 1 : -1;
        const freqBase = 0.05 + turbulence;
        const phase = now * 1.0 + j * 0.12; // stagger layers slightly
        const y = baseLine + Math.sin(i * (flipped * freqBase) + phase) * A * v;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          const xc = (x + lastX) / 2;
          const yc = (y + lastY) / 2;
          ctx.quadraticCurveTo(lastX, lastY, xc, yc);
        }

        lastX = x;
        lastY = y;
        x += sliceWidth;
      }

      ctx.lineTo(W, lastY);
      ctx.stroke();
    }

    rafRef.current = requestAnimationFrame(() => animate(idle));
  };

  return (
    <div ref={wrapRef} className="widget-wave" style={{ height }}>
      <canvas ref={canvasRef} className="widget-wave-canvas" />
    </div>
  );
};

export default WidgetWave;
