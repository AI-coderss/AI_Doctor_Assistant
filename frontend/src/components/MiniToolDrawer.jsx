import React, { useEffect,  useState } from "react";
import { FiMic, FiUpload } from "react-icons/fi";

/**
 * A faithful React port of your drawer:
 * - Uses the same structure: .wrap > .slide + .button (with <p> rotated)
 * - Auto-slides out after 2s like your jQuery setTimeout
 * - Toggles open/closed on click
 * - Two horizontal buttons inside the panel
 */
export default function MiniToolDrawer({ onRecord, onUpload, startOpen = true }) {
  const [open, setOpen] = useState(startOpen);

  // Auto-slide out after 2s (like your snippet)
  useEffect(() => {
    if (!startOpen) return;
    const t = setTimeout(() => setOpen(false), 2000);
    return () => clearTimeout(t);
  }, [startOpen]);

  return (
    <div className="wrap tooldrawer-wrap" role="region" aria-label="Tool Drawer">
      <div
        className="slide tooldrawer-slide"
        style={{ marginLeft: open ? "0px" : "-200px" }} // mimics your jQuery animate marginLeft
        aria-hidden={!open}
      >
        <div className="tb-row">
          <button className="tb-action" onClick={onRecord} type="button">
            <FiMic aria-hidden="true" />
            <span>Record Case</span>
          </button>
          <button className="tb-action" onClick={onUpload} type="button">
            <FiUpload aria-hidden="true" />
            <span>Upload Labs</span>
          </button>
        </div>
      </div>

      {/* Handle (rotated label) */}
      <div
        className="button tooldrawer-button"
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
        aria-controls="tooldrawer-panel"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen((v) => !v)}
      >
        <p>{open ? "Hide" : "Tools"}</p>
      </div>
    </div>
  );
}
