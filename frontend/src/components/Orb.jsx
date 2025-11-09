// src/components/Orb.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef } from "react";
import "../styles/Orb.css";

// 🔊 same stores/helpers as BaseOrb
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { enhanceAudioScale } from "./audioLevelAnalyzer";

/**
 * Orb — audio-reactive
 * Notes:
 *  - Renders ABOVE the ring halo via CSS z-index (see Orb.css).
 *  - Scale is clamped to stay inside the circular frame.
 */
export default function Orb({
  density = 50,        // points per ring (MAX)
  alphaDecay = 0.06,   // trail fade speed
  lineAlpha = 0.25,    // stroke opacity (bumped so it reads through halo)
  dprCap = 2,
  className = "",
  style = {},          // e.g. { minHeight: 300 }
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const pointsRef = useRef([]);
  const countRef = useRef(0);
  const roRef = useRef(null);

  // Smooth audio -> speed (EMA)
  const speedEmaRef = useRef(0);
  const emaAlpha = 0.22;

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d", { alpha: true });

    // Build base points
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

    let w = 0, h = 0, dpr = 1;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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

    if (typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver(resize);
      roRef.current.observe(host);
    } else {
      window.addEventListener("resize", resize);
    }
    resize();

    const tick = () => {
      // Audio → speed
      const raw = useAudioForVisualizerStore.getState().audioScale || 0;
      const enhanced = Math.max(0, enhanceAudioScale(raw));
      speedEmaRef.current = (1 - emaAlpha) * speedEmaRef.current + emaAlpha * enhanced;

      const speedFactor = Math.min(4.0, 0.6 + 3.4 * speedEmaRef.current);
      countRef.current += speedFactor;
      let tim = countRef.current / 5;

      // Fade trails
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${alphaDecay})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // Draw
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const MAX = density;
      const src = pointsRef.current;

      // Keep drawings nicely inside the ring:
      // use ~38% of the min side (gives breathing room inside the border/glow)
      const minSide = Math.min(w, h);
      const baseScale = minSide * 0.38;
      const cx = w / 2, cy = h / 2;

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

        const scale = s * baseScale;

        for (let d = 0; d < 3; d++) {
          for (let a = 0; a < MAX; a++) {
            const b = p2[d * MAX + a];
            const c = p2[((a + 1) % MAX) + d * MAX];

            ctx.beginPath();
            ctx.strokeStyle = `hsla(${((a / MAX) * 360) | 0}, 70%, 60%, ${lineAlpha})`;
            ctx.lineWidth = Math.max(0.7, Math.pow(5.5, b[2]));
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
    <div
      ref={hostRef}
      className={`orbfx-host ${className}`}
      style={style}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="orbfx-canvas" />
    </div>
  );
}
