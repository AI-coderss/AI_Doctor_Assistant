/* eslint-disable jsx-a11y/anchor-is-valid */
import React from "react";
import useSpecialtyStore from "../store/useSpecialtyStore";

/**
 * Pure multi-level dropdown menu.
 * - No API calls here.
 * - On click of a specialty, we just set it in the store.
 * - The form sheet (mounted in Chat.jsx) will auto-open on specialty change.
 *
 * Structure:
 * <ul class="dd-l1">
 *   <li class="has-subs">
 *     <a class="dd-link">Medicine <span class="caret">›</span></a>
 *     <ul class="dd-l2">
 *       <li><button class="dd-action" onClick=...>cardiology</button></li>
 *       ...
 *     </ul>
 *   </li>
 *   ...
 * </ul>
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

export default function SpecialtyHomeMenu() {
  const { setSpecialty } = useSpecialtyStore();

  const onPick = (s) => {
    // 1) Set specialty -> opens the full-height form sheet (mounted in Chat.jsx)
    setSpecialty(s);

    // 2) Best-effort: notify navbar to close its dropdown (if it listens for this event)
    try {
      window.dispatchEvent(new CustomEvent("specialty:chosen", { detail: { specialty: s } }));
    } catch (_e) {}

    // 3) Remove focus to collapse any :focus-within CSS states
    try {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    } catch (_e) {}
  };

  return (
    <ul className="dd-l1" role="menu" aria-label="Specialty categories">
      {Object.entries(TREE).map(([group, specs]) => (
        <li className="has-subs" key={group}>
          {/* Top-level category row (non-navigating) */}
          <a href="#" className="dd-link" onClick={(e) => e.preventDefault()}>
            <span>{group}</span>
            <span className="caret" aria-hidden="true">›</span>
          </a>

          {/* Second-level: specialties */}
          <ul className="dd-l2" role="menu" aria-label={`${group} specialties`}>
            {specs.map((s) => (
              <li key={`${group}:${s}`}>
                <button
                  type="button"
                  className="dd-action"
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
