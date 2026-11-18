import { Pressable, Text, View } from 'react-native'
import { AudioLines, Volume2 } from 'lucide-react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import { MobileNativeChatControlSwap } from '../input/mobile-native-chat-control-swap'
import type { MobileNativeChatVoiceControl } from './use-mobile-native-chat-voice'

/** The voice-chat toggle and its speaking/listening note, as a composer trailing control. */
export function MobileNativeChatVoiceToggle({
  control
}: {
  control: MobileNativeChatVoiceControl
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Focus taken from the field closes the keyboard; keep taps on this control from doing so.
  const keepsField = useKeyboardPersistingTaps('always')
  const status = control.armed
    ? control.speaking
      ? t('chat.composer.voiceModeSpeaking', 'Speaking…')
      : control.listening
        ? t('chat.composer.voiceModeListening', 'Listening…')
        : null
    : null
  return (
    <View style={styles.row}>
      {status ? (
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      ) : null}
      <Pressable
        ref={keepsField}
        accessibilityRole="button"
        accessibilityState={{ selected: control.armed }}
        accessibilityLabel={
          control.armed
            ? t('chat.composer.stopVoiceMode', 'Stop voice chat')
            : t('chat.composer.startVoiceMode', 'Voice chat: speak replies aloud')
        }
        style={({ pressed }) => [
          inputStyles.ghostButton,
          pressed && inputStyles.pressed,
          !control.available && inputStyles.disabled
        ]}
        onPress={control.toggle}
        disabled={!control.available}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        {/* The icon swaps in place so the press target never moves mid-tap. */}
        <MobileNativeChatControlSwap swapKey={control.armed ? 'armed' : 'idle'} icon>
          {control.armed ? (
            <AudioLines pointerEvents="none" size={18} color={colors.accentBlue} strokeWidth={2} />
          ) : (
            <Volume2 pointerEvents="none" size={19} color={colors.textSecondary} strokeWidth={2} />
          )}
        </MobileNativeChatControlSwap>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 0,
    flexShrink: 1
  },
  status: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize + 1
  }
}))
