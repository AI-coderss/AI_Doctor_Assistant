import { create } from "zustand";

/**
 * Global live transcript stream for real-time UI rendering.
 * ChatInputWidget writes here; Chat.jsx reads to render a live "me" bubble.
 *
 * New fields:
 *  - active: session is running (RTC connected)
 *  - utteranceSeq: increments each time we finalize & start a new utterance
 */
const useLiveTranscriptStore = create((set, get) => ({
  active: false,
  isStreaming: false,   // kept for backward compatibility = same as 'active'
  text: "",
  utteranceSeq: 0,

  // begin a new streaming session (clears old text)
  startSession: () => set({ active: true, isStreaming: true, text: "", utteranceSeq: 0 }),

  // end the streaming session (keep current text visible; Chat.jsx finalizes)
  endSession: () => set({ active: false, isStreaming: false }),

  // legacy names (back-compat with existing imports)
  start: () => set({ active: true, isStreaming: true, text: "", utteranceSeq: 0 }),
  stop: () => set({ active: false, isStreaming: false }),

  // append a partial delta (adds a leading space if needed)
  appendDelta: (delta) =>
    set((s) => ({
      text: (s.text + (s.text ? " " : "") + String(delta || "").trim()).trim(),
    })),

  // set full / completed chunk
  setFull: (payload) => set({ text: String(payload || "").trim() }),

  // finalize current utterance & start a new one (session stays active)
  newUtterance: () =>
    set((s) => ({
      utteranceSeq: s.utteranceSeq + 1,
      text: "",
      active: true,
      isStreaming: true,
    })),

  // hard reset (optional)
  reset: () => set({ active: false, isStreaming: false, text: "", utteranceSeq: 0 }),
}));

export default useLiveTranscriptStore;


