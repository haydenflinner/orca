import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'

/** Hands-free voice chat is a per-pane session mode, not a preference: keyed by composer paneKey. */
export type NativeChatVoiceModeSlice = {
  nativeChatVoiceModeArmed: Record<string, true>
  setNativeChatVoiceModeArmed: (paneKey: string, armed: boolean) => void
}

export const createNativeChatVoiceModeSlice: StateCreator<
  AppState,
  [],
  [],
  NativeChatVoiceModeSlice
> = (set) => ({
  nativeChatVoiceModeArmed: {},
  setNativeChatVoiceModeArmed: (paneKey, armed) =>
    set((state) => {
      const next = { ...state.nativeChatVoiceModeArmed }
      if (armed) {
        next[paneKey] = true
      } else {
        delete next[paneKey]
      }
      return { nativeChatVoiceModeArmed: next }
    })
})
