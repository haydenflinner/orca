import React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/class-names'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import {
  isSingleHostProjectHeader,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import { ProjectHeaderActions } from './ProjectHeaderActions'
import { isFolderWorkspaceCreateDisabled } from './FolderPathStatusIndicator'
import {
  ProjectGroupCreateWorkspaceButton,
  ProjectGroupHeaderMenu
} from './project-group-header-actions'
import {
  RepoHeaderCreateWorkspaceButton,
  RepoHeaderProjectActionsMenu
} from './repo-header-project-actions'
import { handleRepoHeaderCollapseAffordancePointerDown } from './header-event-guards'
import type { SectionHeaderRowContext } from './section-header-row-context'

export type SectionHeaderActionsProps = {
  ctx: SectionHeaderRowContext
  row: GroupHeaderRow
  label: string
  isHeaderCollapsed: boolean
  showHeaderCollapseAffordance: boolean
  isProjectGroupHeader: boolean
  projectGroupIdForHeader: string | undefined
  projectGroupHostIdForHeader: ExecutionHostId | undefined
  folderBackedProjectGroup: ProjectGroup | null
  projectGroupPathStatus: FolderWorkspacePathStatus | null
  toggleHeader: (event: React.MouseEvent | React.KeyboardEvent) => void
}

export function SectionHeaderActions({
  ctx,
  row,
  label,
  isHeaderCollapsed,
  showHeaderCollapseAffordance,
  isProjectGroupHeader,
  projectGroupIdForHeader,
  projectGroupHostIdForHeader,
  folderBackedProjectGroup,
  projectGroupPathStatus,
  toggleHeader
}: SectionHeaderActionsProps): React.JSX.Element {
  return (
    <ProjectHeaderActions>
      {showHeaderCollapseAffordance ? (
        <div
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          data-repo-header-collapse-affordance=""
          aria-hidden
          onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            toggleHeader(event)
          }}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', isHeaderCollapsed && '-rotate-90')}
          />
        </div>
      ) : null}

      {isProjectGroupHeader && !row.repo && projectGroupIdForHeader ? (
        <ProjectGroupHeaderMenu
          groupId={projectGroupIdForHeader}
          hostId={projectGroupHostIdForHeader}
          label={label}
          projectGroup={folderBackedProjectGroup}
          onRefreshProjectGroup={ctx.onRefreshProjectGroup}
          onRename={ctx.onRenameProjectGroup}
          onDelete={ctx.onDeleteProjectGroup}
        />
      ) : null}

      {folderBackedProjectGroup ? (
        <ProjectGroupCreateWorkspaceButton
          projectGroup={folderBackedProjectGroup}
          label={label}
          pathStatus={projectGroupPathStatus}
          disabled={isFolderWorkspaceCreateDisabled(projectGroupPathStatus)}
          onCreate={ctx.onCreateFolderWorkspace}
        />
      ) : null}

      {row.repo && ctx.groupBy === 'repo' ? (
        <RepoHeaderProjectActionsMenu
          repo={row.repo}
          hostRepos={row.hostRepos}
          label={label}
          projectGroups={ctx.projectGroups}
          actions={ctx.projectActions}
        />
      ) : null}

      {row.repo && ctx.groupBy === 'repo' ? (
        <RepoHeaderCreateWorkspaceButton
          key={`${row.repo.executionHostId ?? 'local'}:${row.repo.connectionId ?? ''}`}
          repo={row.repo}
          label={label}
          pinHost={isSingleHostProjectHeader(row)}
          onCreateForRepo={ctx.projectActions.onCreateForRepo}
        />
      ) : null}
    </ProjectHeaderActions>
  )
}
