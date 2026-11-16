import type { ActivityGroupBy } from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import type { ActivityThreadGroup, AgentPaneThread } from '../threads/activity-thread-types'

/** DOM contract for "focus is on the activity list" — used by chat focus/typing routing. */
export const ACTIVITY_VIRTUAL_LIST_SELECTOR = '[data-activity-virtual-list]'

/** One row of the virtualized Activity list: a group header, a thread, or a two-column thread pair. */
export type ActivityVirtualItemDescriptor =
  | { type: 'header'; group: ActivityThreadGroup }
  | { type: 'thread'; thread: AgentPaneThread; groupKey: string }
  | { type: 'thread-pair'; threads: readonly AgentPaneThread[]; groupKey: string }

export const ACTIVITY_HEADER_ROW_ESTIMATE = 32
export const ACTIVITY_THREAD_ROW_COMPACT_ESTIMATE = 96
export const ACTIVITY_THREAD_ROW_FULL_ESTIMATE = 116
/** Sidebar width at which thread rows pack two per row; narrower stays single-column. */
export const AGENTS_TWO_COLUMN_MIN_WIDTH = 440

/**
 * Flatten grouped threads into a single virtualizable row list, honoring
 * collapsed groups (their thread rows are omitted entirely). In two-column
 * mode each row holds up to two threads of the same group.
 */
export function buildActivityVirtualItems(args: {
  groups: readonly ActivityThreadGroup[]
  groupBy: ActivityGroupBy
  collapsedGroupKeys: ReadonlySet<string>
  columns?: 1 | 2
}): ActivityVirtualItemDescriptor[] {
  const items: ActivityVirtualItemDescriptor[] = []
  for (const group of args.groups) {
    if (args.groupBy !== 'none') {
      items.push({ type: 'header', group })
      if (args.collapsedGroupKeys.has(group.key)) {
        continue
      }
    }
    if (args.columns === 2) {
      for (let index = 0; index < group.threads.length; index += 2) {
        items.push({
          type: 'thread-pair',
          threads: group.threads.slice(index, index + 2),
          groupKey: group.key
        })
      }
    } else {
      for (const thread of group.threads) {
        items.push({ type: 'thread', thread, groupKey: group.key })
      }
    }
  }
  return items
}

/** Stable per-row key: group key for headers, paneKey(s) for thread rows. */
export function getActivityVirtualItemKey(item: ActivityVirtualItemDescriptor): string {
  if (item.type === 'header') {
    return `h:${item.group.key}`
  }
  if (item.type === 'thread-pair') {
    return `p:${item.threads.map((thread) => thread.paneKey).join(',')}`
  }
  return `t:${item.thread.paneKey}`
}

export function estimateActivityVirtualItemSize(
  item: ActivityVirtualItemDescriptor | undefined,
  compactMode: boolean
): number {
  if (!item || item.type === 'header') {
    return ACTIVITY_HEADER_ROW_ESTIMATE
  }
  return compactMode ? ACTIVITY_THREAD_ROW_COMPACT_ESTIMATE : ACTIVITY_THREAD_ROW_FULL_ESTIMATE
}

/** Index of the selected thread's row, or null; kept mounted so activation and focus survive scrolling. */
export function findActivityThreadItemIndex(
  items: readonly ActivityVirtualItemDescriptor[],
  paneKey: string | null
): number | null {
  if (paneKey === null) {
    return null
  }
  const index = items.findIndex(
    (item) =>
      (item.type === 'thread' && item.thread.paneKey === paneKey) ||
      (item.type === 'thread-pair' && item.threads.some((thread) => thread.paneKey === paneKey))
  )
  return index === -1 ? null : index
}

/** Indexes of header rows, for sticky-header resolution. */
export function getActivityHeaderItemIndexes(
  items: readonly ActivityVirtualItemDescriptor[]
): number[] {
  const indexes: number[] = []
  items.forEach((item, index) => {
    if (item.type === 'header') {
      indexes.push(index)
    }
  })
  return indexes
}
