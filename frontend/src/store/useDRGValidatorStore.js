import { create } from "zustand";

const useDRGValidatorStore = create((set, get) => ({
  patientId: "",
  secondOpinion: null,   // parsed JSON
  iconVisible: false,
  open: false,
  loading: false,
  error: null,
  rows: [],
  summary: { validated: 0, review: 0, flagged: 0 },

  setPatientId: (id) => set({ patientId: id || "" }),
  setSecondOpinion: (json) => set({ secondOpinion: json || null, iconVisible: !!json }),
  hideIcon: () => set({ iconVisible: false }),
  toggleOpen: (v) => set({ open: typeof v === "boolean" ? v : !get().open }),

  validateNow: async (backendBase, sessionId) => {
    const { patientId, secondOpinion } = get();
    if (!patientId || !secondOpinion) return;
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${backendBase}/drg/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          patient_id: patientId,
          second_opinion_json: secondOpinion,
        }),
        credentials: "include",
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Validation failed");
      set({ rows: j.rows || [], summary: j.summary || { validated: 0, review: 0, flagged: 0 }, open: true });
    } catch (e) {
      set({ error: String(e?.message || e) });
    } finally {
      set({ loading: false });
    }
  },
}));

export default useDRGValidatorStore;
