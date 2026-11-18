import { spawnProcess } from '@orca/process-host'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_ONLY_NODE_ENV_KEYS
} from '../provider-process-supervisor'
import { PROVIDER_PARK_SPEC_ENV, type ProviderParkSpec } from './provider-park-protocol'
import {
  PROVIDER_PARK_BUFFER_CAP_BYTES,
  PROVIDER_PARK_DETACHED_TTL_MS,
  PROVIDER_PARK_INITIAL_ATTACH_MS,
  PROVIDER_PARK_SUPERVISOR_SCRIPT
} from './provider-park-supervisor-script'
import {
  providerParkDirectory,
  providerParkPaths,
  removeProviderParkFiles,
  writeProviderParkRecord,
  type ProviderParkRecord
} from './provider-park-registry'
import { ParkedProviderChild } from './parked-provider-child'

const PARK_SPAWN_CONNECT_TIMEOUT_MS = 10_000
const PARK_CONNECT_RETRY_MS = 40

export type ProviderParkLaunch = {
  command: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
}

function parkSpecEnv(spec: ProviderParkSpec): string {
  return Buffer.from(JSON.stringify(spec)).toString('base64')
}

export async function connectParkSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error(`provider park socket ${socketPath} is unreachable`)
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(socketPath)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }
      await delay(PARK_CONNECT_RETRY_MS)
    }
  }
}

export type ParkedProviderHandle = {
  child: ParkedProviderChild
  record: ProviderParkRecord | null
}

/** Adopt a provider already parked by a previous runtime; the caller removes stale records. */
export function adoptParkedProvider(
  record: ProviderParkRecord,
  connectTimeoutMs = PARK_SPAWN_CONNECT_TIMEOUT_MS
): ParkedProviderHandle {
  const child = new ParkedProviderChild(
    () => connectParkSocket(record.socketPath, connectTimeoutMs),
    {
      supervisorPid: record.supervisorPid,
      onSettled: (state) => {
        // Only a proven provider exit frees the record; lost transports may still be adoptable.
        if (state === 'exited') {
          void removeProviderParkFiles(record)
        }
      }
    }
  )
  return { child, record }
}

export type ProviderParkSpawnOptions = {
  stdinEndGraceMs?: number
  sigtermGraceMs?: number
  detachedTtlMs?: number
  bufferCapBytes?: number
  directory?: string | null
  connectTimeoutMs?: number
}

/** Spawn the detached supervisor for a launch, publish its record, and return its socket. */
export async function launchParkSupervisor(
  launch: ProviderParkLaunch,
  sessionId: string,
  options: ProviderParkSpawnOptions = {}
): Promise<{ socket: Socket; record: ProviderParkRecord }> {
  const parkId = randomBytes(8).toString('hex')
  const directory = options.directory ?? providerParkDirectory()
  const paths = providerParkPaths(parkId, directory)
  if (!paths || !directory) {
    throw new Error('provider park storage is unavailable')
  }
  const nodeEnv: Record<string, string> = {}
  const supervisorEnv: NodeJS.ProcessEnv = { ...launch.env }
  for (const key of PROVIDER_ONLY_NODE_ENV_KEYS) {
    const value = supervisorEnv[key]
    delete supervisorEnv[key]
    if (value !== undefined) {
      nodeEnv[key] = value
    }
  }
  const spec: ProviderParkSpec = {
    socketPath: paths.socketPath,
    exitPath: paths.exitPath,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd ?? process.cwd(),
    nodeEnv,
    stdinEndGraceMs: options.stdinEndGraceMs ?? PROVIDER_STDIN_END_GRACE_MS,
    sigtermGraceMs: options.sigtermGraceMs ?? PROVIDER_SIGTERM_GRACE_MS,
    initialAttachMs: PROVIDER_PARK_INITIAL_ATTACH_MS,
    detachedTtlMs: options.detachedTtlMs ?? PROVIDER_PARK_DETACHED_TTL_MS,
    bufferCapBytes: options.bufferCapBytes ?? PROVIDER_PARK_BUFFER_CAP_BYTES
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // No cwd on the supervisor: a missing provider folder must fail the provider, not the park.
  const raw = spawnProcess({
    program: process.execPath,
    args: ['-e', PROVIDER_PARK_SUPERVISOR_SCRIPT],
    env: {
      ...supervisorEnv,
      ELECTRON_RUN_AS_NODE: '1',
      [PROVIDER_PARK_SPEC_ENV]: parkSpecEnv(spec)
    },
    detached: true,
    stdio: 'ignore'
  })
  raw.unref()
  if (raw.pid === undefined) {
    raw.kill('SIGKILL')
    throw new Error('provider park supervisor did not start')
  }
  const record: ProviderParkRecord = {
    version: 1,
    parkId,
    sessionId,
    socketPath: paths.socketPath,
    exitPath: paths.exitPath,
    supervisorPid: raw.pid,
    createdAt: Date.now()
  }
  // Publish before connecting so a crash between connect attempts still names the park.
  await writeProviderParkRecord(record).catch(() => {})
  try {
    const socket = await connectParkSocket(
      paths.socketPath,
      options.connectTimeoutMs ?? PARK_SPAWN_CONNECT_TIMEOUT_MS
    )
    return { socket, record }
  } catch (error) {
    await removeProviderParkFiles(record)
    try {
      process.kill(raw.pid, 'SIGKILL')
    } catch {}
    throw error
  }
}

/** Spawn the provider under a fresh detached supervisor and publish its park record. */
export function spawnParkedProviderProcess(
  launch: ProviderParkLaunch,
  sessionId: string,
  options: ProviderParkSpawnOptions = {}
): { child: ParkedProviderChild } {
  const recordRef: { value: ProviderParkRecord | null } = { value: null }
  const child = new ParkedProviderChild(
    async () => {
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
