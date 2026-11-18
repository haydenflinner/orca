import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { armProviderParkDetach, disarmProviderParkDetach } from './provider-park-detach-policy'
import { spawnParkedProviderProcess, type ProviderParkLaunch } from './provider-park-spawn'
import { openSessionParkedProvider } from './provider-park'
import { listProviderParks, pidAlive } from './provider-park-registry'
import type { ProviderChild } from '../provider-child'

const ECHO_PROVIDER = String.raw`
process.stdin.setEncoding('utf8')
let buffered = ''
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    process.stdout.write('echo:' + line + '\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`

const TICK_PROVIDER = String.raw`
setInterval(() => process.stdout.write('tick\n'), 30)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`

let root = ''
const children: { child: ProviderChild; closed: Promise<void> }[] = []

beforeEach(async () => {
  disarmProviderParkDetach()
  root = await mkdtemp(join(tmpdir(), 'orca-provider-park-'))
})

afterEach(async () => {
  for (const { child } of children) {
    child.kill('SIGKILL')
  }
  await Promise.allSettled(children.splice(0).map(({ closed }) => closed))
  await rm(root, { recursive: true, force: true })
})

function launch(script: string): ProviderParkLaunch {
  return {
    command: process.execPath,
    args: ['-e', script],
    cwd: root,
    env: { PATH: process.env.PATH ?? '' }
  }
}

type Tracked = {
  child: ProviderChild
  closed: Promise<void>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  output: () => string
  errors: Error[]
  untilOutput: (text: string) => Promise<void>
}

function track(child: ProviderChild): Tracked {
  let output = ''
  const errors: Error[] = []
  const readers = new Set<() => void>()
  child.on('error', (error) => errors.push(error))
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
    for (const reader of readers) {
      reader()
    }
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  children.push({ child, closed })
  return {
    child,
    closed,
    exit,
    errors,
    output: () => output,
    untilOutput: (text) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`missing output: ${text}; saw: ${output}`)),
          15_000
        )
        const check = (): void => {
          if (output.includes(text)) {
            clearTimeout(timer)
            readers.delete(check)
            resolve()
          }
        }
        readers.add(check)
        check()
      })
  }
}

function open(l: ProviderParkLaunch, sessionId: string) {
  const handle = openSessionParkedProvider(l, sessionId, { directory: root })
  if (!handle) {
    throw new Error('provider park open returned no child')
  }
  return handle
}

describe.runIf(process.platform !== 'win32')('parked provider child', () => {
  it('round-trips stdio and reports the provider exit through the supervisor', async () => {
    const spawned = spawnParkedProviderProcess(launch(ECHO_PROVIDER), 'session-a', {
      directory: root
    })
    const run = track(spawned.child)
    await run.child.ready
    run.child.stdin.write('hello\n')
    await run.untilOutput('echo:hello')
    run.child.stdin.end()
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toContain('echo:hello')
    expect(run.errors).toEqual([])
    await expect.poll(async () => (await listProviderParks(root)).length).toBe(0)
  })

  it('keeps the provider alive across detach and replays buffered output to an adopter', async () => {
    const firstSpawned = spawnParkedProviderProcess(launch(TICK_PROVIDER), 'session-b', {
      directory: root
    })
    const first = track(firstSpawned.child)
    await first.child.ready
    await first.untilOutput('tick')
    const providerPid = first.child.pid
    firstSpawned.child.parkDetach()
    await first.closed
    expect(providerPid).toBeDefined()
    expect(pidAlive(providerPid!)).toBe(true)
    await delay(150)

    const adopted = track(open(launch(TICK_PROVIDER), 'session-b').child)
    await adopted.child.ready
    expect(adopted.child.pid).toBe(providerPid)
    await adopted.untilOutput('tick')
    adopted.child.kill('SIGTERM')
    await adopted.closed
    await expect.poll(() => pidAlive(providerPid!), { timeout: 10_000 }).toBe(false)
  })

  it('detaches instead of stopping once the update-quit policy is armed', async () => {
    armProviderParkDetach()
    const run = track(
      spawnParkedProviderProcess(launch(ECHO_PROVIDER), 'session-c', {
        directory: root
      }).child
    )
    await run.child.ready
    run.child.stdin.write('stayed\n')
    await run.untilOutput('echo:stayed')
    const providerPid = run.child.pid
    run.child.stdin.end()
    await run.closed
    expect(pidAlive(providerPid!)).toBe(true)
    // A fresh runtime never has the update-quit policy armed; the adopted handle stops normally.
    disarmProviderParkDetach()

    const adopted = track(open(launch(ECHO_PROVIDER), 'session-c').child)
    await adopted.child.ready
    adopted.child.stdin.write('again\n')
    await adopted.untilOutput('echo:again')
    adopted.child.stdin.end()
    await expect(adopted.exit).resolves.toEqual({ code: 0, signal: null })
  })

  it('falls back to a fresh spawn when the recorded park is dead', async () => {
    const first = track(
      spawnParkedProviderProcess(launch(ECHO_PROVIDER), 'session-d', {
        directory: root
      }).child
    )
    await first.child.ready
    const [probe] = await listProviderParks(root)
    process.kill(probe.record.supervisorPid, 'SIGKILL')
    process.kill(-first.child.pid!, 'SIGKILL')
    await first.closed

    const next = track(open(launch(ECHO_PROVIDER), 'session-d').child)
    await next.child.ready
    expect(next.child.pid).not.toBe(first.child.pid)
    next.child.stdin.write('new\n')
    await next.untilOutput('echo:new')
    next.child.stdin.end()
    await next.closed
  })

  it('reaps the provider group when an attached client kills the child', async () => {
    const run = track(
      spawnParkedProviderProcess(launch(TICK_PROVIDER), 'session-e', {
        directory: root
      }).child
    )
    await run.child.ready
    await run.untilOutput('tick')
    const providerPid = run.child.pid!
    run.child.kill('SIGTERM')
    await run.closed
    await expect.poll(() => pidAlive(providerPid), { timeout: 10_000 }).toBe(false)
    await expect
      .poll(async () => (await readdir(root)).filter((name) => name.endsWith('.json')).length)
      .toBe(0)
  })
})
