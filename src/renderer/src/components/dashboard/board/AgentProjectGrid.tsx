import { memo, useCallback, useMemo, useState } from 'react'
import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { DASHBOARD_BUCKET_ORDER } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { AgentKanbanCard } from './AgentKanbanCard'
import { DashboardHostBadge } from './DashboardHostBadge'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { useTranslate } from '@/i18n/use-translate'

const BUCKET_RANK = new Map<DashboardBucket, number>(
  DASHBOARD_BUCKET_ORDER.map((bucket, index) => [bucket, index])
)

export type AgentProjectTile = {
  key: string
  worktreeId: string
  repoId: string
  executionHostId?: ExecutionHostId
  repoName: string
  worktreeName: string
  hostKind?: DashboardCard['hostKind']
  hostLabel?: string
  cards: DashboardCard[]
  worstRank: number
  lastChangedAt: number
}

export function groupDashboardCardsByProject(cards: DashboardCard[]): AgentProjectTile[] {
  const tilesByKey = new Map<string, AgentProjectTile>()
  for (const card of cards) {
    const key = `${card.executionHostId ?? 'local'}:${card.worktreeId}`
    const rank = BUCKET_RANK.get(card.bucket) ?? DASHBOARD_BUCKET_ORDER.length
    const existing = tilesByKey.get(key)
    if (existing) {
      existing.cards.push(card)
      existing.worstRank = Math.min(existing.worstRank, rank)
      existing.lastChangedAt = Math.max(existing.lastChangedAt, card.stateChangedAt)
      continue
    }
    tilesByKey.set(key, {
      key,
      worktreeId: card.worktreeId,
      repoId: card.repoId,
      executionHostId: card.executionHostId,
      repoName: card.repoName,
      worktreeName: card.worktreeName,
      hostKind: card.hostKind,
      hostLabel: card.hostLabel,
      cards: [card],
      worstRank: rank,
      lastChangedAt: card.stateChangedAt
    })
  }
  const tiles = [...tilesByKey.values()]
  for (const tile of tiles) {
    tile.cards.sort(
      (a, b) =>
        (BUCKET_RANK.get(a.bucket) ?? DASHBOARD_BUCKET_ORDER.length) -
          (BUCKET_RANK.get(b.bucket) ?? DASHBOARD_BUCKET_ORDER.length) ||
        b.stateChangedAt - a.stateChangedAt
    )
  }
  // Needs-you projects lead; ties fall to the most recently changed tile.
  tiles.sort((a, b) => a.worstRank - b.worstRank || b.lastChangedAt - a.lastChangedAt)
  return tiles
}

const EMPTY_PANE_KEYS: ReadonlySet<string> = new Set()

function AgentProjectTileView({
  tile,
  repoIcon,
  now,
  onOpenTerminal
}: {
  tile: AgentProjectTile
  repoIcon: RepoIcon | null | undefined
  now: number
  onOpenTerminal: (card: DashboardCard) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [expandedPaneKeys, setExpandedPaneKeys] = useState<ReadonlySet<string>>(EMPTY_PANE_KEYS)
  const toggleSubagents = useCallback((paneKey: string) => {
    setExpandedPaneKeys((current) => {
      const next = new Set(current)
      if (!next.delete(paneKey)) {
        next.add(paneKey)
      }
      return next
    })
  }, [])
  return (
    <section
      aria-label={`${tile.repoName} / ${tile.worktreeName}`}
      className="flex max-h-[420px] min-w-0 flex-col rounded-xl border border-border/60 bg-muted/30"
    >
      <header className="flex items-center gap-1.5 px-3 py-2">
        <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted-foreground/10 text-muted-foreground">
          <RepoIconGlyph repoIcon={repoIcon} className="size-3" iconClassName="size-3" />
        </span>
        <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">
          {tile.repoName}
        </span>
        {tile.worktreeName !== tile.repoName ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            / {tile.worktreeName}
          </span>
        ) : null}
        <DashboardHostBadge
          hostKind={tile.hostKind}
          executionHostId={tile.executionHostId}
          hostLabel={tile.hostLabel}
          className="size-[18px] shrink-0 rounded-[5px] bg-muted-foreground/10"
        />
        <span className="ml-auto shrink-0 rounded-full bg-background px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {t('dashboardPopout.projectGrid.agentCount', '{{count}} agents', {
            count: tile.cards.length,
            defaultValue_one: '{{count}} agent'
          })}
        </span>
      </header>
      <div className="scrollbar-sleek grid min-h-0 gap-2 overflow-y-auto px-2 pb-2">
        {tile.cards.map((card) => (
          <AgentKanbanCard
            key={card.paneKey}
            card={card}
            repoIcon={repoIcon}
            now={now}
            subagentsOpen={expandedPaneKeys.has(card.paneKey)}
            onToggleSubagents={toggleSubagents}
            onOpenTerminal={onOpenTerminal}
          />
        ))}
      </div>
    </section>
  )
}

type AgentProjectGridProps = {
  cards: DashboardCard[]
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  onOpenTerminal: (card: DashboardCard) => void
}

/** One tile per project: the same cards as the status lanes, filed under their workspace. */
export const AgentProjectGrid = memo(function AgentProjectGrid({
  cards,
  repoIconsByRepoId,
  now,
  onOpenTerminal
}: AgentProjectGridProps): React.JSX.Element {
  const t = useTranslate()
  const tiles = useMemo(() => groupDashboardCardsByProject(cards), [cards])
  if (tiles.length === 0) {
    return (
      <p className="px-1 py-2 text-[11px] text-muted-foreground">
        {t('dashboardPopout.bucket.empty', 'None')}
      </p>
    )
  }
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(300px,1fr))] content-start gap-3">
      {tiles.map((tile) => (
        <AgentProjectTileView
          key={tile.key}
          tile={tile}
          repoIcon={repoIconsByRepoId?.[tile.repoId] ?? null}
          now={now}
          onOpenTerminal={onOpenTerminal}
        />
      ))}
    </div>
  )
})
