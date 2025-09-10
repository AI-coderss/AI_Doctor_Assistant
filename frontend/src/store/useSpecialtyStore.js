// src/store/useSpecialtyStore.js
import { create } from "zustand";

const SESSION_KEY = "sessionId";
function getSessionId() {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // Fallback if storage blocked
    return "session-" + Math.random().toString(36).slice(2);
  }
}

const useSpecialtyStore = create((set, get) => ({
  // Session
  sessionId: getSessionId(),

  // Active specialty drives the form sheet
  specialty: null,
  setSpecialty: (s) => set({ specialty: s }),
  clearSpecialty: () => set({ specialty: null }),

  // (Optional) template controls for future use
  template: null,
  setTemplate: (t) => set({ template: t }),

  isActive: false,
  activate: () => set({ isActive: true }),
  deactivate: () => set({ isActive: false, template: null }),
}));

export default useSpecialtyStore;

