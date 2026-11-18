import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useNow } from '@/lib/window-activity/use-now'
import { deriveRunningAgentSendTargets } from '@/lib/agent-session/messaging/running-agent-targets'
import {
  selectSendTargetControlInputs,
  selectSendTargetInputs
} from './worktree-card-send-target-inputs'
import { useAgentPresentation } from './useWorktreeAgentRows'
import { useHostRootKeys } from './use-worktree-agent-host-roots'
import { KeyedSummary } from './worktree-card-agent-keyed-summary'
import { AgentBranches } from './worktree-card-agent-branches'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { useWorktreeAgentDisplay } from './use-worktree-agent-display'
import { cn } from '@/lib/class-names'
import { recomputeOn } from '@/lib/recompute-on'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'
import { CompactAgentExpansion } from './worktree-card-compact-agents'
import { revealCompactAgentCard } from '../../worktree-list/navigation/worktree-sidebar-reveal'
import {
  COMPACT_ROOT_LIST_AUTO_EXPAND_MAX,
  useWorktreeAgentExpansionState
} from './worktree-card-agents-expansion-state'
import { useTranslate } from '@/i18n/use-translate'
import { agentSendDisabledReasonLabel } from '@/lib/agent-session/messaging/agent-send-disabled-reason-label'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useWorktreeAgentActivation } from './use-worktree-agent-activation'

const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()
type Props = {
  worktreeId: string
  /** The card's host; local and remote copies can share a workspace ID, so activation must name it. */
  executionHostId?: ExecutionHostId
  className?: string
}

export default React.memo(function WorktreeCardAgents({
  worktreeId,
  executionHostId,
  className
}: Props) {
  const allRoots = useAgentPresentation(
    `roots\0${worktreeId}`,
    useCallback((p) => p.display.roots(worktreeId), [worktreeId])
  )
  const roots = useHostRootKeys(worktreeId, executionHostId, allRoots)
  return roots.length ? (
    <WorktreeCardAgentsBody
      worktreeId={worktreeId}
      executionHostId={executionHostId}
      roots={roots}
      hostFiltered={roots !== allRoots}
      className={className}
    />
  ) : null
})

function WorktreeCardAgentsBody({
  worktreeId,
  executionHostId,
  roots,
  hostFiltered,
  className
}: Props & { roots: readonly string[]; hostFiltered: boolean }) {
  const t = useTranslate(),
    languageRevision = useUiLanguageRevision()
  const display = useWorktreeAgentDisplay()
  const expansion = useWorktreeAgentExpansionState(
    worktreeId,
    executionHostId,
    roots.length <= COMPACT_ROOT_LIST_AUTO_EXPAND_MAX
  )
  const focusedPaneKey = useFocusedAgentPaneKey(worktreeId)
  const onActivate = useWorktreeAgentActivation(worktreeId, executionHostId)
  const onDismiss = useAppStore((s) => s.dropAgentStatus)
  const send = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const control = useAppStore(useShallow((s) => selectSendTargetControlInputs(s, worktreeId)))
  const inputs = useAppStore(useShallow((s) => selectSendTargetInputs(s, worktreeId)))
  const targets = useMemo(
    () =>
      recomputeOn([languageRevision], () => {
        if (!control.targetMode) {
          return null
        }
        return new Map(
          deriveRunningAgentSendTargets(inputs, worktreeId).map((target) => [
            target.paneKey,
            control.targetMode?.status === 'sending' &&
            control.targetMode.sendingPaneKey === target.paneKey
              ? {
                  status: 'sending' as const,
                  disabledReason: t(
                    'auto.components.sidebar.WorktreeCardAgents.sendingTarget',
                    'Sending...'
                  )
                }
              : {
                  status: target.status,
                  ...(target.disabledReason
                    ? { disabledReason: agentSendDisabledReasonLabel(target.disabledReason) }
                    : {})
                }
          ])
        )
      }),
    [control, inputs, worktreeId, t, languageRevision]
  )
  const onSend = useCallback(
    (key: string) => {
      void send(key)
    },
    [send]
  )
  const { toggleLineageParent: toggleLineage, toggleIdleChildGroup: toggleIdle } = expansion
  const now = useNow(30_000)
  const context = useMemo(
    () => ({
      worktreeId,
      agentActivityDisplayMode: display.agentActivityDisplayMode,
      showAgentModels: display.showAgentModels,
      expansion,
      focusedPaneKey,
      onActivate,
      onDismiss,
      targets,
      onSend,
      toggleLineage,
      toggleIdle,
      now
    }),
    [
      worktreeId,
      display.agentActivityDisplayMode,
      display.showAgentModels,
      expansion,
      focusedPaneKey,
      onActivate,
      onDismiss,
      targets,
      onSend,
      toggleLineage,
      toggleIdle,
      now
    ]
  )
  const compact = display.agentActivityDisplayMode === 'compact',
    summary = compact && roots.length > 1 && !targets
  const rootRef = useRef<HTMLDivElement | null>(null),
    previousExpanded = useRef(expansion.compactRootListExpanded)
  useLayoutEffect(() => {
    const wasExpanded = previousExpanded.current
    previousExpanded.current = expansion.compactRootListExpanded
    if (!wasExpanded && expansion.compactRootListExpanded && compact) {
      // Defer reveal one frame to avoid synchronous sidebar layout during the opening animation.
      const handle = requestAnimationFrame(() => revealCompactAgentCard(rootRef.current))
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [compact, expansion.compactRootListExpanded])
  return (
    <div
      ref={rootRef}
      className={cn(compact ? 'flex flex-col mt-1 gap-0.5' : 'flex flex-col mt-1', className)}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      role="tree"
      aria-label={t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
      data-compact-agent-list={compact || undefined}
    >
      {summary ? (
        <div
          className={cn(
            'compact-agent-summary-panel',
            expansion.compactRootListExpanded && 'compact-agent-summary-panel-expanded'
          )}
        >
          <KeyedSummary
            worktreeId={worktreeId}
            roots={roots}
            hostFiltered={hostFiltered}
            expanded={expansion.compactRootListExpanded}
            onToggle={expansion.toggleCompactRootList}
          />
          <CompactAgentExpansion expanded={expansion.compactRootListExpanded}>
            <AgentBranches
              keysToRender={roots}
              context={context}
              timerActive={expansion.compactRootListExpanded}
              root
            />
          </CompactAgentExpansion>
        </div>
      ) : (
        <AgentBranches keysToRender={roots} context={context} timerActive root />
      )}
    </div>
  )
}
