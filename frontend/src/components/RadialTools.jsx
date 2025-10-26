/* RadialTools.jsx — center-bottom radial launcher (solid UI)
   - Center bottom positioning, wheel fully visible
   - Icons ARE the buttons (no secondary buttons)
   - Hover wedge aligned with cursor (no double-rotation bug)
   - Uses a global Zustand store so any component can react to activeTool changes
*/
import React, { useEffect, useMemo, useRef, useState } from "react";
import useRadialToolsStore from "../store/useRadialToolsStore";
import "../styles/RadialTools.css";

/**
 * items: [{ id, label, icon }]
 * - id must match one of your TOOL_IDS for easy routing in the app
 */
const RadialTools = ({
  items = [],
  wheelSize = 460,   // diameter
  centerSize = 118,  // inner disc diameter
  ringWidth = 22,    // ring thickness
  allowWheelRotate = true,
  startOpen = false,
}) => {
  const [rotorDeg, setRotorDeg] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(null);
  const faceRef = useRef(null);

  const { isMenuOpen, openMenu, closeMenu, toggleMenu, setActiveTool } = useRadialToolsStore();

  // start state
  useEffect(() => {
    if (startOpen) openMenu();
  }, [startOpen, openMenu]);

  // expose CSS variables for layout
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rt-size", `${wheelSize}px`);
    root.style.setProperty("--rt-center", `${centerSize}px`);
    root.style.setProperty("--rt-ring", `${ringWidth}px`);
    return () => {
      root.style.removeProperty("--rt-size");
      root.style.removeProperty("--rt-center");
      root.style.removeProperty("--rt-ring");
    };
  }, [wheelSize, centerSize, ringWidth]);

  const navItems = useMemo(() => items.filter(Boolean), [items]);
  const count = Math.max(navItems.length, 1);
  const sector = 360 / count;

  // global “close” events (parity with your app)
  useEffect(() => {
    const close = () => closeMenu();
    window.addEventListener("tools:close", close);
    window.addEventListener("close-tools-drawer", close);
    return () => {
      window.removeEventListener("tools:close", close);
      window.removeEventListener("close-tools-drawer", close);
    };
  }, [closeMenu]);

  // ESC closes the wheel
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && closeMenu();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeMenu]);

  // optional: rotate wheel with mouse wheel
  useEffect(() => {
    if (!isMenuOpen || !allowWheelRotate) return;
    const onWheel = (e) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const dir = Math.sign(e.deltaY || 1);
      setRotorDeg((prev) => {
        let x = prev + (dir > 0 ? sector : -sector);
        x = ((x % 360) + 360) % 360;
        return x;
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [isMenuOpen, allowWheelRotate, sector]);

  // cursor -> hover sector (compensate rotor)
  const onMouseMoveFace = (ev) => {
    if (!isMenuOpen || !faceRef.current) return;
    const r = faceRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = ev.clientX - cx;
    const dy = ev.clientY - cy;
    let a = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
    if (a < 0) a += 360;                           // 0..360
    let idx = Math.floor((((a - rotorDeg) % 360) + 360) % 360 / sector);
    if (idx < 0) idx += count;
    setHoverIdx(idx);
  };
  const clearHover = () => setHoverIdx(null);

  // ✅ wedge must NOT re-add rotor (already compensated above)
  const wedgeStart = ((hoverIdx ?? 0) * sector) % 360;

  // icon click => setActiveTool (global), wheel closes automatically in store
  const handleItemClick = (i) => {
    const it = navItems[i];
    if (!it?.id) return;
    setActiveTool(it.id);
  };

  return (
    <div className={`rt-root rt-center ${isMenuOpen ? "open" : ""}`}>
      {/* wheel */}
      {isMenuOpen && (
        <div
          ref={faceRef}
          className="rt-face"
          style={{
            "--rt-count": count,
            "--rt-rotor": `${rotorDeg}deg`,
            "--rt-sector-start": `${wedgeStart}deg`,
            "--rt-sector-sweep": `${sector}deg`,
          }}
          onMouseMove={onMouseMoveFace}
          onMouseLeave={clearHover}
        >
          <div className="rt-ring" />
          <div className="rt-separators" />
          <div className="rt-inner" />
          <div className="rt-wedge" aria-hidden />

          <div className="rt-rotor">
            {navItems.map((it, i) => {
              const isFocus = hoverIdx === i;
              return (
                <button
                  key={it.id || i}
                  className={`rt-item ${isFocus ? "is-focus" : ""}`}
                  style={{ "--i": i }}
                  title={it.label}
                  aria-label={it.label}
                  onClick={() => handleItemClick(i)}
                >
                  <span className="rt-icon">{it.icon}</span>
                  <span className="rt-label">{it.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* toggle */}
      <button
        className="rt-toggle"
        onClick={toggleMenu}
        aria-label={isMenuOpen ? "Close tools" : "Open tools"}
        title={isMenuOpen ? "Close" : "Tools"}
      >
        {isMenuOpen ? "✖" : "🛠️"}
      </button>
    </div>
  );
};

export default RadialTools;


