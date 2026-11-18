import type { SpeechSpeakOutcome } from '../../../../src/shared/speech/speech-types'

export type MobileTtsSpeakOptions = {
  /** Platform rate scale: expo-speech ~0.5–2.0, web speechSynthesis 0.1–10. */
  rate?: number
  /** A voice identifier (web: voice name); absent keeps the system default. */
  voice?: string
}

export type MobileTtsSpeak = (
  text: string,
  options?: MobileTtsSpeakOptions
) => Promise<SpeechSpeakOutcome>
