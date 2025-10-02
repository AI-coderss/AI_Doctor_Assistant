import React, { useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import DosageCalculator from "./DosageCalculator";
import "../styles/DosageButton.css";

/**
 * Small pill toggle that sits beside your other tools in the drawer grid.
 * The calculator itself renders OUTSIDE the drawer via a portal.
 */
export default function CalculateDosageButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="left-rail-actions">
        <motion.button
          type="button"
          className="calc-dose-btn"
          onClick={() => setOpen((v) => !v)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          aria-label="Open dosage calculator"
          title="Open dosage calculator"
        >
          <span className="calc-dose-btn__label">
            {open ? "Close Calculator" : "Calculate Dosage"}
          </span>
        </motion.button>
      </div>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <DosageCalculator onClose={() => setOpen(false)} />,
          document.body
        )}
    </>
  );
}
