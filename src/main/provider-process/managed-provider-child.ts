import { spawnProcess } from '@orca/process-host'
import type { ProviderChild } from './provider-child'
import type { ProviderProcessLaunch } from './provider-process-launch'
import { spawnProviderProcess, type ProviderProcessSpawner } from './provider-process-spawn'
import type {
  createProviderSpawnSpec,
  ProviderSupervisorLifetime
} from './provider-process-supervisor'
import {
  openSessionParkedProvider,
  providerParkSessionKey,
  providerParkSupported
} from './park/provider-park'

type SpawnManagedChildOptions = {
  spawnImpl?: ProviderProcessSpawner
  allowHost?: boolean
  lifetime?: ProviderSupervisorLifetime
  park?: boolean
}

/** Session providers park under a detached supervisor; custom spawners and one-shots stay in-process. */
export function spawnManagedChild(
  launch: ProviderProcessLaunch,
  spec: ReturnType<typeof createProviderSpawnSpec>,
  options: SpawnManagedChildOptions
): ProviderChild {
  const localSpawn = options.spawnImpl === undefined || options.spawnImpl === spawnProcess
  const sessionId =
    options.park === false || !localSpawn || options.lifetime === 'one-shot'
      ? null
      : providerParkSessionKey(spec.env)
  if (sessionId && providerParkSupported()) {
    const parked = openSessionParkedProvider(
      { command: launch.command, args: launch.args, cwd: spec.cwd, env: spec.env },
      sessionId
    )
    if (parked) {
      return parked.child
    }
  }
  return spawnProviderProcess(spec, options.spawnImpl, options.allowHost)
}
