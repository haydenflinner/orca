/** Session providers spawned under a detached park supervisor survive an update restart;
 *  the next runtime adopts the live socket instead of losing the turn in flight. */
import { ORCA_AGENT_SESSION_ID_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { ParkedProviderChild } from './parked-provider-child'
import {
  connectParkSocket,
  launchParkSupervisor,
  type ProviderParkLaunch,
  type ProviderParkSpawnOptions
} from './provider-park-spawn'
import {
  listProviderParks,
  providerParkDirectory,
  removeProviderParkFiles,
  sweepProviderParkRegistry,
  type ProviderParkRecord
} from './provider-park-registry'

export const PROVIDER_PARK_DISABLE_ENV = 'ORCA_PROVIDER_PARK_DISABLE'
export const PROVIDER_PARK_ADOPT_DISABLE_ENV = 'ORCA_PROVIDER_PARK_ADOPT_DISABLE'

const PARK_ADOPT_CONNECT_TIMEOUT_MS = 2_000

/** Structured session children carry their Orca session id in the launch environment. */
export function providerParkSessionKey(env: NodeJS.ProcessEnv): string | null {
  const value = env[ORCA_AGENT_SESSION_ID_ENV]?.trim()
  return value || null
}

export function providerParkSupported(platform: NodeJS.Platform = process.platform): boolean {
  return (
    platform !== 'win32' &&
    process.env[PROVIDER_PARK_DISABLE_ENV] !== '1' &&
    providerParkDirectory() !== null
  )
}

function providerParkAdoptionEnabled(): boolean {
  return process.env[PROVIDER_PARK_ADOPT_DISABLE_ENV] !== '1'
}

export type SessionParkOptions = ProviderParkSpawnOptions & {
  adoptConnectTimeoutMs?: number
}

/**
 * A live park for the same session is adopted (its buffered output replays into the new
 * runtime); anything else spawns a fresh parked provider. Failed adoptions clear the stale
 * record so the next acquisition falls back to a clean spawn.
 */
export function openSessionParkedProvider(
  launch: ProviderParkLaunch,
  sessionId: string,
  options: SessionParkOptions = {}
): { child: ParkedProviderChild } | null {
  const directory = options.directory ?? providerParkDirectory()
  if (!directory) {
    return null
  }
  const recordRef: { value: ProviderParkRecord | null } = { value: null }
  const child = new ParkedProviderChild(
    async () => {
      if (providerParkAdoptionEnabled()) {
        const candidates = (await listProviderParks(directory))
          .filter((probe) => probe.live && probe.record.sessionId === sessionId)
          .sort((a, b) => b.record.createdAt - a.record.createdAt)
        for (const probe of candidates) {
          try {
            const socket = await connectParkSocket(
              probe.record.socketPath,
              options.adoptConnectTimeoutMs ?? PARK_ADOPT_CONNECT_TIMEOUT_MS
            )
            recordRef.value = probe.record
            return socket
          } catch {
            await removeProviderParkFiles(probe.record)
          }
        }
      }
      const launched = await launchParkSupervisor(launch, sessionId, options)
      recordRef.value = launched.record
      return launched.socket
    },
    {
      onSettled: (state) => {
        if (state === 'exited' && recordRef.value) {
          void removeProviderParkFiles(recordRef.value)
        }
      }
    }
  )
  return { child }
}

/** Remove stale park files at runtime install; live supervisors keep their records. */
export function sweepProviderParks(): Promise<void> {
  return sweepProviderParkRegistry()
}
