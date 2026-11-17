import { createContext, useContext, type ReactNode } from 'react'
import { preferredAgentTint, resolveAgentTints, type AgentTint } from './agent-tint'
import { recomputeOn } from '../recompute-on'

const AgentTintContext = createContext<ReadonlyMap<string, AgentTint> | null>(null)

/** Resolves sibling agent hues apart so adjacent rows never share a color. */
export function AgentTintProvider({
  keys,
  reservedHues,
  children
}: {
  keys: readonly string[]
  /** Hues already claimed by ancestors (e.g. a parent row above its children). */
  reservedHues?: readonly number[]
  children: ReactNode
}): React.JSX.Element {
  // Sibling arrays are rebuilt by selectors each render; identity is in the members.
  const tints = recomputeOn([keys.join(' '), reservedHues?.join(',')], () =>
    resolveAgentTints(keys, reservedHues)
  )
  return <AgentTintContext.Provider value={tints}>{children}</AgentTintContext.Provider>
}

/** The resolved sibling tint, or the preferred identity tint outside a provider. */
export function useAgentTint(paneKey: string): AgentTint {
  return useContext(AgentTintContext)?.get(paneKey) ?? preferredAgentTint(paneKey)
}
