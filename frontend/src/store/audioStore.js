import { create } from "zustand";

const useAudioStore = create((set) => ({
  audioUrl: null, // MediaStream
  setAudioUrl: (stream) => set({ audioUrl: stream }),
  stopAudio: () => set({ audioUrl: null }),
}));

export default useAudioStore;