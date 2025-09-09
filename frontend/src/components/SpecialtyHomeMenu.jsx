/* eslint-disable jsx-a11y/anchor-is-valid */
import React from "react";
import useSpecialtyStore from "../store/useSpecialtyStore";
import { generateTemplate, activateTemplate } from "../api/specialtyTemplate";

/**
 * Pure multi-level dropdown markup. No modal, no framer-motion.
 * Visibility is controlled via CSS :hover / :focus-within in Specialty.css.
 *
 * Props:
 * - onPicked?: () => void   // called after a specialty is selected (to force-close the menu)
 */

const TREE = {
  Medicine: [
    "cardiology",
    "endocrinology",
    "gastroenterology",
    "hematology",
    "infectious disease",
    "nephrology",
    "neurology",
    "pulmonology",
    "rheumatology",
  ],
  Surgery: [
    "general surgery",
    "orthopedics",
    "urology",
    "neurosurgery",
    "cardiothoracic surgery",
  ],
  "Women & Children": ["obgyn", "pediatrics", "neonatology", "reproductive medicine"],
  "Primary & Mental Health": [
    "family medicine",
    "geriatrics",
    "psychiatry",
    "addiction medicine",
  ],
  "Sense & Skin": ["dermatology", "ophthalmology", "ent"],
};

export default function SpecialtyHomeMenu({ onPicked }) {
  const { sessionId, specialty, setSpecialty, setTemplate, activate } = useSpecialtyStore();

  const onPick = async (s) => {
    try {
      setSpecialty(s);
      const gen = await generateTemplate(sessionId, s);
      if (gen?.template) {
        setTemplate(gen.template);
        await activateTemplate(sessionId, s, gen.template);
        activate();
      }
    } catch (e) {
      console.error("Failed to generate/activate template:", e);
    } finally {
      // tell parent to force-close even if cursor still hovers
      try { document.activeElement?.blur?.(); } catch {}
      onPicked?.();
    }
  };

  return (
    <ul className="dd-l1" role="menu" aria-label="Specialty categories">
      {Object.entries(TREE).map(([group, specs]) => (
        <li className="has-subs" key={group}>
          {/* Top-level category row (non-clickable) */}
          <a href="#" className="dd-link" onClick={(e) => e.preventDefault()}>
            <span>{group}</span>
            <span className="caret">›</span>
          </a>

          {/* Second-level: specialties */}
          <ul className="dd-l2" role="menu" aria-label={`${group} specialties`}>
            {specs.map((s) => (
              <li key={`${group}:${s}`}>
                <button
                  type="button"
                  className={`dd-action ${specialty === s ? "active" : ""}`}
                  onClick={() => onPick(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
