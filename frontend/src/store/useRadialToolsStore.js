// useRadialToolsStore.js
// Global state for the radial tools (Zustand)
// npm i zustand

import { create } from "zustand";

export const TOOL_IDS = {
  RECORDER: "recorder",
  LABS: "labs",
  MEDS: "meds",
  DOSAGE: "dosage",
  IMAGING: "imaging",
  LAB_AGENT: "lab-agent",
};

const useRadialToolsStore = create((set, get) => ({
  // launcher menu (wheel)
  isMenuOpen: false,
  openMenu: () => set({ isMenuOpen: true }),
  closeMenu: () => set({ isMenuOpen: false }),
  toggleMenu: () => set({ isMenuOpen: !get().isMenuOpen }),

  // the currently active tool (global)
  activeTool: null, // one of TOOL_IDS or null
  setActiveTool: (toolId) => {
    // ensure wheel closes and tool is globally set
    set({ activeTool: toolId, isMenuOpen: false });
  },
  clearActiveTool: () => set({ activeTool: null }),

  // helpers
  isActive: (toolId) => get().activeTool === toolId,
}));

export default useRadialToolsStore;
