import React, { useEffect, useRef } from "react";
import "../styles/Orb.css";

/**
 * Orb — port of your “org” effect to React.
 * - Transparent background (no black fill)
 * - Fills parent (use a sized container or pass style)
 * - Unique class names (orbfx-*)
 * - Multi-instance safe
 */
export default function Orb({
  density = 50,        // number of points per ring (MAX)
  alphaDecay = 0.05,   // trail fade speed (0.03–0.08 looks good)
  lineAlpha = 0.15,    // line opacity for strokes
  dprCap = 2,          // cap devicePixelRatio for perf
  className = "",
  style = {},          // e.g., { minHeight: 300 }
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const pointsRef = useRef([]);
  const countRef = useRef(0);
  const roRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d");

    // Build points exactly like original “org” code
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
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      w = canvas.width; h = canvas.height;
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
      // Fade trail to transparent (not black): use destination-out
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${alphaDecay})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // Draw additive glowing lines
      ctx.globalCompositeOperation = "lighter";

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

        // Scale relative to canvas size so it’s perfectly centered & responsive
        const minSide = Math.min(w, h);
        const scale = s * (minSide * 0.3); // ≈120 at 400px base
        const cx = w / 2, cy = h / 2;

        for (let d = 0; d < 3; d++) {
          for (let a = 0; a < MAX; a++) {
            const b = p2[d * MAX + a];
            const c = p2[((a + 1) % MAX) + d * MAX];

            ctx.beginPath();
            ctx.strokeStyle = `hsla(${((a / MAX) * 360) | 0}, 70%, 60%, ${lineAlpha})`;
            ctx.lineWidth = Math.pow(6, b[2]);
            ctx.moveTo(b[0] * scale + cx, b[1] * scale + cy);
            ctx.lineTo(c[0] * scale + cx, c[1] * scale + cy);
            ctx.stroke();
          }
        }
      }

      countRef.current += 1;
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
