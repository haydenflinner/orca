/** Framed stdio relay between a detached park supervisor and its attached runtime. */

export const PARK_FRAME_STDIN = 0
export const PARK_FRAME_STDIN_END = 1
export const PARK_FRAME_STDOUT = 2
export const PARK_FRAME_STDERR = 3
export const PARK_FRAME_HELLO = 4
export const PARK_FRAME_EXIT = 5

export const PROVIDER_PARK_SPEC_ENV = 'ORCA_PROVIDER_PARK_SPEC'

export const PARK_HEADER_BYTES = 5
/** A hostile or corrupt peer cannot make the supervisor or client buffer unboundedly. */
export const PARK_MAX_FRAME_BYTES = 32 * 1024 * 1024

export type ProviderParkHello = {
  /** Provider CLI pid, which is also its detached process-group id. */
  pid: number
  supervisorPid: number
}

export type ProviderParkExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Spec the parent bakes into the detached supervisor's environment. */
export type ProviderParkSpec = {
  socketPath: string
  /** Written when the provider exits while no client is attached. */
  exitPath: string
  command: string
  args: string[]
  cwd: string
  nodeEnv: Record<string, string>
  stdinEndGraceMs: number
  sigtermGraceMs: number
  /** No client has ever attached for this long: the spawn was abandoned. */
  initialAttachMs: number
  /** A detached client never came back; the park stops on its own. */
  detachedTtlMs: number
  /** Output retained for the next attacher before provider reads are paused. */
  bufferCapBytes: number
}

export function encodeParkFrame(kind: number, payload?: Buffer | string): Buffer {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload)
  const header = Buffer.alloc(PARK_HEADER_BYTES)
  header.writeUInt32LE(body.length, 0)
  header.writeUInt8(kind, 4)
  return Buffer.concat([header, body])
}

export function encodeParkJsonFrame(kind: number, value: unknown): Buffer {
  return encodeParkFrame(kind, Buffer.from(JSON.stringify(value), 'utf8'))
}

export type ParkFrame = { kind: number; payload: Buffer }

/** Incremental decoder; onFrame receives each whole frame. Returns a parse error once. */
export function createParkFrameParser(onFrame: (frame: ParkFrame) => void): {
  push: (chunk: Buffer) => Error | null
} {
  let pending: Buffer = Buffer.alloc(0)
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      for (;;) {
        if (pending.length < PARK_HEADER_BYTES) {
          return null
        }
        const length = pending.readUInt32LE(0)
        if (length > PARK_MAX_FRAME_BYTES) {
          pending = Buffer.alloc(0)
          return new Error(`provider park frame of ${length} bytes exceeds the limit`)
        }
        if (pending.length < PARK_HEADER_BYTES + length) {
          return null
        }
        const kind = pending.readUInt8(4)
        const payload = pending.subarray(PARK_HEADER_BYTES, PARK_HEADER_BYTES + length)
        pending = pending.subarray(PARK_HEADER_BYTES + length)
        onFrame({ kind, payload })
      }
    }
  }
}
