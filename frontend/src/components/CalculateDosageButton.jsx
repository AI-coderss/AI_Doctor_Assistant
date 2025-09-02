import React from "react";
import { motion } from "framer-motion";
import useDosageStore from "../store/dosageStore";
import DosageCalculator from "./DosageCalculator";
import "../styles/DosageButton.css";

const CalculateDosageButton = () => {
  const isOpen = useDosageStore((s) => s.isOpen);
  const toggleOpen = useDosageStore((s) => s.toggleOpen);

  return (
    <>
      {/* Put this wrapper next to your existing "Record The Case" button */}
      <div className="left-rail-actions">
        {/* Your existing record button remains where it is */}
        {/* <button className="record-btn">Record The Case</button> */}

        <motion.button
          className="calc-dose-btn"
          onClick={() => toggleOpen(true)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          aria-label="Open dosage calculator"
          title="Open dosage calculator"
        >
          CalculateDosage
        </motion.button>
      </div>

      {isOpen && <DosageCalculator />}
    </>
  );
};

export default CalculateDosageButton;

