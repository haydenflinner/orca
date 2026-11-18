import { Writable, type WritableOptions } from 'node:stream'

/** Writable facade over framed stdin; transport failures surface as stream errors. */
export class ParkStdin extends Writable {
  constructor(
    options: WritableOptions,
    private readonly sink: {
      send: (chunk: Buffer) => void
      end: () => void
    }
  ) {
    super(options)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    try {
      this.sink.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      done()
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _final(done: (error?: Error | null) => void) {
    try {
      this.sink.end()
      done()
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
