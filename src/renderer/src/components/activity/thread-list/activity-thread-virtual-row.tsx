import React, { useContext } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { ActivityIndexHintsContext } from './activity-index-hints-context'
import { clearActivityThread, isClearableActivityThread } from './activity-clear-completed'
import { ActivityStatusGroupHeader } from './activity-thread-controls'
import { ActivityThreadContextMenu } from './activity-thread-context-menu'
import { ActivityThreadRow } from './activity-thread-row'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { ActivityVirtualItemDescriptor } from './activity-thread-virtual-items'
import type { ActivityGroupBy } from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'

type ContextMenuProps = Parameters<typeof ActivityThreadContextMenu>[0]

export function ActivityThreadVirtualRow({
  item,
  collapsed,
  onToggleGroup,
  selectedPaneKey,
  multiSelectedKeys,
  onSelectThread,
  onOpenThread,
  getContextMenuTargets,
  onJumpToWorkspace,
  onMarkThreadRead,
  onMarkThreadUnread,
  onMarkThreadsRead,
  onMarkThreadsUnread,
  canJumpToWorkspace,
  canMarkThreadUnread,
  compactMode,
  showJumpAction,
  groupBy
}: {
  item: ActivityVirtualItemDescriptor
  collapsed: boolean
  onToggleGroup: (groupKey: string) => void
  selectedPaneKey: string | null
  multiSelectedKeys: ReadonlySet<string>
  onSelectThread: Parameters<typeof ActivityThreadRow>[0]['onSelect']
  onOpenThread: ContextMenuProps['onOpen']
  getContextMenuTargets: ContextMenuProps['getTargets']
  onJumpToWorkspace: Parameters<typeof ActivityThreadRow>[0]['onJump']
  onMarkThreadRead: Parameters<typeof ActivityThreadRow>[0]['onMarkRead']
  onMarkThreadUnread: Parameters<typeof ActivityThreadRow>[0]['onMarkUnread']
  onMarkThreadsRead: ContextMenuProps['onMarkManyRead']
  onMarkThreadsUnread: ContextMenuProps['onMarkManyUnread']
  canJumpToWorkspace: (thread: AgentPaneThread) => boolean
  canMarkThreadUnread: (thread: AgentPaneThread) => boolean
  compactMode: boolean
  showJumpAction: boolean
  groupBy: ActivityGroupBy
}): React.JSX.Element {
  const t = useTranslate()
  const indexHints = useContext(ActivityIndexHintsContext)
  if (item.type === 'header') {
    return (
      <div
        role="group"
        aria-label={t(
          'auto.components.activity.ActivityPrototypePage.a2b4437bfb',
          '{{value0}} activity',
          { value0: item.group.label }
        )}
        className="pb-1"
      >
        <ActivityStatusGroupHeader
          group={item.group}
          collapsed={collapsed}
          onToggle={() => onToggleGroup(item.group.key)}
        />
      </div>
    )
  }
  const threads = item.type === 'thread' ? [item.thread] : item.threads
  const renderThreadCell = (thread: AgentPaneThread, key: string): React.JSX.Element => {
    const canJump = canJumpToWorkspace(thread)
    const isOpen = thread.paneKey === selectedPaneKey
    return (
      <ActivityThreadContextMenu
        key={key}
        thread={thread}
        canJump={canJump}
        canMarkUnread={canMarkThreadUnread}
        getTargets={getContextMenuTargets}
        onOpen={onOpenThread}
        onJump={onJumpToWorkspace}
        onMarkRead={onMarkThreadRead}
        onMarkUnread={onMarkThreadUnread}
        onMarkManyRead={onMarkThreadsRead}
        onMarkManyUnread={onMarkThreadsUnread}
      >
        {(menuOpen) => (
          // Wrap the row: stacking two Radix triggers on its hover target would compose their refs.
          <div className={threads.length === 1 ? 'col-span-2' : undefined}>
            <ActivityThreadRow
              thread={thread}
              selected={isOpen}
              multiSelected={!isOpen && multiSelectedKeys.has(thread.paneKey)}
              onSelect={onSelectThread}
              onOpen={onOpenThread}
              onJump={onJumpToWorkspace}
              onMarkRead={onMarkThreadRead}
              onMarkUnread={onMarkThreadUnread}
              onClear={isClearableActivityThread(thread) ? clearActivityThread : undefined}
              canJump={canJump}
              compactMode={compactMode}
              disableMarkUnread={!canMarkThreadUnread(thread)}
              showJumpAction={showJumpAction}
              groupBy={groupBy}
              previewSuppressed={menuOpen}
              shortcutIndex={indexHints?.indexByPaneKey.get(thread.paneKey)}
              shortcutModifierKeys={indexHints?.modifierKeys}
            />
          </div>
        )}
      </ActivityThreadContextMenu>
    )
  }
  if (item.type === 'thread') {
    return <div className="pb-0.5">{renderThreadCell(item.thread, item.thread.paneKey)}</div>
  }
  return (
    <div className="grid grid-cols-2 gap-x-1 pb-0.5">
      {item.threads.map((thread, index) => renderThreadCell(thread, `${thread.paneKey}:${index}`))}
    </div>
  )
}
