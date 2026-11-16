import type { Virtualizer } from '@tanstack/react-virtual'
import React, { useEffect, useRef } from 'react'
import {
  findActivityThreadItemIndex,
  type ActivityVirtualItemDescriptor
} from './activity-thread-virtual-items'

/**
 * Arrow keys on a focused thread row move focus to the adjacent visible row in
 * virtual-item order; focusing a row opens it, so movement selects as it moves.
 */
function handleActivityThreadArrowKey(
  event: KeyboardEvent,
  virtualItems: readonly ActivityVirtualItemDescriptor[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollContainer: HTMLElement
): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return
  }
  const focusedKey = (event.target as HTMLElement)
    .closest?.('[data-pane-key]')
    ?.getAttribute('data-pane-key')
  if (!focusedKey) {
    return
  }
  const threads = virtualItems.flatMap((item) => (item.type === 'thread' ? [item.thread] : []))
  const index = threads.findIndex((thread) => thread.paneKey === focusedKey)
  const next = threads[event.key === 'ArrowDown' ? index + 1 : index - 1]
  if (!next) {
    return
  }
  event.preventDefault()
  const itemIndex = findActivityThreadItemIndex(virtualItems, next.paneKey)
  if (itemIndex !== null) {
    virtualizer.scrollToIndex(itemIndex, { align: 'auto' })
  }
  requestAnimationFrame(() => {
    const row = scrollContainer.querySelector(`[data-pane-key="${CSS.escape(next.paneKey)}"]`)
    if (row instanceof HTMLElement) {
      row.focus()
    }
  })
}

export function useActivityThreadKeyboardNavigation(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  virtualItems: readonly ActivityVirtualItemDescriptor[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  selectedPaneKey: string | null,
  selectedItemIndex: number | null
): void {
  const prevSelectedPaneKeyRef = useRef<string | null>(selectedPaneKey)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) =>
      handleActivityThreadArrowKey(event, virtualItems, virtualizer, container)
    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
  }, [scrollContainerRef, virtualItems, virtualizer])

  // Reveal a newly selected row (digit jumps, fallbacks); clicks and reorders are no-ops.
  useEffect(() => {
    if (prevSelectedPaneKeyRef.current === selectedPaneKey) {
      return
    }
    prevSelectedPaneKeyRef.current = selectedPaneKey
    if (selectedItemIndex !== null) {
      virtualizer.scrollToIndex(selectedItemIndex, { align: 'auto' })
    }
  }, [selectedItemIndex, selectedPaneKey, virtualizer])
}
