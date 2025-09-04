import { create } from "zustand";

/**
 * Global live transcript stream for real-time UI rendering.
 * ChatInputWidget writes here; Chat.jsx reads to render a live "me" bubble.
 */
const useLiveTranscriptStore = create((set, get) => ({
  isStreaming: false,
  text: "",

  // begin a new streaming session (clears old text)
  start: () => set({ isStreaming: true, text: "" }),

  // append a partial delta (adds a leading space if needed)
  appendDelta: (delta) =>
    set((s) => ({
      text: (s.text + (s.text ? " " : "") + String(delta || "").trim()).trim(),
    })),

  // set full / completed chunk
  setFull: (payload) => set({ text: String(payload || "").trim() }),

  // stop streaming (keep text so Chat can keep showing it)
  stop: () => set({ isStreaming: false }),

  // hard reset (optional)
  reset: () => set({ isStreaming: false, text: "" }),
}));

export default useLiveTranscriptStore;
