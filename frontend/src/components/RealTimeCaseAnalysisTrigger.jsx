import React from "react";
import "../styles/RealTimeCaseAnalysis.css";

export default function RealTimeCaseAnalysisTrigger({ onInsertBubble }) {
  return (
    <button
      className="rtca-trigger-btn"
      onClick={() => onInsertBubble?.("[rtca]")}
      title="Start real-time case analysis"
    >
      Analyze Case (real-time)
    </button>
  );
}
