import { create } from "zustand";
import { persist } from "zustand/middleware";

const initialInputs = { drug: "", age: "", weight: "", condition: "" };
const initialResults = { dosage: "", regimen: "", notes: "" };

const useDosageStore = create(
  persist(
    (set, get) => ({
      isOpen: false,
      inputs: { ...initialInputs },
      results: { ...initialResults },
      loading: false,
      error: null,

      toggleOpen: (value) =>
        set((s) => ({ isOpen: typeof value === "boolean" ? value : !s.isOpen })),

      setInput: (key, value) =>
        set((s) => ({ inputs: { ...s.inputs, [key]: value } })),

      setInputs: (next) => set({ inputs: { ...next } }),
      setResults: (next) => set({ results: { ...next } }),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),

      resetResults: () => set({ results: { ...initialResults } }),
      resetAll: () =>
        set({
          inputs: { ...initialInputs },
          results: { ...initialResults },
          error: null,
          loading: false,
        }),
    }),
    { name: "dosage-store" }
  )
);

export default useDosageStore;
