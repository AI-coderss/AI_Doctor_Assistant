/* eslint-disable react-hooks/exhaustive-deps */
import React, { useState, useEffect, useRef } from "react";
import {
  FaMicrophoneAlt,
  FaFlask,
  FaPills,
  FaCalculator,
  FaImage,
  FaRobot,
  FaTimes,
} from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import "../styles/chat-overrides.css"
/**
 * Enhanced Radial Tool Menu (Bottom-Center Launcher)
 *
 * Renders a fixed-position launcher button at the bottom-center of the screen.
 * - When clicked, the button moves up and the tool wheel animates around it.
 * - Listens to global wheel events for rotation when open.
 * - Displays one selected tool panel at a time.
 * - Handles special case for "Lab Agent" to launch its overlay.
 */
const DrawComponent = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [rotorDeg, setRotorDeg] = useState(0); // wheel-driven rotation
  const [selIdx, setSelIdx] = useState(0); // selection index
  const radialRef = useRef(null);

  // Close menu on global custom events
  useEffect(() => {
    const close = () => {
      setActiveIdx(null);
      setIsOpen(false);
    };
    window.addEventListener("tools:close", close);
    window.addEventListener("close-tools-drawer", close);
    return () => {
      window.removeEventListener("tools:close", close);
      window.removeEventListener("close-tools-drawer", close);
    };
  }, []);

  const items = React.Children.toArray(children);
  const count = Math.max(items.length, 1);
  const sector = 360 / count;

  // Define icons and labels for the 6 tools
  const defaultDefs = [
    { label: "Transcriber", icon: <FaMicrophoneAlt /> },
    { label: "Lab Results", icon: <FaFlask /> },
    { label: "Med Checker", icon: <FaPills /> },
    { label: "Dose Calc", icon: <FaCalculator /> },
    { label: "Image AI", icon: <FaImage /> },
    { label: "Lab Agent", icon: <FaRobot /> },
  ];
  const defs = items.map(
    (_, i) => defaultDefs[i] || { label: `Tool ${i + 1}`, icon: <FaFlask /> }
  );

  // Special handler for Lab Agent: click its button to launch overlay
  useEffect(() => {
    if (activeIdx === null) return;
    const isLabAgent = defs[activeIdx]?.label === "Lab Agent";
    if (!isLabAgent) return;

    // Find the button rendered in the panel and click it
    const t = setTimeout(() => {
      const btn = document.querySelector(".radial-panel .lab-agent-open-btn");
      try {
        btn && btn.click();
      } catch {}
      // Close the panel after triggering the overlay
      setActiveIdx(null);
    }, 50); // Small delay to ensure panel renders
    return () => clearTimeout(t);
  }, [activeIdx, defs]);

  // Normalize degrees to 0..360
  const norm = (d) => {
    let x = d % 360;
    if (x < 0) x += 360;
    return x;
  };

  // --- Global Wheel Rotation ---
  useEffect(() => {
    const onWheelGlobal = (e) => {
      if (!isOpen) return;
      // Prevent page scroll
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();

      const dir = Math.sign(e.deltaY) || 1;
      setRotorDeg((prev) => norm(prev + (dir > 0 ? sector : -sector)));
    };
    
    // Listen on the window for global rotation
    window.addEventListener("wheel", onWheelGlobal, { passive: false });
    return () => window.removeEventListener("wheel", onWheelGlobal);
  }, [isOpen, sector]); // Re-bind if 'isOpen' changes

  // --- Hover wedge tracks cursor ---
  const onMouseMove = (e) => {
    if (!isOpen) return;
    const el = radialRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const a = Math.atan2(dy, dx) * (180 / Math.PI); // -180..180
    const angle = norm(a); // 0..360
    
    // Map screen angle to item index, compensating for wheel rotation
    const idx = Math.floor(norm(angle - rotorDeg) / sector) % count;
    setHoverIdx(idx);
  };

  const onMouseLeave = () => setHoverIdx(-1);

  // Wedge start pos: snap to hover, else show selected
  const wedgeStartDeg =
    hoverIdx >= 0
      ? norm(Math.floor(norm(rotorDeg) + hoverIdx * sector))
      : norm(selIdx * sector + rotorDeg);

  // Click handler for radial items
  const onClickItem = (i) => {
    setActiveIdx(i);
    setSelIdx(i); // Keep this as the "selected" one
  };
  
  // Variants for staggered fade-in
  const listVariants = {
    open: {
      transition: { staggerChildren: 0.05, delayChildren: 0.1 },
    },
    closed: {
      transition: { staggerChildren: 0.03, staggerDirection: -1 },
    },
  };

  const itemVariants = {
    open: (i) => ({
      opacity: 1,
      transform: `rotate(${i * sector}deg) translateX(var(--radius)) scale(1)`,
      transition: { type: "spring", stiffness: 300, damping: 20 },
    }),
    closed: (i) => ({
      opacity: 0,
      transform: `rotate(${i * sector}deg) translateX(calc(var(--radius) - 30px)) scale(0.5)`,
      transition: { duration: 0.2 },
    }),
  };

  return (
    <>
      {/* 1. The Radial Menu (Fixed Position) */}
      <div 
        ref={radialRef}
        className={`radial-root ${isOpen ? "open" : ""}`}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <AnimatePresence>
          {isOpen && (
            <motion.div
              className="radial-face-container"
              style={{
                "--sector-start": `${wedgeStartDeg}deg`,
                "--sector-sweep": `${sector}deg`,
              }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              {/* Face (wedge + ticks) */}
              <div className="radial-face">
                <div className="radial-wedge" />
                <div className="radial-ticks" />
              </div>

              {/* Rotor (rotates with wheel scroll) */}
              <motion.div
                className="radial-rotor"
                style={{ rotate: rotorDeg }}
                variants={listVariants}
                initial="closed"
                animate="open"
                exit="closed"
              >
                <div className="radial-inner-disc" />
                {items.map((node, i) => {
                  const def = defs[i];
                  return (
                    <motion.button
                      key={i}
                      className="radial-item"
                      title={def.label}
                      aria-label={def.label}
                      onClick={() => onClickItem(i)}
                      variants={itemVariants}
                      custom={i}
                      style={{ "--angle": `${i * sector}deg` }}
                    >
                      <span className="radial-item-inner">
                        <span className="radial-item-icon">{def.icon}</span>
                        <span className="radial-item-label">{def.label}</span>
                      </span>
                    </motion.button>
                  );
                })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2. The Launcher Button (Center of the wheel) */}
        <button
          className="radial-toggle"
          title={isOpen ? "Close tools" : "Open tools"}
          onClick={() => {
            setIsOpen((p) => !p);
            if (isOpen) setActiveIdx(null); // Close panel if closing wheel
          }}
        >
          {isOpen ? "✖" : "🛠️"}
        </button>
      </div>

      {/* 3. The Tool Panel (Fixed Position) */}
      <AnimatePresence>
        {activeIdx !== null && (
          <motion.div
            className="radial-panel"
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="radial-panel-header">
              <div className="radial-panel-title">
                {defs[activeIdx]?.icon}
                <span>{defs[activeIdx]?.label || "Tool"}</span>
              </div>
              <button
                className="radial-panel-close"
                title="Close"
                onClick={() => setActiveIdx(null)}
              >
                <FaTimes />
              </button>
            </div>
            <div className="radial-panel-body">{items[activeIdx]}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default DrawComponent;