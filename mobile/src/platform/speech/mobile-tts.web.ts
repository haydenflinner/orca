import type { SpeechSpeakOutcome } from '../../../../src/shared/speech/speech-types'
import type { MobileTtsSpeakOptions } from './mobile-tts-contract'

const MAX_SPEAK_TEXT_LENGTH = 20_000

type MobileTtsUtterance = {
  text: string
  options: MobileTtsSpeakOptions
  interrupted: boolean
  done: boolean
  resolve: (outcome: SpeechSpeakOutcome) => void
}

// Own the queue instead of speechSynthesis's so every speak() resolves its own outcome and
// stop() can settle the waiters behind the current utterance.
const queue: MobileTtsUtterance[] = []
let current: MobileTtsUtterance | null = null

function synthesis(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null
}

export function mobileTtsAvailable(): boolean {
  return synthesis() !== null
}

export function speakMobileTts(
  text: string,
  options: MobileTtsSpeakOptions = {}
): Promise<SpeechSpeakOutcome> {
  if (synthesis() === null) {
    return Promise.resolve('unavailable')
  }
  const clipped = text.slice(0, MAX_SPEAK_TEXT_LENGTH)
  if (!clipped.trim()) {
    return Promise.resolve('finished')
  }
  return new Promise((resolve) => {
    queue.push({ text: clipped, options, interrupted: false, done: false, resolve })
    pump()
  })
}

export function stopMobileTts(): void {
  for (const utterance of queue.splice(0)) {
    utterance.done = true
    utterance.resolve('interrupted')
  }
  const active = current
  if (active) {
    active.interrupted = true
    synthesis()?.cancel()
    // Browsers do not reliably fire end/error on a cancelled utterance; settle it ourselves.
    finish(active, 'interrupted')
  }
}

function finish(utterance: MobileTtsUtterance, outcome: SpeechSpeakOutcome): void {
  if (utterance.done) {
    return
  }
  utterance.done = true
  if (current === utterance) {
    current = null
  }
  utterance.resolve(outcome)
  pump()
}

function pump(): void {
  const synth = synthesis()
  if (!synth || current || queue.length === 0) {
    return
  }
  const utterance = queue.shift()!
  current = utterance
  const spoken = new SpeechSynthesisUtterance(utterance.text)
  const { rate, voice } = utterance.options
  if (typeof rate === 'number' && Number.isFinite(rate)) {
    spoken.rate = Math.min(10, Math.max(0.1, rate))
  }
  if (voice) {
    spoken.voice = synth.getVoices().find((candidate) => candidate.name === voice) ?? null
  }
  spoken.onend = () => finish(utterance, utterance.interrupted ? 'interrupted' : 'finished')
  spoken.onerror = () => finish(utterance, 'interrupted')
  synth.speak(spoken)
}
