import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { PassThrough, type Writable } from 'node:stream'
import { notifyProviderChild, type ProviderChild } from '../provider-child'
import {
  PARK_FRAME_EXIT,
  PARK_FRAME_HELLO,
  PARK_FRAME_STDERR,
  PARK_FRAME_STDIN,
  PARK_FRAME_STDIN_END,
  PARK_FRAME_STDOUT,
  createParkFrameParser,
  encodeParkFrame,
  type ProviderParkExit,
  type ProviderParkHello
} from './provider-park-protocol'
import { ParkStdin } from './parked-provider-stdin'
import { providerParkDetachArmed } from './provider-park-detach-policy'

export type ParkedProviderExitState = 'live' | 'exited' | 'detached' | 'lost'

/** A provider child whose group is owned by a detached park supervisor reachable over a socket. */
export class ParkedProviderChild extends EventEmitter implements ProviderChild {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly ready: Promise<void>
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  groupVerdict: 'exited' | 'unverifiable' = 'unverifiable'
  leaderExited = false
  private socket: Socket | null = null
  private providerPid: number | undefined
  private supervisorPid: number | undefined
  private killedSent = false
  private settleState: ParkedProviderExitState = 'live'
  private readonly preConnectQueue: Buffer[] = []
  private connectedOnce = false

