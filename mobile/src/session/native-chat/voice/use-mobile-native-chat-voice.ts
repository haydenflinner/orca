import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  voiceLastUserMessageId,
  voiceMessageSettled,
  voiceMessageText
} from '../../../../../src/shared/native-chat/native-chat-voice-utterance'
import {
  useMobileDictationHost,
  useMobileDictationHostLive
} from '../../../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../../../hooks/mobile-dictation-session-state'
import {
  mobileTtsAvailable,
  speakMobileTts,
  stopMobileTts
} from '../../../platform/speech/mobile-tts'
import {
  setMobileNativeChatVoiceArmed,
  useMobileNativeChatVoiceArmed
} from './mobile-native-chat-voice-armed'

export type MobileNativeChatVoiceControl = {
  armed: boolean
  speaking: boolean
  /** A dictation session is running — in voice mode that is the user's turn to talk. */
  listening: boolean
  /** False disables the toggle: no on-device TTS or no dictation on this surface. */
  available: boolean
  toggle: () => void
}

function dictationUnderway(dictation: UseMobileDictationResult): boolean {
  return (
    dictation.isStarting ||
    dictation.isRecording ||
    dictation.isProcessing ||
    dictation.failure !== null
  )
}

/**
 * Armed per composer scope: settled assistant prose goes to the on-device TTS queue.
 * Toggle-off, a new user turn, a dictation start (barge-in), backgrounding and leaving
 * the screen all stop the speech; only settled growth is spoken.
 */
export function useMobileNativeChatVoice({
  scopeKey,
  messages,
  sessionWorking,
  micAvailable,
  disabled = false
}: {
  scopeKey: string | null
  messages: readonly NativeChatMessage[]
  sessionWorking: boolean
  /** The composer mic exists: dictation can take this chat's reply. */
  micAvailable: boolean
  disabled?: boolean
}): MobileNativeChatVoiceControl {
  const host = useMobileDictationHost()
  const dictation = useMobileDictationHostLive(host)
  const armedFlag = useMobileNativeChatVoiceArmed(scopeKey)
  const enabled = scopeKey !== null && micAvailable
  const armed = enabled && armedFlag
  const underway = dictationUnderway(dictation)
  const listening = armed && underway
  const available = enabled && mobileTtsAvailable() && !disabled
  const [speaking, setSpeaking] = useState(false)
  // Chars already handed to the speaker, per message id; a settled row speaks only its growth.
  const spokenRef = useRef(new Map<string, number>())
  const pendingRef = useRef(0)
  const initializedRef = useRef(false)
  const lastUserIdRef = useRef<string | null>(null)
  const underwayRef = useRef(underway)

  const stopSpeak = useCallback(() => stopMobileTts(), [])

  const speak = useCallback((text: string) => {
    pendingRef.current += 1
    setSpeaking(true)
    void speakMobileTts(text).then(() => {
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      if (pendingRef.current === 0) {
        setSpeaking(false)
      }
    })
  }, [])

  const review = useEffectEvent((list: readonly NativeChatMessage[], working: boolean) => {
    const userId = voiceLastUserMessageId(list)
    if (userId !== lastUserIdRef.current) {
      lastUserIdRef.current = userId
      // Any new user turn (this client's or another's) supersedes whatever is playing.
      if (initializedRef.current) {
        stopSpeak()
      }
    }
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index]
      const text = voiceMessageText(message)
      if (!text) {
        continue
      }
      const spoken = spokenRef.current.get(message.id) ?? 0
      if (!voiceMessageSettled(message, index < list.length - 1, working)) {
        continue
      }
      const unspoken = text.slice(spoken)
      spokenRef.current.set(message.id, text.length)
      if (unspoken && initializedRef.current) {
        speak(unspoken)
      }
    }
  })

  useEffect(() => {
    if (!armed) {
      if (initializedRef.current) {
        stopSpeak()
      }
      initializedRef.current = false
      spokenRef.current.clear()
      lastUserIdRef.current = null
      return
    }
    if (!initializedRef.current) {
      // Baseline: rows settled before arming are history; an in-flight one speaks whole at completion.
      initializedRef.current = true
      lastUserIdRef.current = voiceLastUserMessageId(messages)
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        const text = voiceMessageText(message)
        if (text && voiceMessageSettled(message, index < messages.length - 1, sessionWorking)) {
          spokenRef.current.set(message.id, text.length)
        }
      }
      return
    }
    review(messages, sessionWorking)
  }, [armed, messages, sessionWorking, stopSpeak])

  // A dictation that starts anywhere on the phone barges whatever reply is playing.
  useEffect(() => {
    const wasUnderway = underwayRef.current
    underwayRef.current = underway
    if (armed && underway && !wasUnderway) {
      stopSpeak()
    }
  }, [armed, underway, stopSpeak])

  // The phone going quiet (background/lock) must not leave a voice talking unseen.
  useEffect(() => {
    if (!armed) {
      return
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        stopSpeak()
      }
    })
    return () => subscription.remove()
  }, [armed, stopSpeak])

  // Leaving the screen or switching chats forgets the arm and silences the queue.
  useEffect(() => {
    const scope = scopeKey
    return () => {
      if (scope) {
        setMobileNativeChatVoiceArmed(scope, false)
      }
      stopSpeak()
    }
  }, [scopeKey, stopSpeak])

  const toggle = useCallback(() => {
    if (!available || scopeKey === null) {
      return
    }
    if (armed) {
      stopSpeak()
      setMobileNativeChatVoiceArmed(scopeKey, false)
    } else {
      setMobileNativeChatVoiceArmed(scopeKey, true)
    }
  }, [available, armed, scopeKey, stopSpeak])

  return { armed, speaking, listening, available, toggle }
}
