import type { WorktreeRowView } from '../workspace-list/workspace-list-types'

// One step per level: mobile headers are plain rows, so they need the full indent desktop's labeled sections don't.
const TREE_INDENT = 18
const MAX_PROJECT_GROUP_DEPTH = 6

function cappedDepth(depth: number | undefined): number {
  return Math.min(Math.max(0, Math.floor(depth ?? 0)), MAX_PROJECT_GROUP_DEPTH)
}

export function projectGroupHeaderIndent(depth: number | undefined): number {
  return cappedDepth(depth) * TREE_INDENT
}

// groupDepth already carries the child step: section items emit one level under their header.
export function projectGroupRowIndent(view: Pick<WorktreeRowView, 'projectGroupDepth'>): number {
  return cappedDepth(view.projectGroupDepth) * TREE_INDENT
}
