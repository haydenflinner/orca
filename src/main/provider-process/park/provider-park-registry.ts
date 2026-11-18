/** Park records name the detached supervisor of each session provider child; a live supervisor
 *  keeps the provider group and its buffered output available for adoption after an update restart. */
import { constants } from 'node:fs'
import { mkdir, lstat, open, opendir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'

const PARK_RECORD_VERSION = 1
const MAX_RECORD_BYTES = 8_192

const recordSchema = z.object({
  version: z.literal(PARK_RECORD_VERSION),
  parkId: z.string().min(8).max(64),
  sessionId: z.string().min(1).max(255),
  socketPath: z.string().min(1).max(4096),
  exitPath: z.string().min(1).max(4096),
  supervisorPid: z.number().int().min(2),
  createdAt: z.number().int().positive()
})

export type ProviderParkRecord = z.infer<typeof recordSchema>

export function providerParkDirectory(userDataPath?: string): string | null {
  try {
    const base = userDataPath ?? getAppEnvironment().getPath('userData')
    return base ? join(base, 'provider-park') : null
  } catch {
    return null
  }
}

/** POSIX sun_path is ~104 bytes; a deep user-data path leaves no room for the socket name. */
export function providerParkPaths(
  parkId: string,
  directory?: string | null
): { socketPath: string; recordPath: string; exitPath: string } | null {
  const dir = directory ?? providerParkDirectory()
  if (!dir) {
    return null
  }
  const socketPath = join(dir, `p-${parkId}.sock`)
  // Keep margin below the 104-byte domain-socket limit for long profile paths.
  if (socketPath.length > 96) {
    return null
  }
  return {
    socketPath,
    recordPath: join(dir, `p-${parkId}.json`),
    exitPath: join(dir, `p-${parkId}.exit.json`)
  }
}

export async function writeProviderParkRecord(record: ProviderParkRecord): Promise<void> {
  const path = recordPathFor(record)
  const tmp = `${path}.pending`
  const file = await open(tmp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(record))
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function recordPathFor(record: ProviderParkRecord): string {
  return join(recordDirectory(record), `p-${record.parkId}.json`)
}

function recordDirectory(record: ProviderParkRecord): string {
  return dirname(record.socketPath)
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH proves the pid is gone; anything else (EPERM, odd platforms) keeps it live.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

export async function readProviderParkRecord(path: string): Promise<ProviderParkRecord | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.size > MAX_RECORD_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        return null
      }
      const buffer = Buffer.alloc(info.size + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > info.size) {
        return null
      }
      return recordSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)))
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export type ProviderParkProbe = { record: ProviderParkRecord; live: boolean }

/** List every record whose supervisor process is still running. */
export async function listProviderParks(directory?: string | null): Promise<ProviderParkProbe[]> {
  const dir = directory ?? providerParkDirectory()
  if (!dir) {
    return []
  }
  const found: ProviderParkProbe[] = []
  let entries
  try {
    entries = await opendir(dir)
  } catch {
    return []
  }
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.exit.json')) {
      continue
    }
    const record = await readProviderParkRecord(join(dir, entry.name))
    if (record) {
      found.push({ record, live: pidAlive(record.supervisorPid) })
    }
  }
  return found
}

/** A dead supervisor leaves only stale files; live parks keep their record for adopters. */
export async function sweepProviderParkRegistry(directory?: string | null): Promise<void> {
  const dir = directory ?? providerParkDirectory()
  if (!dir) {
    return
  }
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
  const info = await lstat(dir).catch(() => null)
  if (!info?.isDirectory()) {
    return
  }
  for (const probe of await listProviderParks(dir)) {
    if (probe.live) {
      continue
    }
    await removeProviderParkFiles(probe.record)
  }
}

export async function removeProviderParkFiles(record: ProviderParkRecord): Promise<void> {
  await unlink(recordPathFor(record)).catch(() => {})
  await unlink(record.socketPath).catch(() => {})
  await unlink(record.exitPath).catch(() => {})
}
