import { useCallback, useSyncExternalStore } from 'react'

// Hands-free voice chat is a per-composer mode, not a preference: keyed by the draft scope
// (host\0worktree\0tab), so a tab switch never carries it into another conversation.
const armed = new Set<string>()
const listeners = new Set<() => void>()

export function setMobileNativeChatVoiceArmed(scope: string, next: boolean): void {
  if (next === armed.has(scope)) {
    return
  }
  if (next) {
    armed.add(scope)
  } else {
    armed.delete(scope)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function mobileNativeChatVoiceArmed(scope: string | null): boolean {
  return scope !== null && armed.has(scope)
}

export function useMobileNativeChatVoiceArmed(scope: string | null): boolean {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])
  return useSyncExternalStore(subscribe, () => mobileNativeChatVoiceArmed(scope))
}
