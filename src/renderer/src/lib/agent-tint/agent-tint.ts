export const AGENT_TINT_COUNT = 8

/** Tint by leaf id so a pane keeps its color across tab moves and restarts. */
export function agentTintIndex(paneKey: string): number {
  const identity = paneKey.slice(paneKey.lastIndexOf(':') + 1)
  let hash = 0
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) >>> 0
  }
  return hash % AGENT_TINT_COUNT
}
