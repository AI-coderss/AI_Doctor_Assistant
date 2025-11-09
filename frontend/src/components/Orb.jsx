// src/components/Orb.jsx
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef } from "react";
import "../styles/Orb.css";

// 🔊 reuse the exact hooks/deps from BaseOrb
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { enhanceAudioScale } from "./audioLevelAnalyzer";

/**
 * Orb — audio-reactive variant
 * - Transparent canvas, fills parent
 * - Multi-instance safe
 * - Speed scales with mic level via useAudioForVisualizerStore + enhanceAudioScale
 */
export default function Orb({
  density = 50,        // points per ring (MAX)
  alphaDecay = 0.05,   // trail fade speed
  lineAlpha = 0.15,    // stroke opacity
  dprCap = 2,          // devicePixelRatio cap for perf
  className = "",
  style = {},          // e.g. { minHeight: 300 }
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const pointsRef = useRef([]);
  const countRef = useRef(0);
  const roRef = useRef(null);

  // Smooth audio -> speed (EMA to prevent jitter)
  const speedEmaRef = useRef(0); // [0..~1]
  const emaAlpha = 0.22;         // smoothing factor

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d");

    // === Build points exactly like the original “org” code ===
    const buildPoints = (MAX) => {
      const pts = [];
      let r = 0;
      for (let a = 0; a < MAX; a++) {
        pts.push([Math.cos(r), Math.sin(r), 0]);
        r += (Math.PI * 2) / MAX;
      }
      for (let a = 0; a < MAX; a++) pts.push([0, pts[a][0], pts[a][1]]);
      for (let a = 0; a < MAX; a++) pts.push([pts[a][1], 0, pts[a][0]]);
      return pts;
    };
    pointsRef.current = buildPoints(density);

    let w = 0, h = 0;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const W = Math.max(1, Math.floor(rect.width * dpr));
      const H = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = rect.width + "px";
        canvas.style.height = rect.height + "px";
        w = W; h = H;
      }
    };

    // Observe host size
    if (typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver(resize);
      roRef.current.observe(host);
    } else {
      window.addEventListener("resize", resize);
    }
    resize();

    const tick = () => {
      // ---- AUDIO -> SPEED MAPPING (same store/enhancer as BaseOrb) ----
      const raw = useAudioForVisualizerStore.getState().audioScale || 0;
      const enhanced = Math.max(0, enhanceAudioScale(raw)); // ~[0..1+]

      // Exponential moving average to smooth spikes
      speedEmaRef.current =
        (1 - emaAlpha) * speedEmaRef.current + emaAlpha * enhanced;

      // Map EMA to a usable speed factor:
      // idle ≈ 0.6x; loud speech up to ≈ 4.0x (clamped)
      const speedFactor = Math.min(
        4.0,
        0.6 + 3.4 * speedEmaRef.current
      );

      // ---- TRAIL FADE (transparent, no black flash) ----
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${alphaDecay})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // ---- ADDITIVE GLOW LINES ----
      ctx.globalCompositeOperation = "lighter";

      // Increase tim progression with audio-driven speed
      countRef.current += speedFactor;
      let tim = countRef.current / 5;

      const MAX = density;
      const src = pointsRef.current;

      for (let e = 0; e < 3; e++) {
        tim *= 1.7;
        let s = 1 - e / 3;

        let a = tim / 59;
        const yp = Math.cos(a), yp2 = Math.sin(a);

        a = tim / 23;
        const xp = Math.cos(a), xp2 = Math.sin(a);

        const p2 = [];
        for (let i = 0; i < src.length; i++) {
          let x = src[i][0], y = src[i][1], z = src[i][2];

          const y1 = y * yp + z * yp2;
          let z1 = y * yp2 - z * yp;
          const x1 = x * xp + z1 * xp2;

          z  = x * xp2 - z1 * xp;
          z1 = Math.pow(2, z * s);

          x = x1 * z1;
          y = y1 * z1;
          p2.push([x, y, z]);
        }

        // Centered and responsive scale
        const minSide = Math.min(w, h);
        const scale = s * (minSide * 0.3);
        const cx = w / 2, cy = h / 2;

        for (let d = 0; d < 3; d++) {
          for (let a = 0; a < MAX; a++) {
            const b = p2[d * MAX + a];
            const c = p2[((a + 1) % MAX) + d * MAX];

            ctx.beginPath();
            ctx.strokeStyle = `hsla(${((a / MAX) * 360) | 0}, 70%, 60%, ${lineAlpha})`;
            ctx.lineWidth = Math.max(0.6, Math.pow(6, b[2]));
            ctx.moveTo(b[0] * scale + cx, b[1] * scale + cy);
            ctx.lineTo(c[0] * scale + cx, c[1] * scale + cy);
            ctx.stroke();
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (roRef.current) roRef.current.disconnect();
      else window.removeEventListener("resize", resize);
    };
  }, [density, alphaDecay, lineAlpha, dprCap]);

  return (
    <div ref={hostRef} className={`orbfx-host ${className}`} style={style}>
      <canvas ref={canvasRef} className="orbfx-canvas" aria-hidden="true" />
    </div>
  );
}
