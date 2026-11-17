import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { SidebarActivityBadge } from './sidebar-activity-badge'
import { activityThreadStatusId } from '@/components/activity/threads/activity-thread-presentation'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { hasActivityThreadWorkspace } from '@/components/activity/thread-list/activity-thread-actions'
import { useActivityThreadActionBindings } from '@/components/activity/thread-list/use-activity-thread-action-bindings'
import { AgentTintProvider } from '@/lib/agent-tint/agent-tint-context'
import { ActivityThreadListPane } from '@/components/activity/thread-list/activity-thread-list-pane'
import { subscribeAgentsListIndexJump } from '@/components/activity/agents-list-index-jump'
import { AGENTS_TWO_COLUMN_MIN_WIDTH } from '@/components/activity/thread-list/activity-thread-virtual-items'
import { ActivityIndexHintsContext } from '@/components/activity/activity-index-hints-context'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { useModifierHeldClass } from '../editor/rich-markdown/viewport/useModifierHeldClass'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import { textFieldClaimsActionKey } from '@/lib/keyboard/text-field-shortcut-policy'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { useAgentPaneThreads } from '@/components/activity/threads/use-agent-pane-threads'
import '@/components/activity/thread-list/activity-thread-controls'
import { ActivityThreadOptionsMenu } from '@/components/activity/thread-list/activity-thread-options-menu'
import type {
  ActivityGroupBy,
  ThreadReadFilter
} from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

/** Select threads by revealing their existing panes; threads whose panes are gone remain listed but inert. */
export type SidebarAgentsListProps = {
  active?: boolean
  readFilter: ThreadReadFilter
  setReadFilter: (filter: ThreadReadFilter) => void
  groupBy: ActivityGroupBy
  setGroupBy: (groupBy: ActivityGroupBy) => void
  query: string
  setQuery: (query: string) => void
  badgeTarget?: HTMLElement | null
  optionsTarget?: HTMLElement | null
  scrollTopRef?: React.MutableRefObject<number>
}

export default function SidebarAgentsList({
  active = true,
  badgeTarget,
  ...listProps
}: SidebarAgentsListProps): React.JSX.Element | null {
  useTranslation()
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)

  const threads = useAgentPaneThreads({
    query: listProps.query,
    readFilter: listProps.readFilter,
    groupBy: listProps.groupBy,
    selectedPaneKey,
    showChildAgents,
    badgeOnly: !active
  })
  const { selectedPaneKeyIsLive, visibleThreads } = threads

  if ((!active && selectedPaneKey !== null) || !selectedPaneKeyIsLive) {
    // Reset selection when leaving Activity or when its pane vanishes.
    setSelectedPaneKey(null)
  }

  const counts = { attention: 0, working: 0 }
  for (const thread of visibleThreads) {
    if (!thread.currentAgentState) {
      continue
    }
    const status = activityThreadStatusId(thread)
    if (status === 'waiting' || status === 'blocked') {
      counts.attention += 1
    } else if (status === 'working' || status === 'monitoring') {
      counts.working += 1
    }
  }

  const badge = badgeTarget
    ? createPortal(<SidebarActivityBadge counts={counts} />, badgeTarget)
    : null
  if (!active) {
    return badge
  }

  return (
    <>
      {badge}
      <SidebarAgentsListBody
        {...listProps}
        threads={threads}
        setSelectedPaneKey={setSelectedPaneKey}
      />
    </>
  )
}

