import React from 'react'
import { Info } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { ImportedWorktreesHeaderNotice } from '../../../../../../shared/sidebar-list/row-types'
import type { ImportedWorktreeCardActionState } from '../listing/imported-worktrees-card-actions'
import { ImportedWorktreesVisibilityDetails } from '../listing/ImportedWorktreesVisibilityLine'
import NoticeHostGlyph from './NoticeHostGlyph'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

export type ImportedWorktreesHeaderBadgeProps = {
  notices: readonly ImportedWorktreesHeaderNotice[]
  repoLabel: string
  actionStateByProjectId: ReadonlyMap<string, ImportedWorktreeCardActionState> | undefined
  onShow: ((projectId: string) => void) | undefined
  onKeepHidden: ((projectId: string) => void) | undefined
}

export function ImportedWorktreesHeaderBadge({
  notices,
  repoLabel,
  actionStateByProjectId,
  onShow,
  onKeepHidden
}: ImportedWorktreesHeaderBadgeProps): React.JSX.Element | null {
  const t = useTranslate()
  const hiddenCount = notices.reduce((total, notice) => total + notice.hiddenWorktrees.length, 0)
  if (hiddenCount === 0) {
    return null
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          className={cn(
            'inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full px-1 text-[10px] font-medium leading-none',
            'text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground'
          )}
          aria-label={t(
            'auto.components.sidebar.ImportedWorktreesHeaderBadge.ariaLabel',
            'Show {{count}} hidden discovered worktrees for {{repo}}',
            {
              count: hiddenCount,
              repo: repoLabel,
              defaultValue_one: 'Show {{count}} hidden discovered worktree for {{repo}}'
            }
          )}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => event.stopPropagation()}
        >
          <Info className="size-3" aria-hidden="true" />
          {hiddenCount}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-80"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="scrollbar-sleek grid max-h-80 gap-2 overflow-y-auto p-2">
          {notices.map((notice) => {
            const actionState = actionStateByProjectId?.get(notice.repo.id)
            return (
              <div key={notice.repo.id} className="grid min-w-0 gap-1">
                {notices.length > 1 || notice.hostContextLabel ? (
                  <div className="flex min-w-0 items-center gap-1.5 px-0.5">
                    <span className="min-w-0 truncate text-[11px] font-medium">
                      {notice.repo.displayName}
                    </span>
                    {notice.hostContextLabel ? (
                      <span className="inline-flex min-w-0 shrink items-center gap-1">
                        {notice.hostContextHostId ? (
                          <NoticeHostGlyph
                            hostId={notice.hostContextHostId}
                            hostLabel={notice.hostContextLabel}
                            keyboardFocusable
                          />
                        ) : null}
                        <span className="min-w-0 truncate text-[10px] leading-none text-muted-foreground">
                          {notice.hostContextLabel}
                        </span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <ImportedWorktreesVisibilityDetails
                  hiddenWorktrees={notice.hiddenWorktrees}
                  pending={actionState?.pending ?? false}
                  onShow={onShow ? () => onShow(notice.repo.id) : undefined}
                  onKeepHidden={
                    onKeepHidden && actionState?.forceVisible !== true
                      ? () => onKeepHidden(notice.repo.id)
                      : undefined
                  }
                />
                {actionState?.error ? (
                  <p className="px-0.5 text-[11px] leading-4 text-destructive" role="alert">
                    {actionState.error}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
