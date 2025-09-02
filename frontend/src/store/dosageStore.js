// /store/dosageStore.js
import { create } from "zustand";
import { persist } from "zustand/middleware";

const initialInputs = { drug: "", age: "", weight: "", condition: "" };
const initialResults = { dosage: "", regimen: "", notes: "" };
const initialContext = {
  transcript: null,
  condition: null,
  description: null,
  age_years: null,
  weight_kg: null,
  drug_suggestions: [],
};

// Safe session id generator (works in browsers without crypto.randomUUID)
const genSessionId = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {}
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

const useDosageStore = create(
  persist(
    (set, get) => ({
      // ---------- UI ----------
      isOpen: false,
      toggleOpen: (value) =>
        set((s) => ({ isOpen: typeof value === "boolean" ? value : !s.isOpen })),

      loading: false,
      error: null,
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),

      // ---------- Session ----------
      sessionId: genSessionId(),
      setSessionId: (id) => set({ sessionId: id || genSessionId() }),
      newSession: () =>
        set({
          sessionId: genSessionId(),
          inputs: { ...initialInputs },
          results: { ...initialResults },
          context: { ...initialContext },
          error: null,
          loading: false,
        }),

      // ---------- Transcript (source of truth for case) ----------
      transcript: "",
      setTranscript: (t) => set({ transcript: t ?? "" }),
      appendTranscript: (chunk) =>
        set((s) => ({ transcript: (s.transcript || "") + (chunk || "") })),
      clearTranscript: () => set({ transcript: "" }),

      // ---------- Inputs / Results (UI fields) ----------
      inputs: { ...initialInputs },
      results: { ...initialResults },

      setInput: (key, value) =>
        set((s) => ({ inputs: { ...s.inputs, [key]: value } })),

      setInputs: (next) => set({ inputs: { ...initialInputs, ...(next || {}) } }),
      setResults: (next) => set({ results: { ...initialResults, ...(next || {}) } }),

      resetResults: () => set({ results: { ...initialResults } }),
      resetAll: () =>
        set({
          inputs: { ...initialInputs },
          results: { ...initialResults },
          context: { ...initialContext },
          error: null,
          loading: false,
        }),

      // ---------- Extracted Context (from backend strict extraction) ----------
      context: { ...initialContext },

      setContext: (ctx) =>
        set({
          context: {
            ...initialContext,
            ...(ctx || {}),
            // keep drug_suggestions always an array
            drug_suggestions: Array.isArray(ctx?.drug_suggestions)
              ? ctx.drug_suggestions
              : [],
          },
        }),

      mergeContext: (ctx) =>
        set((s) => {
          const next = { ...(s.context || {}), ...(ctx || {}) };
          if (!Array.isArray(next.drug_suggestions)) next.drug_suggestions = [];
          return { context: next };
        }),

      resetContext: () => set({ context: { ...initialContext } }),
    }),
    {
      name: "dosage-store",
      version: 2,
      // Backward-compatible migration
      migrate: (persistedState, fromVersion) => {
        const state = { ...(persistedState || {}) };

        // v1 -> v2 defaults
        if (fromVersion == null || fromVersion < 2) {
          if (!state.sessionId) state.sessionId = genSessionId();
          if (!state.context) state.context = { ...initialContext };
          if (typeof state.transcript !== "string") state.transcript = "";
          // Ensure shapes
          state.inputs = { ...initialInputs, ...(state.inputs || {}) };
          state.results = { ...initialResults, ...(state.results || {}) };
          // Normalize array
          if (!Array.isArray(state.context.drug_suggestions)) {
            state.context.drug_suggestions = [];
          }
        }

        return state;
      },
      // Only persist necessary parts
      partialize: (state) => ({
        isOpen: state.isOpen,
        sessionId: state.sessionId,
        transcript: state.transcript,
        inputs: state.inputs,
        results: state.results,
        context: state.context,
      }),
    }
  )
);

export default useDosageStore;

