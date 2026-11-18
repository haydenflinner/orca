import type { BranchContext } from './worktree-agent-branch-context'
import React, { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useAgentPresentation, useWorktreeAgentRow } from './useWorktreeAgentRows'
import { cn } from '@/lib/class-names'
import { AgentTintProvider, useAgentTint } from '@/lib/agent-tint/agent-tint-context'
import { CompactAgentExpansion } from './worktree-card-compact-agents'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { opensClaudeParentConversation } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { IdleChildAgentGroupRow } from './worktree-card-idle-child-agents'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentChildren } from '@/store/slices/agent-status/projection/agent-row-display-model'
import type { DashboardAgentRow as AgentRow } from '@/components/dashboard/rows/dashboard-agent-row'

export const AgentBranches = React.memo(function AgentBranches({
  keysToRender,
  context,
  timerActive,
  root = false,
  reservedHues
}: {
  keysToRender: readonly string[]
  context: BranchContext
  timerActive: boolean
  root?: boolean
  /** Parent rows claim their hue first so children never shade the same color. */
  reservedHues?: readonly number[]
}) {
  return (
    <AgentTintProvider keys={keysToRender} reservedHues={reservedHues}>
      {keysToRender.map((key) => (
        <AgentBranch
          key={key}
          paneKey={key}
          context={context}
          timerActive={timerActive}
          root={root}
        />
      ))}
    </AgentTintProvider>
  )
})
const AgentBranch = React.memo(function AgentBranch({
  paneKey,
  context,
  timerActive,
  root
}: {
  paneKey: string
  context: BranchContext
  timerActive: boolean
  root: boolean
}) {
  const row = useWorktreeAgentRow(paneKey)
  const tint = useAgentTint(paneKey)
  const children = useAgentPresentation(
    `children\0${paneKey}`,
    useCallback((p) => p.display.children(paneKey), [paneKey])
  )
  const focusedDescendant = useAgentPresentation(
    `children\0${paneKey}`,
    useCallback(
      (p) => {
        const seen = new Set<string>()
        for (
          let key = context.focusedPaneKey;
          key && !seen.has(key);
          key = p.row(key)?.lineage?.parentPaneKey ?? null
        ) {
          if (key === paneKey) {
            return true
          }
          seen.add(key)
        }
        return false
      },
      [context.focusedPaneKey, paneKey]
    )
  )
  const acknowledgedAt = useAppStore((s) => s.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  const t = useTranslate()
  if (!row) {
    return null
  }
  const compact = context.agentActivityDisplayMode === 'compact',
    expanded = Boolean(context.targets) || context.expansion.expandedLineageParents.has(paneKey)
  const hasChildren = children.keys.length > 0,
    idleExpanded = context.expansion.expandedIdleChildGroups.has(paneKey)
  const target = context.targets
    ? (context.targets.get(paneKey) ?? {
        status: 'disabled' as const,
        disabledReason: t(
          'auto.components.sidebar.WorktreeCardAgents.agentUnavailable',
          'Agent is not available'
        )
      })
    : undefined
  const common = {
    agent: row,
    showModel: context.showAgentModels,
    now: context.now,
    isUnvisited: row.rowSource === 'live' && acknowledgedAt < row.entry.stateStartedAt,
    onActivate: context.onActivate,
    childAgentCount: hasChildren ? children.keys.length : undefined,
    childAgentsExpanded: expanded,
    collapsedChildAgentsState: hasChildren && !expanded ? children.signal : undefined,
    onToggleChildAgents:
      hasChildren && !context.targets ? () => context.toggleLineage(paneKey) : undefined,
    isFocusedPane: paneKey === context.focusedPaneKey || (!expanded && focusedDescendant),
    sendTargetStatus: target?.status,
    sendTargetDisabledReason: target?.disabledReason,
    onSendTargetClick: context.targets ? context.onSend : undefined
  }
  const childList = (
    <AgentBranchChildren
      row={row}
      childState={children}
      context={context}
      timerActive={timerActive && expanded}
      idleExpanded={idleExpanded}
      reservedHues={[tint.h]}
    />
  )
  return (
    <div className={compact ? cn('min-w-0', root && 'ms-2') : undefined}>
      {compact ? (
        <CompactAgentRow
          {...common}
          parentConversationDescription={
            opensClaudeParentConversation(row)
              ? t('auto.lib.claudeAgentRowView.openParentConversation', 'Open parent conversation')
              : undefined
          }
          cacheTimerActive={timerActive}
        />
      ) : (
        <DashboardAgentRow
          {...common}
          onDismiss={context.onDismiss}
          stateDotSize="sm"
          hideExpand
          hideLineageConnectors
        />
      )}
      {hasChildren ? (
        compact ? (
          <CompactAgentExpansion expanded={expanded}>
            <div className="worktree-agent-lineage-children flex flex-col gap-0.5">{childList}</div>
          </CompactAgentExpansion>
        ) : expanded ? (
          <div className="worktree-agent-lineage-children">{childList}</div>
        ) : null
      ) : null}
    </div>
  )
})
const AgentBranchChildren = React.memo(
  function AgentBranchChildren({
    row,
    childState: children,
    context,
    timerActive,
    idleExpanded,
    reservedHues
  }: {
    row: AgentRow
    childState: AgentChildren
    context: BranchContext
    timerActive: boolean
    idleExpanded: boolean
    reservedHues?: readonly number[]
  }) {
    const compact = context.agentActivityDisplayMode === 'compact',
      active = context.targets ? children.keys : children.active,
      idle = context.targets ? [] : children.idle
    return (
      <>
        <AgentBranches
          keysToRender={active}
          context={context}
          timerActive={timerActive}
          reservedHues={reservedHues}
        />
        {idle.length > 0 ? (
          <>
            <IdleChildAgentGroupRow
              count={idle.length}
              expanded={idleExpanded}
              onToggle={() => context.toggleIdle(row.paneKey)}
              layout={compact ? 'compact' : 'full'}
              ariaLevel={(row.lineage?.depth ?? 0) + 2}
            />
            {compact ? (
              <CompactAgentExpansion expanded={idleExpanded}>
                <AgentBranches
                  keysToRender={idle}
                  context={context}
                  timerActive={timerActive && idleExpanded}
                  reservedHues={reservedHues}
                />
              </CompactAgentExpansion>
            ) : idleExpanded ? (
              <AgentBranches
                keysToRender={idle}
                context={context}
                timerActive={timerActive}
                reservedHues={reservedHues}
              />
            ) : null}
          </>
        ) : null}
      </>
    )
  },
  (before, after) =>
    before.row.paneKey === after.row.paneKey &&
    before.row.lineage === after.row.lineage &&
    before.childState === after.childState &&
    before.context === after.context &&
    before.timerActive === after.timerActive &&
    before.idleExpanded === after.idleExpanded &&
    before.reservedHues?.[0] === after.reservedHues?.[0]
)
