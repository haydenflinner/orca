import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import type { MobileNativeChatComposerProps } from './mobile-native-chat-composer-props'
import { useMobileNativeChatDraft } from './drafts/mobile-native-chat-draft-store'
import { useMobileNativeChatVoice } from '../voice/use-mobile-native-chat-voice'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

const NO_MESSAGES: readonly NativeChatMessage[] = []

export function MobileNativeChatDraftComposer({
  draftKey,
  voiceMessages,
  voiceSessionWorking = false,
  ...props
}: Omit<MobileNativeChatComposerProps, 'value'> & {
  draftKey: string | null
  /** The chat's transcript: voice mode speaks its settled replies; absent hides the toggle. */
  voiceMessages?: readonly NativeChatMessage[]
  voiceSessionWorking?: boolean
}): React.JSX.Element {
  const voice = useMobileNativeChatVoice({
    scopeKey: props.draftScopeKey ?? null,
    messages: voiceMessages ?? NO_MESSAGES,
    sessionWorking: voiceSessionWorking,
    micAvailable: props.onMicPress !== undefined,
    disabled: props.disabled === true || props.offline === true,
    startDictation: props.onMicPress,
    send: props.onSend
  })
  return (
    <MobileNativeChatComposer
      {...props}
      value={useMobileNativeChatDraft(draftKey)}
      voice={voiceMessages ? voice : null}
    />
  )
}