function SidebarAgentsListBody({
  readFilter,
  setReadFilter,
  groupBy,
  setGroupBy,
  query,
  setQuery,
  optionsTarget,
  scrollTopRef,
  threads,
  setSelectedPaneKey
}: Omit<SidebarAgentsListProps, 'active' | 'badgeTarget'> & {
  threads: ReturnType<typeof useAgentPaneThreads>
  setSelectedPaneKey: (paneKey: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Subscribe here because the translated search row mounts conditionally.
  useTranslation()
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const twoColumn = useAppStore((s) => s.agentsTwoColumn)
  const setTwoColumn = useAppStore((s) => s.setAgentsTwoColumn)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const columns = twoColumn && sidebarWidth >= AGENTS_TWO_COLUMN_MIN_WIDTH ? 2 : 1
  const showSearch = useAppStore((s) => s.agentsShowSearch)
  const setShowSearch = useAppStore((s) => s.setAgentsShowSearch)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)
  const threadListRef = useRef<HTMLDivElement | null>(null)

  const handleShowSearchChange = useCallback(
    (visible: boolean) => {
      setShowSearch(visible)
      if (!visible) {
        setQuery('')
        return
      }
      // Focus after the newly visible input mounts.
      requestAnimationFrame(() => activityFilterInputRef.current?.focus())
    },
    [setQuery, setShowSearch]
  )

  const {
    storeData,
    effectiveSelectedPaneKey,
    visibleThreads,
    markAllReadThreads,
    visibleThreadGroups
  } = threads

  const {
    markThreadRead,
    markThreadUnread,
    markThreadsRead,
    markThreadsUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead,
    hasUnreadThreads,
    hasCompletedThreads,
    handleClearCompleted
  } = useActivityThreadActionBindings({
    visibleThreads,
    markAllReadThreads,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents,
    setSelectedPaneKey
  })

  // Digit jumps address the first nine rows of the filtered list; hints show the same numbering.
  const shortcutIndexByPaneKey = useMemo(
    () => new Map(visibleThreads.slice(0, 9).map((thread, index) => [thread.paneKey, index])),
    [visibleThreads]
  )
  const digitShortcutDetails = useShortcutKeyComboDetails('workspace.selectByIndex')
  const digitShortcutModifiers = useMemo(
    () => digitShortcutDetails[0]?.keys.slice(0, -1) ?? [],
    [digitShortcutDetails]
  )
  const indexHints = useMemo(
    () => ({ indexByPaneKey: shortcutIndexByPaneKey, modifierKeys: digitShortcutModifiers }),
    [shortcutIndexByPaneKey, digitShortcutModifiers]
  )
  // Arms `agents-index-hints-armed` while the chord's modifier is held; rows reveal their digit chip.
  useModifierHeldClass(
    threadListRef,
    navigator.userAgent.includes('Mac'),
    'agents-index-hints-armed'
  )

  // The "focus the sidebar list" chord lands on the open row so arrows continue from it.
  const keybindings = useAppStore((s) => s.keybindings)
  const activeModal = useAppStore((s) => s.activeModal)
  const focusCurrentRow = useCallback(() => {
    const paneKey = effectiveSelectedPaneKey ?? visibleThreads[0]?.paneKey
    if (!paneKey) {
      return
    }
    // The open row is kept mounted by the virtualizer, so it is focusable even offscreen.
    const row = threadListRef.current?.querySelector(`[data-pane-key="${CSS.escape(paneKey)}"]`)
    if (row instanceof HTMLElement) {
      row.focus()
    }
  }, [effectiveSelectedPaneKey, visibleThreads])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || activeModal !== 'none') {
        return
      }
      const platform = getShortcutPlatform()
      if (
        keybindingMatchesAction('sidebar.focusWorktreeList', event, platform, keybindings) &&
        !textFieldClaimsActionKey(event, 'sidebar.focusWorktreeList') &&
        !hasVisibleOverlay()
      ) {
        event.preventDefault()
        focusCurrentRow()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [keybindings, activeModal, focusCurrentRow])

  // Cmd+digit names a row of the filtered list while this view is the sidebar body.
  useEffect(
    () =>
      subscribeAgentsListIndexJump((index) => {
        const thread = threads.visibleThreads[index]
        if (!thread) {
          return
        }
        selectThread(thread)
        // After the pane scrolls the row into the virtual window, focus it so arrows continue from it.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const row = threadListRef.current?.querySelector(
              `[data-pane-key="${CSS.escape(thread.paneKey)}"]`
            )
            if (row instanceof HTMLElement) {
              row.focus()
            }
          })
        })
      }),
    [threads, selectThread]
  )

  const worktreesByRepo = selectWorktreesByRepo(storeData)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(storeData)
  const folderWorkspaces = selectFolderWorkspaces(storeData)

  const canJumpToWorkspace = useCallback(
    (thread: Parameters<typeof hasActivityThreadWorkspace>[0]) =>
      hasActivityThreadWorkspace(thread, {
        worktreesByRepo,
        detectedWorktreesByRepo,
        folderWorkspaces,
        floatingWorkspacePath: storeData.floatingWorkspacePath,
        defaultHostId: storeData.defaultHostId
      }),
    [
      worktreesByRepo,
      detectedWorktreesByRepo,
      folderWorkspaces,
      storeData.floatingWorkspacePath,
      storeData.defaultHostId
    ]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch ? (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <Input
            ref={activityFilterInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                handleShowSearchChange(false)
              }
            }}
            placeholder={t(
              'auto.components.activity.ActivityPrototypePage.795cbf26e2',
              'Filter...'
            )}
            className="h-7 w-full text-[11px] shadow-none focus-visible:ring-0"
            aria-label={t('auto.components.activity.ActivityPrototypePage.search', 'Search')}
          />
        </div>
      ) : null}
      <ActivityIndexHintsContext.Provider value={indexHints}>
        <AgentTintProvider
          keys={visibleThreadGroups.flatMap((g) => g.threads.map((t) => t.paneKey))}
        >
          <ActivityThreadListPane
            activityFilterInputRef={activityFilterInputRef}
            query={query}
            onQueryChange={setQuery}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            readFilter={readFilter}
            onReadFilterChange={setReadFilter}
            compactMode={compactMode}
            showChildAgents={showChildAgents}
            hasUnreadThreads={hasUnreadThreads}
            onCompactModeChange={setCompactMode}
            onShowChildAgentsChange={setShowChildAgents}
            onMarkAllThreadsRead={markAllThreadsRead}
            hasCompletedThreads={hasCompletedThreads}
            onClearCompleted={handleClearCompleted}
            columns={columns}
            visibleThreadGroups={visibleThreadGroups}
            visibleThreadCount={visibleThreads.length}
            selectedPaneKey={effectiveSelectedPaneKey}
            onSelectThread={selectThread}
            onJumpToWorkspace={jumpToWorkspace}
            onMarkThreadRead={markThreadRead}
            onMarkThreadUnread={markThreadUnread}
            onMarkThreadsRead={markThreadsRead}
            onMarkThreadsUnread={markThreadsUnread}
            canJumpToWorkspace={canJumpToWorkspace}
            allowMarkUnreadWhenSelected
            showJumpAction={false}
            showFilterControls={false}
            showOptionsMenu={false}
            showInlineActions={false}
            scrollTopRef={scrollTopRef}
            threadListRef={threadListRef}
          />
        </AgentTintProvider>
      </ActivityIndexHintsContext.Provider>
      {optionsTarget
        ? createPortal(
            <ActivityThreadOptionsMenu
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              compactMode={compactMode}
              twoColumn={twoColumn}
              onTwoColumnChange={setTwoColumn}
              showChildAgents={showChildAgents}
              hasUnreadThreads={hasUnreadThreads}
              hasCompletedThreads={hasCompletedThreads}
              onCompactModeChange={setCompactMode}
              onShowChildAgentsChange={setShowChildAgents}
              onMarkAllThreadsRead={markAllThreadsRead}
              onClearCompleted={handleClearCompleted}
              showSearch={showSearch}
              onShowSearchChange={handleShowSearchChange}
              unreadOnly={readFilter === 'unread'}
              onUnreadOnlyChange={(unreadOnly) => setReadFilter(unreadOnly ? 'unread' : 'all')}
            />,
            optionsTarget
          )
        : null}
    </div>
  )
}
