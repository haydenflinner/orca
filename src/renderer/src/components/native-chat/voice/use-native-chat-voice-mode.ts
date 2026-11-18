import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isPlainEscapeKeyEvent } from '@/components/terminal-pane/input/keyboard/agent-interrupt-key-event'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { DEFAULT_TTS_WORDS_PER_MINUTE } from '../../../../../shared/speech/speech-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { voiceMessageSettled, voiceMessageText } from './native-chat-voice-utterance'

export type NativeChatVoiceModeControl = {
  armed: boolean
  speaking: boolean
  /** False disables the toggle: no `say` on this platform or voice dictation is off. */
  available: boolean
  toggle: () => void
}

function lastUserMessageId(messages: readonly NativeChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && message.queued !== true && message.unsent !== true) {
      return message.id
    }
  }
  return null
}

/**
 * Armed per pane (paneKey): completed assistant prose goes to the local `say` queue.
 * Stops on toggle-off, unmount, Esc, or any new user turn reaching the transcript.
 */
export function useNativeChatVoiceMode({
  enabled,
  paneKey,
  messages,
  sessionWorking,
  disabled
}: {
  enabled: boolean
  paneKey: string
  messages: readonly NativeChatMessage[] | undefined
  sessionWorking: boolean
  disabled: boolean
}): NativeChatVoiceModeControl {
  const armedFlag = useAppStore((store) => store.nativeChatVoiceModeArmed[paneKey] === true)
  const armed = enabled && armedFlag
  const setArmed = useAppStore((store) => store.setNativeChatVoiceModeArmed)
  const voice = useAppStore((store) => store.settings?.voice)
  const [speaking, setSpeaking] = useState(false)
  // Chars already handed to `say`, per message id; a settled row speaks only its growth.
  const spokenRef = useRef(new Map<string, number>())
  const pendingRef = useRef(0)
  const initializedRef = useRef(false)
  const lastUserIdRef = useRef<string | null>(null)

  const ttsSupported =
    typeof window.api.speech.speak === 'function' && getShortcutPlatform() === 'darwin'
  const available = enabled && ttsSupported && voice?.enabled === true && !disabled

  const stopSpeak = useLatestHandler(() => {
    void window.api.speech.stopSpeak?.()
  })

  const speak = useLatestHandler((text: string) => {
    pendingRef.current += 1
    setSpeaking(true)
    void window.api.speech
      .speak?.(text, { rate: voice?.ttsRate ?? DEFAULT_TTS_WORDS_PER_MINUTE })
      .catch(() => undefined)
      .finally(() => {
        pendingRef.current = Math.max(0, pendingRef.current - 1)
        if (pendingRef.current === 0) {
          setSpeaking(false)
        }
      })
  })

  const review = useEffectEvent((list: readonly NativeChatMessage[], working: boolean) => {
    const userId = lastUserMessageId(list)
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
    if (!initializedRef.current && messages) {
      // Baseline: rows settled before arming are history; an in-flight one speaks whole at completion.
      initializedRef.current = true
      lastUserIdRef.current = lastUserMessageId(messages)
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        const text = voiceMessageText(message)
        if (text && voiceMessageSettled(message, index < messages.length - 1, sessionWorking)) {
          spokenRef.current.set(message.id, text.length)
        }
      }
      return
    }
    if (messages) {
      review(messages, sessionWorking)
    }
  }, [armed, messages, sessionWorking, stopSpeak])

  useEffect(() => {
    if (!armed) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isPlainEscapeKeyEvent(event)) {
        stopSpeak()
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [armed, stopSpeak])

  // A pane that unmounts or turns the mode off silences the queue and forgets the arm.
  useEffect(() => {
    return () => {
      if (useAppStore.getState().nativeChatVoiceModeArmed[paneKey]) {
        setArmed(paneKey, false)
      }
      stopSpeak()
    }
  }, [paneKey, setArmed, stopSpeak])

  const toggle = useLatestHandler(() => {
    if (!available) {
      return
    }
    if (armed) {
      stopSpeak()
      setArmed(paneKey, false)
    } else {
      setArmed(paneKey, true)
    }
  })

  return { armed, speaking, available, toggle }
}
