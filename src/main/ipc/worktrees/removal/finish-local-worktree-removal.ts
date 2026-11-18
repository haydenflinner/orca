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
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../listing/worktree-change-invalidators'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from '../paths/worktree-logic'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'

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
  cleanupPushTarget
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
}): Promise<RemoveWorktreeResult> {
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Reuse the authoritative listing instead of rescanning siblings during deletion.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...localWorktreeGitOptions,
        checkoutDeleteSignal
      }
      removalResult = preserveBranchHeadFallback(
        await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
          removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, removeOptions)
        ),
        refreshedRegisteredWorktree.head
      )
    } catch (error) {
      if (usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions)) {
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
        signal: checkoutDeleteSignal
      })
      if (recoveredRemovalResult) {
        removalResult = recoveredRemovalResult
        removalCompleted = true
      } else if (isOrphanedWorktreeError(error)) {
        console.warn(
          `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
        )
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalWorktreePath,
          localWorktreeGitOptions,
          (path) => context.runtime.closeFileWatchersForRemoval(path),
          checkoutDeleteSignal
        )
        // Failed removal may retain registration and branch locks; prune stale tracking.
        await pruneGitWorktrees({ cwd: repo.path, ...localWorktreeGitOptions }).catch(() => {})
        await cleanupPushTarget()
        context.runtime.clearOptimisticReconcileToken(args.worktreeId)
        removeWorktreeMetadataAndTransientState(
          context,
          args.worktreeId,
          removalHostId,
          args.snapshotPruneBatchId
        )
        const cleanupScopeKey = preservedBranchCleanupScopeKey({
          worktreeId: args.worktreeId,
          hostId: removalHostId
        })
        preservedBranchCleanupByScope.delete(cleanupScopeKey)
        invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
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
  await cleanupPushTarget()
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    refreshedRegisteredWorktree.head,
    removedPushTarget
  )
  context.runtime.clearOptimisticReconcileToken(args.worktreeId)
  await withWorktreeRemoveStageSpan('metadata_purge', 'local', async () => {
    removeWorktreeMetadataAndTransientState(
      context,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () => {
    invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
  })
  return removalResult ?? {}
}
