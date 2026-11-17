import type { CSSProperties } from 'react'

export type AgentTint = { h: number; s: number; l: number }

const GOLDEN_ANGLE = 137.508
/** Hues closer than this read as the same wash on a tinted row. */
const MIN_HUE_SEPARATION = 24

function paneKeyHash(paneKey: string): number {
  const identity = paneKey.slice(paneKey.lastIndexOf(':') + 1)
  let hash = 0
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) >>> 0
  }
  return hash
}

/** Tint by leaf id so a pane keeps its color across tab moves and restarts. */
export function preferredAgentTint(paneKey: string): AgentTint {
  const hash = paneKeyHash(paneKey)
  return {
    h: hash % 360,
    s: 58 + ((hash >> 8) % 4) * 9,
    l: 48 + ((hash >> 12) % 3) * 7
  }
}

function hueDistance(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360
  return gap > 180 ? 360 - gap : gap
}

/** Sibling disambiguation: lower hash keeps its preferred hue; the rest step the golden angle until clear. */
export function resolveAgentTints(
  keys: readonly string[],
  reservedHues: readonly number[] = []
): ReadonlyMap<string, AgentTint> {
  const ordered = [...new Set(keys)].sort(
    (a, b) => paneKeyHash(a) - paneKeyHash(b) || a.localeCompare(b)
  )
  const taken = [...reservedHues]
  const resolved = new Map<string, AgentTint>()
  for (const key of ordered) {
    const tint = preferredAgentTint(key)
    let hue = tint.h
    for (
      let tries = 0;
      tries < 15 && taken.some((other) => hueDistance(hue, other) < MIN_HUE_SEPARATION);
      tries++
    ) {
      hue = (hue + GOLDEN_ANGLE) % 360
    }
    resolved.set(key, { ...tint, h: Math.round(hue) })
    taken.push(hue)
  }
  return resolved
}

/** Carries the resolved hue into `hsl(var(--agent-tint))` consumers below the element. */
export function agentTintStyle(tint: AgentTint): CSSProperties {
  const style: CSSProperties & Record<'--agent-tint', string> = {
    '--agent-tint': `${tint.h} ${tint.s}% ${tint.l}%`
  }
  return style
}
