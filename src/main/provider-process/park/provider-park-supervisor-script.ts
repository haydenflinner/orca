import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS
} from '../provider-process-supervisor'

/** Output retained for a detached provider before its reads pause and back-pressure it. */
export const PROVIDER_PARK_BUFFER_CAP_BYTES = 16 * 1024 * 1024
/** A supervisor no client has ever reached was abandoned between spawn and connect. */
export const PROVIDER_PARK_INITIAL_ATTACH_MS = 5 * 60 * 1000
/** After the last client detaches, an unretrieved park stops on its own. */
export const PROVIDER_PARK_DETACHED_TTL_MS = 6 * 60 * 60 * 1000

/** Inline detached-supervisor source kept dependency-free for the spawned Node child. */
export const PROVIDER_PARK_SUPERVISOR_SCRIPT = `
const net = require('node:net')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_PARK_SPEC, 'base64').toString())
const HEADER = 5
const FRAME_STDIN = 0
const FRAME_STDIN_END = 1
const FRAME_STDOUT = 2
const FRAME_STDERR = 3
const FRAME_HELLO = 4
const FRAME_EXIT = 5
const MAX_FRAME = 32 * 1024 * 1024
const frame = (kind, payload) => {
  const body = payload || Buffer.alloc(0)
  const header = Buffer.alloc(HEADER)
  header.writeUInt32LE(body.length, 0)
  header.writeUInt8(kind, 4)
  return Buffer.concat([header, body])
}
const jsonFrame = (kind, value) => frame(kind, Buffer.from(JSON.stringify(value), 'utf8'))

const childEnv = { ...process.env, ...spec.nodeEnv }
delete childEnv.ORCA_PROVIDER_PARK_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE

let child = null
let spawnError = null
try {
  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })
} catch (error) {
  spawnError = { code: (error && error.code) || 'UNKNOWN', message: String(error && error.message) }
}

let client = null
let clientPaused = false
let everAttached = false
let lastClientGoneAt = Date.now()
let settling = false
let finished = false
let sigtermGraceCut = false
let providerExited = false
let exitCode = null
let exitSignal = null
let buffered = []
let bufferedBytes = 0
let readsPaused = false

const providerGroupExists = () => {
  if (!child || !child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs, stopWaiting = () => false) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline || stopWaiting()) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const reapProviderGroup = async () => {
  if (!child || !child.pid) return true
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  return waitForProviderGroupExit(${PROVIDER_GROUP_REAP_TIMEOUT_MS})
}

const pauseProviderReads = () => {
  if (readsPaused || !child) return
  readsPaused = true
  child.stdout.pause()
  child.stderr.pause()
}
const resumeProviderReads = () => {
  if (!readsPaused || !child) return
  readsPaused = false
  child.stdout.resume()
  child.stderr.resume()
}

const emit = (kind, chunk) => {
  if (!client || client.destroyed) {
    buffered.push({ kind, chunk })
    bufferedBytes += chunk.length
    if (bufferedBytes > spec.bufferCapBytes) pauseProviderReads()
    return
  }
  if (client.write(frame(kind, chunk)) === false) {
    clientPaused = true
    if (child) {
      child.stdout.pause()
      child.stderr.pause()
    }
  }
}

const reportExit = (code, signal, error) => {
  const report = { code: code ?? null, signal: signal ?? null, ...(error ? { error } : {}) }
  if (client && !client.destroyed) {
    try { client.write(jsonFrame(FRAME_EXIT, report)) } catch {}
  } else {
    try { fs.writeFileSync(spec.exitPath, JSON.stringify(report)) } catch {}
  }
}

const finish = (code) => {
  if (finished) return
  finished = true
  try { server.close() } catch {}
  try { fs.rmSync(spec.socketPath, { force: true }) } catch {}
  process.exit(code)
}

const stopProviderGroup = (receivedSignal) => {
  if (settling) return
  settling = true
  if (child && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
  }
  void waitForProviderGroupExit(spec.sigtermGraceMs, () => sigtermGraceCut)
    .then((exited) => exited || reapProviderGroup())
    .then((reaped) => {
      reportExit(
        providerExited ? exitCode : null,
        providerExited ? exitSignal : receivedSignal ?? 'SIGTERM',
        spawnError
      )
      finish(reaped ? 0 : 1)
    })
}

const flushBuffered = (sock) => {
  const held = buffered
  buffered = []
  bufferedBytes = 0
  resumeProviderReads()
  for (const item of held) {
    sock.write(frame(item.kind, item.chunk))
  }
}

const onClientFrame = (f, sock) => {
  if (!child || !child.pid) return
  if (f.kind === FRAME_STDIN) {
    if (child.stdin.write(f.payload) === false) {
      sock.pause()
      child.stdin.once('drain', () => {
        if (client === sock && !sock.destroyed) sock.resume()
      })
    }
  } else if (f.kind === FRAME_STDIN_END) {
    child.stdin.end()
  }
}

const createParser = (sock) => {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      if (pending.length < HEADER) return
      const length = pending.readUInt32LE(0)
      if (length > MAX_FRAME) {
        sock.destroy()
        return
      }
      if (pending.length < HEADER + length) return
      const f = { kind: pending.readUInt8(4), payload: pending.subarray(HEADER, HEADER + length) }
      pending = pending.subarray(HEADER + length)
      onClientFrame(f, sock)
    }
  }
}

const server = net.createServer((sock) => {
  if (client && !client.destroyed) {
    try { client.destroy() } catch {}
  }
  client = sock
  everAttached = true
  sock.setNoDelay(true)
  const parse = createParser(sock)
  sock.on('data', parse)
  sock.on('error', () => {})
  sock.on('drain', () => {
    if (clientPaused && client === sock) {
      clientPaused = false
      if (child && !readsPaused) {
        child.stdout.resume()
        child.stderr.resume()
      }
    }
  })
  sock.on('close', () => {
    if (client === sock) {
      client = null
      clientPaused = false
      lastClientGoneAt = Date.now()
    }
  })
  sock.write(jsonFrame(FRAME_HELLO, {
    pid: (child && child.pid) || null,
    supervisorPid: process.pid,
    spawnError
  }))
  flushBuffered(sock)
})

try { fs.rmSync(spec.socketPath, { force: true }) } catch {}
server.on('error', (error) => {
  spawnError = spawnError || { code: error.code || 'UNKNOWN', message: String(error) }
  reportExit(null, null, spawnError)
  finish(1)
})
server.listen(spec.socketPath)

if (child && child.pid) {
  child.stdout.on('data', (chunk) => emit(FRAME_STDOUT, chunk))
  child.stderr.on('data', (chunk) => emit(FRAME_STDERR, chunk))
  child.once('error', (error) => {
    spawnError = spawnError || { code: error.code || 'UNKNOWN', message: String(error && error.message) }
    providerExited = true
    settling = true
    void reapProviderGroup().then(() => {
      reportExit(null, null, spawnError)
      finish(0)
    })
  })
  child.once('exit', (code, signal) => {
    providerExited = true
    exitCode = code
    exitSignal = signal
    if (settling) return
    settling = true
    void reapProviderGroup()
      .then(() => {
        // Let the provider's last output reach the pipe before reporting its end.
        const drained = Promise.all([child.stdout, child.stderr].map(
          (s) => (s.readableEnded || s.destroyed ? null : new Promise((r) => { s.once('end', r); s.once('close', r) }))
        ))
        return Promise.race([drained, new Promise((r) => setTimeout(r, ${PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS}))])
      })
      .then(() => {
        reportExit(exitCode, exitSignal)
        finish(0)
      })
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
} else {
  reportExit(null, null, spawnError || { code: 'ENOENT', message: 'provider did not spawn' })
  finish(1)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => stopProviderGroup(signal))
}
process.on('SIGUSR2', () => {
  sigtermGraceCut = true
  if (!settling) stopProviderGroup('SIGKILL')
})

setInterval(() => {
  if (client || settling || finished) return
  const limit = everAttached ? spec.detachedTtlMs : spec.initialAttachMs
  if (Date.now() - lastClientGoneAt >= limit) stopProviderGroup(null)
}, 15_000).unref()
`
