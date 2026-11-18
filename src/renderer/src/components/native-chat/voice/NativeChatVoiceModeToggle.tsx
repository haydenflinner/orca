import { AudioLines, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatVoiceModeControl } from './use-native-chat-voice-mode'

/** The voice-chat toggle and its speaking indicator, as a composer trailing control. */
export function NativeChatVoiceModeToggle({ control }: { control: NativeChatVoiceModeControl }) {
  const t = useTranslate()
  const label = control.armed
    ? t('components.native-chat.composer.stopVoiceMode', 'Stop voice chat')
    : t('components.native-chat.composer.startVoiceMode', 'Voice chat: speak replies aloud')
  const status = control.armed
    ? control.speaking
      ? t('components.native-chat.composer.voiceModeSpeaking', 'Speaking…')
      : control.listening
        ? t('components.native-chat.composer.voiceModeListening', 'Listening…')
        : null
    : null
  return (
    <span className="flex items-center gap-1">
      {status ? (
        <span data-composer-label className="text-xs text-muted-foreground">
          {status}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={control.armed ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={label}
            aria-pressed={control.armed}
            disabled={!control.available}
            onClick={control.toggle}
            className="pointer-coarse:size-11"
          >
            {control.armed ? <AudioLines className="size-4" /> : <Volume2 className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
