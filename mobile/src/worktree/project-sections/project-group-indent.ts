import type { Worktree, WorktreeRowView } from '../workspace-list/workspace-list-types'

// One step per level: mobile headers are plain rows, so they need the full indent desktop's labeled sections don't.
const TREE_INDENT = 18
const MAX_PROJECT_GROUP_DEPTH = 6

function cappedDepth(depth: number | undefined): number {
  return Math.min(Math.max(0, Math.floor(depth ?? 0)), MAX_PROJECT_GROUP_DEPTH)
}

export function projectGroupHeaderIndent(depth: number | undefined): number {
  return cappedDepth(depth) * TREE_INDENT
}

// Rows take one extra step so a child's text lands right of the group's title; folder workspaces align to the label as the group's own row.
export function projectGroupRowIndent(
  row: Pick<Worktree, 'workspaceKind'>,
  view: Pick<WorktreeRowView, 'projectGroupDepth' | 'inFolderScanGroup'>
): number {
  const depth = cappedDepth(view.projectGroupDepth)
  if (depth === 0) {
    return 0
  }
  const isFolderWorkspace = view.inFolderScanGroup && row.workspaceKind === 'folder-workspace'
  return (depth + (isFolderWorkspace ? 0 : 1)) * TREE_INDENT
}
