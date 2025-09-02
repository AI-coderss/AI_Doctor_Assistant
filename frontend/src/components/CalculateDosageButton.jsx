import React, { useState } from "react";
import { motion } from "framer-motion";
import DosageCalculator from "./DosageCalculator";
import "../styles/DosageButton.css";

/**
 * Small pill toggle that sits beside your "Record The Case" button.
 * The calculator renders inline (NOT fixed) below your toolbar/content.
 */
export default function CalculateDosageButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="left-rail-actions">
        {/* Your existing Record button can live here too */}
        {/* <button className="record-btn">Record The Case</button> */}

        <motion.button
          type="button"
          className="calc-dose-btn"
          onClick={() => setOpen(v => !v)}
          initial={{ opacity: 0, y: 0 }}
          animate={{ opacity: 1, y: 0 }}
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

      {/* Place this exactly where you want the calculator to appear in-flow */}
      {open && <DosageCalculator onClose={() => setOpen(false)} />}
    </>
  );
}


