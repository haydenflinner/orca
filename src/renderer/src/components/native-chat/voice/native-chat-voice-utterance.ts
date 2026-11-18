import type {
  NativeChatMessage,
  NativeChatTextBlock
} from '../../../../../shared/native-chat/native-chat-types'

const MAX_UTTERANCE_CHARS = 4_000

/** Orca status rows ride in text blocks too; only plain agent prose is worth hearing. */
function isSpeakableTextBlock(
  block: NativeChatMessage['blocks'][number]
): block is NativeChatTextBlock {
  return (
    block.type === 'text' &&
    block.failure === undefined &&
    block.orcaStop === undefined &&
    block.forkedFrom === undefined &&
    block.providerFrame === undefined &&
    block.usageLimitTurnItemId === undefined &&
    block.contextClear === undefined
  )
}

/** `say` reads markup literally, so strip code, images and link targets; keep the words. */
export function sanitizeVoiceText(text: string): string {
  let out = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|[*_~])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length > MAX_UTTERANCE_CHARS) {
    out = `${out.slice(0, MAX_UTTERANCE_CHARS).trimEnd()}…`
  }
  return out
}

export function voiceMessageText(message: NativeChatMessage): string {
  if (message.role !== 'assistant' || message.queued === true || message.unsent === true) {
    return ''
  }
  return sanitizeVoiceText(
    message.blocks
      .filter(isSpeakableTextBlock)
      .map((block) => block.text)
      .join('\n')
  )
}

/**
 * Cheapest reliable turn boundary: the row reported completion, a newer row followed it,
 * or the session went idle. Streaming rows (state 'running', scrape tail while working) wait.
 */
export function voiceMessageSettled(
  message: NativeChatMessage,
  followed: boolean,
  sessionWorking: boolean
): boolean {
  return message.state === 'completed' || message.completedAt != null || followed || !sessionWorking
}
