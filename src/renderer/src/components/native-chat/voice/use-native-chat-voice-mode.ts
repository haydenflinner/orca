import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isPlainEscapeKeyEvent } from '@/components/terminal-pane/input/keyboard/agent-interrupt-key-event'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { canStartDictation, isDictationUnderway } from '../../dictation/dictation-session-machine'
import { dispatchDictationControl } from '../../dictation/dictation-control-events'
import { currentDictationInsertionTarget } from '../../dictation/use-dictation-queued-send'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'
import { DEFAULT_TTS_WORDS_PER_MINUTE } from '../../../../../shared/speech/speech-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { voiceMessageSettled, voiceMessageText } from './native-chat-voice-utterance'

export type NativeChatVoiceModeControl = {
  armed: boolean
  speaking: boolean
  /** A dictation session is running — in voice mode that is the user's turn to talk. */
  listening: boolean
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
 * Armed per pane (paneKey): completed assistant prose goes to the local `say` queue, then the
 * composer starts dictation for the reply — a hands-free loop. A `say` that ends `interrupted`
 * never restarts listening, so toggle-off, Esc, barge-in and manual sends all break the loop.
 */
export function useNativeChatVoiceMode({
  enabled,
  paneKey,
  messages,
  sessionWorking,
  disabled,
  textareaRef,
  root,
  send
}: {
  enabled: boolean
  paneKey: string
  messages: readonly NativeChatMessage[] | undefined
  sessionWorking: boolean
  disabled: boolean
  textareaRef: RefObject<NativeChatComposerInput | null>
  root: RefObject<HTMLDivElement | null> | undefined
  send: (() => void) | undefined
}): NativeChatVoiceModeControl {
  const armedFlag = useAppStore((store) => store.nativeChatVoiceModeArmed[paneKey] === true)
  const armed = enabled && armedFlag
  const setArmed = useAppStore((store) => store.setNativeChatVoiceModeArmed)
  const voice = useAppStore((store) => store.settings?.voice)
  const dictationPhase = useAppStore((store) => store.dictationState)
  const [speaking, setSpeaking] = useState(false)
  // Chars already handed to `say`, per message id; a settled row speaks only its growth.
  const spokenRef = useRef(new Map<string, number>())
  const pendingRef = useRef(0)
  const initializedRef = useRef(false)
  const lastUserIdRef = useRef<string | null>(null)
  const prevPhaseRef = useRef(dictationPhase)

  const ttsSupported =
    typeof window.api.speech.speak === 'function' && getShortcutPlatform() === 'darwin'
  const available = enabled && ttsSupported && voice?.enabled === true && !disabled
  const listening = armed && isDictationUnderway(dictationPhase)

  const stopSpeak = useLatestHandler(() => {
    void window.api.speech.stopSpeak?.()
  })
  const sendNow = useLatestHandler(() => send?.())

  // An utterance that played out whole restarts listening; any interruption ends the loop's turn.
  const autoListen = useLatestHandler(() => {
    const store = useAppStore.getState()
    if (
      !armed ||
      !store.nativeChatVoiceModeArmed[paneKey] ||
      !messages ||
      !canStartDictation(store.dictationState)
    ) {
      return
    }
    textareaRef.current?.focus()
    dispatchDictationControl('start')
  })

  const speak = useLatestHandler((text: string) => {
    pendingRef.current += 1
    setSpeaking(true)
    void (
      window.api.speech.speak?.(text, {
        rate: voice?.ttsRate ?? DEFAULT_TTS_WORDS_PER_MINUTE
      }) ?? Promise.resolve(undefined)
    )
      .then((result) => result?.outcome)
      .catch(() => undefined)
      .then((outcome) => {
        pendingRef.current = Math.max(0, pendingRef.current - 1)
        if (pendingRef.current === 0) {
          setSpeaking(false)
          if (outcome === 'finished') {
            autoListen()
          }
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

  // Loop edges: a user's dictation start barges `say`; the dictated turn ends by sending its words.
  useEffect(() => {
    const previous = prevPhaseRef.current
    prevPhaseRef.current = dictationPhase
    if (!armed) {
      return
    }
    if (isDictationUnderway(dictationPhase) && !isDictationUnderway(previous)) {
      stopSpeak()
    }
    if (dictationPhase === 'stopping' && previous !== 'stopping') {
      const target = currentDictationInsertionTarget()
      if (target?.kind === 'composer' && target.root === root?.current) {
        sendNow()
      }
    }
  }, [dictationPhase, armed, root, stopSpeak, sendNow])

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

  return { armed, speaking, listening, available, toggle }
}
