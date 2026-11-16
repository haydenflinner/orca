type AgentsListIndexJumpListener = (index: number) => void

const listeners = new Set<AgentsListIndexJumpListener>()

export function subscribeAgentsListIndexJump(listener: AgentsListIndexJumpListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Cmd+digit while the agents list is the sidebar body names a row in its filtered order. */
export function emitAgentsListIndexJump(index: number): void {
  for (const listener of listeners) {
    listener(index)
  }
}