  constructor(
    connectTo: () => Promise<Socket>,
    private readonly lifecycle: {
      supervisorPid?: number
      onSettled?: (state: ParkedProviderExitState) => void
    } = {}
  ) {
    super()
    this.supervisorPid = lifecycle.supervisorPid
    this.stdin = new ParkStdin(
      { autoDestroy: false },
      {
        send: (chunk) => this.sendInput(chunk),
        end: () => this.endInput()
      }
    )
    this.stdin.on('error', () => {})
    this.stdout.on('error', () => {})
    this.stderr.on('error', () => {})
    let readyDone!: () => void
    let readyFail!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => {
      readyDone = resolve
      readyFail = reject
    })
    // A rejected ready must not surface as an unhandled rejection; callers settle via spawned.
    void this.ready.catch(() => {})
    void connectTo().then(
      (socket) => this.attach(socket, readyDone, readyFail),
      (error) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.fail(failure, readyFail)
      }
    )
  }

  get pid(): number | undefined {
    return this.providerPid ?? this.supervisorPid
  }
  get writerPid(): number | undefined {
    return this.providerPid
  }
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }
  get killed(): boolean {
    return this.killedSent
  }
  get detached(): boolean {
    return this.settleState === 'detached'
  }

  private attach(socket: Socket, readyDone: () => void, readyFail: (error: Error) => void): void {
    if (this.settleState !== 'live') {
      socket.destroy()
      return
    }
    this.socket = socket
    this.connectedOnce = true
    socket.setNoDelay(true)
    let helloSeen = false
    const parser = createParkFrameParser((frame) => {
      if (frame.kind === PARK_FRAME_HELLO) {
        helloSeen = true
        const hello = parseJson<
          ProviderParkHello & { spawnError?: { code?: string; message?: string } }
        >(frame.payload)
        this.providerPid = typeof hello?.pid === 'number' ? hello.pid : undefined
        this.supervisorPid =
          typeof hello?.supervisorPid === 'number' ? hello.supervisorPid : this.supervisorPid
        if (hello?.spawnError) {
          const failure = Object.assign(
            new Error(hello.spawnError.message ?? 'parked provider did not start'),
            { code: hello.spawnError.code ?? 'UNKNOWN' }
          )
          readyFail(failure)
          notifyProviderChild(this, 'error', failure)
          return
        }
        notifyProviderChild(this, 'spawn')
        readyDone()
        this.flushInputQueue()
        return
      }
      if (frame.kind === PARK_FRAME_STDOUT) {
        this.stdout.write(frame.payload)
        return
      }
      if (frame.kind === PARK_FRAME_STDERR) {
        this.stderr.write(frame.payload)
        return
      }
      if (frame.kind === PARK_FRAME_EXIT) {
        const exit = parseJson<ProviderParkExit>(frame.payload)
        this.finish('exited', exit?.code ?? null, exit?.signal ?? null)
      }
    })
    socket.on('data', (chunk) => {
      const failure = parser.push(chunk)
      if (failure) {
        socket.destroy()
        this.fail(failure, helloSeen ? undefined : readyFail)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
      }
      if (this.settleState === 'live') {
        this.finish('lost', null, null)
      }
    })
  }

  private fail(error: Error, readyFail?: (error: Error) => void): void {
    readyFail?.(error)
    if (this.settleState === 'live') {
      notifyProviderChild(this, 'error', error)
      this.finish('lost', null, null)
    }
  }

  private finish(
    state: ParkedProviderExitState,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.settleState !== 'live') {
      return
    }
    this.settleState = state
    this.exitCode = code
    this.signalCode = signal
    this.leaderExited = state !== 'detached'
    this.groupVerdict = state === 'exited' ? 'exited' : 'unverifiable'
    this.socket?.destroy()
    this.socket = null
    this.stdout.end()
    this.stderr.end()
    this.stdin.destroy()
    this.lifecycle.onSettled?.(state)
    if (state === 'exited') {
      notifyProviderChild(this, 'exit', code, signal)
      notifyProviderChild(this, 'close', code, signal)
      return
    }
    if (state === 'detached') {
      // The provider outlives this handle; close paths still need their exit observation.
      notifyProviderChild(this, 'exit', null, null)
      notifyProviderChild(this, 'close', null, null)
      return
    }
    // Transport lost before a proven provider exit: report the outcome as unknown.
    notifyProviderChild(this, 'exit', null, null)
    notifyProviderChild(this, 'close', null, null)
  }

  private sendInput(chunk: Buffer): void {
    if (this.settleState !== 'live') {
      throw new Error('parked provider stdin is closed')
    }
    const data = encodeParkFrame(PARK_FRAME_STDIN, chunk)
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data)
    } else if (!this.connectedOnce) {
      this.preConnectQueue.push(data)
    } else {
      throw new Error('parked provider transport is disconnected')
    }
  }

  private endInput(): void {
    if (this.settleState !== 'live') {
      return
    }
    if (providerParkDetachArmed()) {
      // Destructing our own stream inside _final re-enters the Writable; defer the detach.
      queueMicrotask(() => this.parkDetach())
      return
    }
    const data = encodeParkFrame(PARK_FRAME_STDIN_END)
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data)
    }
  }

  private flushInputQueue(): void {
    const queued = this.preConnectQueue.splice(0)
    if (queued.length === 0 || !this.socket || this.socket.destroyed) {
      return
    }
    this.socket.write(Buffer.concat(queued))
  }

  /** SIGSTOP/SIGKILL address the provider group; stop signals go to the supervisor's ladder. */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killedSent = true
    if (providerParkDetachArmed() && this.settleState === 'live') {
      this.parkDetach()
      return true
    }
    if (this.settleState !== 'live') {
      return false
    }
    if (signal === 'SIGKILL' || signal === 9) {
      return this.killGroupNow('SIGKILL')
    }
    if (signal === 'SIGSTOP' || signal === 'SIGCONT') {
      return this.signalProvider(signal)
    }
    const supervisor = this.supervisorPid
    if (supervisor === undefined) {
      return this.signalProvider(signal)
    }
    try {
      process.kill(supervisor, signal)
      return true
    } catch (error) {
      if (errorCode(error) === 'ESRCH') {
        return this.signalProvider(signal)
      }
      return false
    }
  }

  private signalProvider(signal: NodeJS.Signals | number): boolean {
    if (this.providerPid !== undefined) {
      try {
        process.kill(-this.providerPid, signal)
        return true
      } catch {}
    }
    if (this.pid !== undefined) {
      try {
        process.kill(this.pid, signal)
        return true
      } catch {}
    }
    return false
  }

  private killGroupNow(signal: NodeJS.Signals): boolean {
    let delivered = false
    if (this.providerPid !== undefined) {
      try {
        process.kill(-this.providerPid, signal)
        delivered = true
      } catch {}
    }
    if (this.supervisorPid !== undefined) {
      try {
        process.kill(this.supervisorPid, signal)
        delivered = true
      } catch {}
    }
    return delivered
  }

  /** Leave the provider running under its detached supervisor for a post-update adopter. */
  parkDetach(): void {
    this.finish('detached', null, null)
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function parseJson<T>(payload: Buffer): T | null {
  try {
    return JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
}
