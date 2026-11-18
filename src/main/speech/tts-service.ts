import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { SpeechSpeakOutcome } from '../../shared/speech/speech-types'

const MAX_SPEAK_TEXT_LENGTH = 20_000
const MIN_TTS_RATE = 60
const MAX_TTS_RATE = 500

type SayUtterance = {
  text: string
  rate?: number
  resolve: (outcome: SpeechSpeakOutcome) => void
}

type SayChild = ChildProcessByStdio<Writable, null, null>

export type SayTtsServiceOptions = {
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  logger?: Pick<Console, 'warn'>
}

/** Serial `say` playback: one child at a time, its text written to stdin so argv length and quoting never apply. */
export class SayTtsService {
  private readonly platform: NodeJS.Platform
  private readonly spawn: typeof nodeSpawn
  private readonly logger: Pick<Console, 'warn'>
  private readonly queue: SayUtterance[] = []
  private current: { child: SayChild; utterance: SayUtterance; interrupted: boolean } | null = null

  constructor(options: SayTtsServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? nodeSpawn
    this.logger = options.logger ?? console
  }

  get available(): boolean {
    return this.platform === 'darwin'
  }

  speak(text: string, options: { rate?: number } = {}): Promise<SpeechSpeakOutcome> {
    if (!this.available) {
      return Promise.resolve('unavailable')
    }
    const clipped = text.slice(0, MAX_SPEAK_TEXT_LENGTH)
    if (!clipped.trim()) {
      return Promise.resolve('finished')
    }
    return new Promise((resolve) => {
      this.queue.push({ text: clipped, rate: options.rate, resolve })
      this.pump()
    })
  }

  stopSpeaking(): void {
    for (const utterance of this.queue.splice(0)) {
      utterance.resolve('interrupted')
    }
    if (this.current) {
      this.current.interrupted = true
      try {
        this.current.child.kill()
      } catch (error) {
        this.logger.warn('[tts] failed to kill say', error)
      }
    }
  }

  dispose(): void {
    this.stopSpeaking()
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) {
      return
    }
    const utterance = this.queue.shift()!
    const rate =
      typeof utterance.rate === 'number' && Number.isFinite(utterance.rate)
        ? Math.min(MAX_TTS_RATE, Math.max(MIN_TTS_RATE, Math.round(utterance.rate)))
        : null
    const finish = (outcome: SpeechSpeakOutcome): void => {
      if (this.current?.utterance === utterance) {
        this.current = null
      }
      utterance.resolve(outcome)
      this.pump()
    }
    let child: SayChild
    try {
      child = this.spawn('say', rate === null ? [] : ['-r', String(rate)], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      })
    } catch (error) {
      this.logger.warn('[tts] failed to spawn say', error)
      finish('interrupted')
      return
    }
    const current = { child, utterance, interrupted: false }
    this.current = current
    child.once('error', (error: Error) => {
      this.logger.warn('[tts] say failed', error)
      current.interrupted = true
      finish('interrupted')
    })
    child.once('close', () => {
      finish(current.interrupted ? 'interrupted' : 'finished')
    })
    // An instantly exiting child can EPIPE the write; its close still resolves the utterance.
    child.stdin.on('error', () => {})
    try {
      child.stdin.write(utterance.text)
      child.stdin.end()
    } catch {
      current.interrupted = true
      try {
        child.kill()
      } catch {
        // Already gone; close still settles the utterance.
      }
      finish('interrupted')
    }
  }
}

let service: SayTtsService | null = null

export function getSayTtsService(): SayTtsService {
  service ??= new SayTtsService()
  return service
}
