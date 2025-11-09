// src/components/Orb.jsx
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useLayoutEffect, useRef } from "react";
import "../styles/Orb.css";

import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { enhanceAudioScale } from "./audioLevelAnalyzer";

/**
 * Orb — transparent, circular, audio-reactive.
 * Stability: draw trail on an OFFSCREEN canvas (alpha:true) using `destination-out`
 * for fading, then composite onto the visible canvas with `source-over`.
 * => No black background, no freeze after WebRTC connects, perfect circular clip.
 */
export default function Orb({
  density = 50,        // points per ring (MAX)
  alphaDecay = 0.06,   // trail fade per frame on OFFSCREEN layer
  lineAlpha = 0.18,    // line opacity
  dprCap = 2,          // devicePixelRatio cap
  boost = 1.0,         // extra speed multiplier (e.g. 2.6 while AI speaks)
  className = "",
  style = {},          // e.g. { minHeight: 240 }
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);

  // offscreen buffer (transparent)
  const layerRef = useRef(null);
  const layerCtxRef = useRef(null);

  const rafRef = useRef(0);
  const pointsRef = useRef([]);
  const countRef = useRef(0);
  const roRef = useRef(null);
  const readyRef = useRef(false);

  // smooth audio -> speed
  const speedEmaRef = useRef(0);
  const emaAlpha = 0.22;

  // Build base points once
  useLayoutEffect(() => {
    const MAX = Math.max(8, density | 0);
    const pts = [];
    let r = 0;
    for (let a = 0; a < MAX; a++) {
      pts.push([Math.cos(r), Math.sin(r), 0]);
      r += (Math.PI * 2) / MAX;
    }
    for (let a = 0; a < MAX; a++) pts.push([0, pts[a][0], pts[a][1]]);
    for (let a = 0; a < MAX; a++) pts.push([pts[a][1], 0, pts[a][0]]);
    pointsRef.current = pts;
  }, [density]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    // Visible canvas: fully transparent
    const ctx = canvas.getContext("2d", { alpha: true });

    // Offscreen transparent layer (where we accumulate the trail)
    if (!layerRef.current) {
      layerRef.current = document.createElement("canvas");
      layerCtxRef.current = layerRef.current.getContext("2d", { alpha: true });
    }
    const layer = layerRef.current;
    const lctx  = layerCtxRef.current;

    let w = 0, h = 0;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) { readyRef.current = false; return; }
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);

      const W = Math.max(1, Math.floor(rect.width * dpr));
      const H = Math.max(1, Math.floor(rect.height * dpr));

      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W; canvas.height = H;
        canvas.style.width = rect.width + "px";
        canvas.style.height = rect.height + "px";
      }
      if (layer.width !== W || layer.height !== H) {
        layer.width = W; layer.height = H;
        // clear layer fully on resize
        lctx.globalCompositeOperation = "source-over";
        lctx.clearRect(0, 0, W, H);
      }
      w = W; h = H;
      readyRef.current = true;
    };

    // Make sure we measure after layout settles
    const kickMeasure = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          measure();
          try { window.dispatchEvent(new Event("resize")); } catch {}
        });
      });
    };

    if (typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver(measure);
      roRef.current.observe(host);
    } else {
      window.addEventListener("resize", measure);
    }
    kickMeasure();

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (!readyRef.current || !w || !h) { measure(); return; }

      // ===== speed from audio (keeps moving in silence) =====
      const raw = useAudioForVisualizerStore.getState().audioScale || 0;
      const enhanced = Math.max(0, enhanceAudioScale(raw));
      speedEmaRef.current = (1 - emaAlpha) * speedEmaRef.current + emaAlpha * enhanced;
      const idleFloor = 0.6;
      const speedFactor = Math.min(5.0, (idleFloor + 3.4 * speedEmaRef.current) * (boost || 1));

      // ===== OFFSCREEN TRAIL with transparent fade =====
      // fade existing pixels by reducing their alpha (no black paint)
      lctx.globalCompositeOperation = "destination-out";
      lctx.fillStyle = `rgba(0,0,0,${alphaDecay})`; // color ignored, alpha used
      lctx.fillRect(0, 0, w, h);

      // draw new lines additively on the transparent layer
      lctx.globalCompositeOperation = "lighter";

      countRef.current += speedFactor;
      let tim = countRef.current / 5;

      const MAX = Math.max(8, density | 0);
      const src = pointsRef.current;

      const cx = w / 2, cy = h / 2;
      const minSide = Math.min(w, h);

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
          x = x1 * z1; y = y1 * z1;
          p2.push([x, y, z]);
        }

        const scale = s * (minSide * 0.30);

        for (let d = 0; d < 3; d++) {
          for (let a = 0; a < MAX; a++) {
            const b = p2[d * MAX + a];
            const c = p2[((a + 1) % MAX) + d * MAX];
            lctx.beginPath();
            lctx.strokeStyle = `hsla(${((a / MAX) * 360) | 0}, 70%, 60%, ${lineAlpha})`;
            lctx.lineWidth = Math.max(0.6, Math.pow(6, b[2]));
            lctx.moveTo(b[0] * scale + cx, b[1] * scale + cy);
            lctx.lineTo(c[0] * scale + cx, c[1] * scale + cy);
            lctx.stroke();
          }
        }
      }

      // ===== Composite OFFSCREEN -> VISIBLE as a perfect circle =====
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(w, h) * 0.5, 0, Math.PI * 2);
      ctx.clip();
      // just paint the transparent layer normally (no alpha blow-up)
      ctx.drawImage(layer, 0, 0, w, h);
      ctx.restore();
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (roRef.current) roRef.current.disconnect();
      else window.removeEventListener("resize", measure);
    };
  }, [alphaDecay, lineAlpha, dprCap, density, boost]);

  return (
    <div ref={hostRef} className={`orbfx-host ${className}`} style={style}>
      <canvas ref={canvasRef} className="orbfx-canvas" aria-hidden="true" />
    </div>
  );
}


