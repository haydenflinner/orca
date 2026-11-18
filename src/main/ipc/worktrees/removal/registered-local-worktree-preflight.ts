import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  authorizeWindowsCheckout,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { assertWorktreeCleanForRemoval } from '../../../git/worktrees/removal/worktree-removal-preflight'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError
} from '../paths/worktree-logic'

/** Resolves to the untracked ?? symlinks the dirty check tolerated; the caller unlinks them before git worktree remove. */
export async function assertRegisteredLocalWorktreePreflight(
  repoPath: string,
  canonicalWorktreePath: string,
  worktree: GitWorktreeInfo,
  force: boolean,
  localOptions: LocalProjectWorktreeGitOptions,
  hasLocalOptions: boolean,
  ignoredLinkedPaths: readonly string[],
  markerMissing: boolean
): Promise<string[]> {
  try {
    if (usesNativeWindowsRemoval(canonicalWorktreePath, localOptions)) {
      // Native Windows deletes recursively without Git, so tolerated links need no pre-removal.
      await authorizeWindowsCheckout(
        repoPath,
        canonicalWorktreePath,
        force,
        {
          ...localOptions,
          knownRemovedWorktree: worktree,
          ignoredUntrackedPaths: ignoredLinkedPaths
        },
        true
      )
    } else if (!markerMissing) {
      return (
        (await assertWorktreeCleanForRemoval(canonicalWorktreePath, force, {
          ...(hasLocalOptions ? localOptions : {}),
          ignoredUntrackedPaths: ignoredLinkedPaths
        })) ?? []
      )
    }
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
    }
    // Git may discover orphaning after preflight; recursive fallback still requires strict PTY teardown.
  }
  return []
}
