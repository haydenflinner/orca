import type { ForwardedRef } from 'react'
import type { ClipboardEventLike } from '../../paste/native-chat-clipboard-payload'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { useNativeChatComposerAttachments } from '../../attachments/chips/use-native-chat-composer-attachments'
import type { useNativeChatFileDrops } from '../../attachments/intake/use-native-chat-file-drops'
import {
  useNativeChatComposerHandle,
  type UseNativeChatComposerHandleArgs
} from './use-native-chat-composer-handle'

type PasteHandleArgs = Pick<
  UseNativeChatComposerHandleArgs,
  | 'targetKey'
  | 'agent'
  | 'disabled'
  | 'textareaRef'
  | 'isComposing'
  | 'caret'
  | 'setDraft'
  | 'setCaret'
  | 'setActiveSuggestion'
  | 'setNotice'
> & {
  structuredTransport: NativeChatStructuredComposerTransport | undefined
  sendPty: (input: { text: string; imagePaths?: string[] }) => boolean
  attachmentScopeKey: string
  fileDrops: Pick<
    ReturnType<typeof useNativeChatFileDrops>,
    'resolveAttachmentOwner' | 'attachExternalPaths' | 'captureCopiedFiles' | 'captureExternalPaths'
  >
  attachments: Pick<
    ReturnType<typeof useNativeChatComposerAttachments>,
    | 'attachResolvedPaths'
    | 'beginPendingImageAttachment'
    | 'pendingChips'
    | 'revealPendingImageAttachment'
    | 'dropPendingImageAttachment'
    | 'scopeEditor'
  >
}

/** Paste handle for the composer pane; a PTY resend drops out on structured transports. */
export function useNativeChatComposerPasteHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: PasteHandleArgs
): (event: ClipboardEventLike) => void {
  const { structuredTransport, sendPty, fileDrops, attachments, ...rest } = args
  return useNativeChatComposerHandle(ref, {
    resend: (text, imagePaths) =>
      structuredTransport === undefined && sendPty({ text, imagePaths }),
    ...rest,
    resolveAttachmentOwner: fileDrops.resolveAttachmentOwner,
    attachResolvedPaths: attachments.attachResolvedPaths,
    attachCopiedFiles: fileDrops.attachExternalPaths,
    captureCopiedFiles: fileDrops.captureCopiedFiles,
    captureExternalPaths: fileDrops.captureExternalPaths,
    beginPendingImageAttachment: attachments.beginPendingImageAttachment,
    // Settles into the scope cache, which outlives a composer a prompt card unmounted.
    resolvePendingImageAttachment: attachments.pendingChips.resolve,
    revealPendingImageAttachment: attachments.revealPendingImageAttachment,
    dropPendingImageAttachment: attachments.dropPendingImageAttachment,
    pastedTextEditor: structuredTransport ? attachments.scopeEditor : null
  })
}
