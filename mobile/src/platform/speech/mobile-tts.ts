import * as Speech from 'expo-speech'
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

// expo-speech lets the OS queue but gives no per-utterance cancel, so serialize here: one
// utterance at a time, and stop() settles the current one plus everything still waiting.
const queue: MobileTtsUtterance[] = []
let current: MobileTtsUtterance | null = null

// expo-speech is bundled in the dev-client build, so native always has a voice.
export function mobileTtsAvailable(): boolean {
  return true
}

export function speakMobileTts(
  text: string,
  options: MobileTtsSpeakOptions = {}
): Promise<SpeechSpeakOutcome> {
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
    void Speech.stop()
    // Whether the platform later reports stopped/done/error for it, the loop sees interrupted now.
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
  if (current || queue.length === 0) {
    return
  }
  const utterance = queue.shift()!
  current = utterance
  try {
    Speech.speak(utterance.text, {
      ...utterance.options,
      onDone: () => finish(utterance, utterance.interrupted ? 'interrupted' : 'finished'),
      onStopped: () => finish(utterance, 'interrupted'),
      onError: () => finish(utterance, 'interrupted')
    })
  } catch {
    finish(utterance, 'interrupted')
  }
}
