// src/store/useSpecialtyStore.js
import { create } from "zustand";

const useSpecialtyStore = create((set, get) => ({
  sessionId: (() => {
    const saved = localStorage.getItem("sessionId");
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  })(),
  specialty: "",
  template: null,
  active: false,

  setSpecialty: (s) => set({ specialty: s }),
  setTemplate: (t) => set({ template: t }),
  activate: () => set({ active: true }),
  deactivate: () => set({ active: false }),

  reset: () => set({ specialty: "", template: null, active: false })
}));

export default useSpecialtyStore;
