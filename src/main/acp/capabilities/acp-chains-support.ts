import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import { observeAcpForkSupport } from './acp-fork-support'

export type AcpChainsSupport = {
  /** Concurrent `session/prompt` on a named lane via `_meta["cognition.ai/chain"]`. */
  chains: boolean
  /** Concurrent `session/prompt` that steers the running turn instead of cancelling it. */
  midTurnPrompts: boolean
}

type ChainsSupport = NonNullable<AgentSessionOptionsResult['chainsSupport']>
const versions = new Map<string, string | null>()
const observations = new Map<string, { version: string; support: ChainsSupport }>()

/** Discovery belongs to the checked release; an upgrade cannot inherit its negative verdict. */
export function noteAcpChainsVersion(agent: string, version: string | null): void {
  if (versions.get(agent) !== version) {
    observations.delete(agent)
  }
  versions.set(agent, version)
}

export function acpInitializeChainsSupport(initialized: InitializeResponse): AcpChainsSupport {
  const meta = initialized.agentCapabilities?._meta
  return {
    chains: meta?.['cognition.ai/chains'] === true,
    midTurnPrompts: meta?.['cognition.ai/midTurnPrompts'] === true
  }
}

/** Record every initialize-time capability verdict Orca keeps for the agent. */
export function observeAcpInitializeSupports(agent: string, initialized: InitializeResponse): void {
  observeAcpForkSupport(agent, initialized)
  observeAcpChainsSupport(agent, initialized)
}

export function observeAcpChainsSupport(agent: string, initialized: InitializeResponse): void {
  const version = versions.get(agent) ?? initialized.agentInfo?.version
  if (version) {
    versions.set(agent, version)
    observations.set(agent, {
      version,
      support: acpInitializeChainsSupport(initialized).chains ? 'supported' : 'unsupported'
    })
  }
}

export function readAcpChainsSupport(agent: string): ChainsSupport {
  const observed = observations.get(agent)
  const version = versions.get(agent)
  return observed && (version === undefined || version === observed.version)
    ? observed.support
    : 'unknown'
}
