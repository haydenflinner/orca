import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useState, type RefObject } from 'react'
import { useAppStore } from '../../../../store/index'
import { dispatchDictationControl } from '../../../dictation/dictation-control-events'
import {
  useNativeChatVoiceMode,
  type NativeChatVoiceModeControl
} from '../../voice/use-native-chat-voice-mode'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

export type NativeChatDictationVoiceArgs = {
  /** Off in edit and launch composes, which have no live transcript to speak. */
  enabled: boolean
  paneKey: string
  messages: readonly NativeChatMessage[] | undefined
  sessionWorking: boolean
  /** The composer's root element, for checking the dictation session targets this composer. */
  root: RefObject<HTMLDivElement | null>
  /** Send-as-Enter; may close over a binding declared after this call site. */
  send: () => void
}

/** The dictation and voice-mode props `NativeChatComposerField` consumes, under their prop names. */
export type NativeChatComposerVoiceFieldProps = {
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  voiceMode: NativeChatVoiceModeControl | undefined
}

export function useNativeChatDictation(
  textareaRef: RefObject<NativeChatComposerInput | null>,
  disabled: boolean,
  voice?: NativeChatDictationVoiceArgs
): {
  isDictating: boolean
  fieldProps: NativeChatComposerVoiceFieldProps
} {
  const [dictationPressed, setDictationPressed] = useState(false)
  const dictationState = useAppStore((store) => store.dictationState)
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'
  const dictationDisabled = !isDictating && (disabled || voiceSettings?.enabled !== true)
  const voiceMode = useNativeChatVoiceMode({
    enabled: voice?.enabled === true,
    paneKey: voice?.paneKey ?? '',
    messages: voice?.messages,
    sessionWorking: voice?.sessionWorking === true,
    disabled,
    textareaRef,
    root: voice?.root,
    send: voice?.send
  })
  const focusForDictation = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  const toggleDictation = useCallback(() => {
    if (isDictating) {
      dispatchDictationControl('stop')
    } else if (!dictationDisabled) {
      focusForDictation()
      dispatchDictationControl('toggle')
    }
  }, [dictationDisabled, focusForDictation, isDictating])
  const startHoldDictation = useCallback(() => {
    if (disabled || dictationDisabled || isDictating) {
      return
    }
    setDictationPressed(true)
    focusForDictation()
    dispatchDictationControl('start')
  }, [disabled, dictationDisabled, focusForDictation, isDictating])
  const stopHoldDictation = useCallback(() => {
    setDictationPressed(false)
    dispatchDictationControl('stop')
  }, [])
  return {
    isDictating,
    fieldProps: {
      dictationDisabled,
      isDictating,
      isDictationHoldMode: voiceSettings?.dictationMode === 'hold',
      onDictationToggle: toggleDictation,
      onDictationHoldStart: startHoldDictation,
      onDictationHoldEnd: stopHoldDictation,
      voiceMode: voice?.enabled === true ? voiceMode : undefined
    }
  }
}

export function nativeChatDictationFieldProps(
  dictation: ReturnType<typeof useNativeChatDictation>
) {
  return dictation.fieldProps
}
