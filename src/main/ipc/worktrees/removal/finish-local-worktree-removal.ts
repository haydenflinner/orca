import type { Repo } from '../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import {
  preserveBranchHeadFallback,
  preservedBranchCleanupByScope,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { usesNativeWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import { CheckoutIdentityRefusal } from '../../../workspaces/removal/worktree-removal-leftover'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../listing/worktree-change-invalidators'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from '../paths/worktree-logic'
import { removeDeletedCheckoutMetadataAndTransientState } from './worktree-removal-ownership'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'

import type { AcceptedCheckoutGuard } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
export async function finishLocalWorktreeRemoval({
  context,
  args,
  repo,
  repoId,
  canonicalWorktreePath,
  removalHostId,
  removedPushTarget,
  localWorktreeGitOptions,
  deleteBranch,
  refreshedRegisteredWorktree,
  removalGate,
  checkoutDeleteSignal,
  cleanupPushTarget,
  guard
}: {
  context: WorktreeIpcContext
  args: RemoveWorktreeArgs
  repo: Repo
  repoId: string
  canonicalWorktreePath: string
  removalHostId: ExecutionHostId
  removedPushTarget: GitPushTarget | undefined
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  deleteBranch: boolean
  refreshedRegisteredWorktree: GitWorktreeInfo
  removalGate: { finish: (removed: boolean) => Promise<void> }
  checkoutDeleteSignal?: AbortSignal
  cleanupPushTarget: () => Promise<void>
  guard: AcceptedCheckoutGuard
}): Promise<RemoveWorktreeResult> {
  const purgeRemoved = async (withStageSpans: boolean): Promise<void> => {
    await cleanupPushTarget()
    context.runtime.clearOptimisticReconcileToken(args.worktreeId)
    const purgeMetadata = () =>
      removeDeletedCheckoutMetadataAndTransientState(
        context,
        args.worktreeId,
        removalHostId,
        args.snapshotPruneBatchId
      )
    const invalidateRoots = () => invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
    if (withStageSpans) {
      await withWorktreeRemoveStageSpan('metadata_purge', 'local', purgeMetadata)
      await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () =>
        invalidateRoots()
      )
    } else {
      await purgeMetadata()
      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({ worktreeId: args.worktreeId, hostId: removalHostId })
      )
      invalidateRoots()
    }
  }
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Reuse the authoritative listing instead of rescanning siblings during deletion.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...localWorktreeGitOptions,
        ...guard.markerOptions,
        checkoutDeleteSignal,
        beforeCheckoutDelete: guard.verify
      }
      removalResult = preserveBranchHeadFallback(
        await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
          removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, removeOptions)
        ),
        refreshedRegisteredWorktree.head
      )
    } catch (error) {
      if (
        error instanceof CheckoutIdentityRefusal ||
        usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions)
      ) {
        throw error
      }
      // Git deregisters even when its recursive filesystem deletion fails partway.
      const recoveredRemovalResult = await recoverPartialLocalWorktreeRemoval({
        error,
        force: args.force ?? false,
        canonicalWorktreePath,
        repoPath: repo.path,
        localWorktreeGitOptions,
        registeredWorktree: refreshedRegisteredWorktree,
        deleteBranch,
        closeWatcher: (worktreePath) => context.runtime.closeFileWatchersForRemoval(worktreePath),
        signal: checkoutDeleteSignal,
        ...guard.markerOptions
      })
      if (recoveredRemovalResult) {
        removalResult = recoveredRemovalResult
        removalCompleted = true
      } else if (isOrphanedWorktreeError(error)) {
        await guard.verify()
        console.warn(
          `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
        )
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalWorktreePath,
          localWorktreeGitOptions,
          (path) => context.runtime.closeFileWatchersForRemoval(path),
          checkoutDeleteSignal,
          guard.markerOptions
        )
        await pruneGitWorktrees({ cwd: repo.path, ...localWorktreeGitOptions }).catch(() => {})
        await purgeRemoved(false)
        removalCompleted = true
        return {}
      } else {
        throw new Error(
          formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
        )
      }
    }
    // Successful unlisting overtakes any scan begun before removal.
    runWorktreeChangeInvalidators(repoId)
    removalCompleted = true
  } finally {
    await removalGate.finish(removalCompleted)
  }
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    refreshedRegisteredWorktree.head,
    removedPushTarget
  )
  await purgeRemoved(true)
  return removalResult ?? {}
}
