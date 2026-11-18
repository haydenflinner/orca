import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { assertRegisteredLocalWorktreePreflight } from './registered-local-worktree-preflight'
import type { Repo } from '../../../../shared/repository/repo-types'
import { nativeWindowsMarkerMissing } from '../../../git/worktrees/removal/windows-worktree-removal'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../workspaces/removal/nested-worktree-removal-plan'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import { cleanupUnusedWorktreePushTargetRemote } from '../worktree-remote'
import { findExistingWorktreeSymlinkPaths } from '../../../git/worktrees/content-paths/worktree-symlink-detection'
import { removeWorktreeLinkedPaths } from '../linked-paths/worktree-symlinks'
import { formatWorktreeRemovalError } from '../paths/worktree-logic'
import { finishLocalWorktreeRemoval } from './finish-local-worktree-removal'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { stopPtysForDestructiveWorktreeRemoval } from './worktree-removal-ownership'
import * as backgroundRemoval from '../../../workspaces/removal/worktree-background-removal'
import { worktreeHostIdentity } from '../../../persistence/worktree-meta-host-identity'

export async function removeRegisteredLocalWorktree(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  canonicalWorktreePath: string,
  removalHostId: ExecutionHostId,
  removedPushTarget: GitPushTarget | undefined,
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions,
  hasLocalWorktreeGitOptions: boolean,
  deleteBranch: boolean
): Promise<RemoveWorktreeResult> {
  const refreshedWorktrees = hasLocalWorktreeGitOptions
    ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
    : await listGitWorktreesStrict(repo.path)
  const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    canonicalWorktreePath,
    refreshedWorktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!refreshedRegisteredWorktree) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
    )
  }
  if (args.expectedCheckout) {
    assertNestedWorktreeRemovalApproval([refreshedRegisteredWorktree], [args.expectedCheckout])
  }
  try {
    // Archive hooks can race external Git locks; recheck before destructive teardown.
    assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Repo shared-directory symlinks need the same ignore/unlink policy as user-configured shared paths.
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
  const markerMissing = await nativeWindowsMarkerMissing(
    canonicalWorktreePath,
    localWorktreeGitOptions
  )
  const toleratedUntrackedPaths = await assertRegisteredLocalWorktreePreflight(
    repo.path,
    canonicalWorktreePath,
    refreshedRegisteredWorktree,
    args.force ?? false,
    localWorktreeGitOptions,
    hasLocalWorktreeGitOptions,
    ignoredLinkedPaths,
    markerMissing
  )

  const background = backgroundRemoval.removesInBackground(
    canonicalWorktreePath,
    localWorktreeGitOptions
  )
  const prepare = async (): Promise<RemoveWorktreeResult> => {
    const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
      context.runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
    )
    let accepted = false
    try {
      // Fence watcher/spawn installs through linked-path cleanup, Git removal and recursive fallback; PTYs must release handles first.
      await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
        await stopPtysForDestructiveWorktreeRemoval(context.runtime, args.worktreeId, {
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        })
      })

      // Unlink every ?? symlink the dirty check tolerated: git worktree remove still refuses them.
      const unlinkPaths = [...new Set([...linkedPaths, ...toleratedUntrackedPaths])]
      if (!markerMissing && unlinkPaths.length > 0) {
        await removeWorktreeLinkedPaths(canonicalWorktreePath, unlinkPaths)
      }
      accepted = true
    } finally {
      if (!accepted) {
        await removalGate.finish(false)
      }
    }

    const cleanupPushTarget = () =>
      cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        args.worktreeId,
        removedPushTarget,
        context.store,
        localWorktreeGitOptions
      )
    // Read before the purge drops the row; listeners hear `removed` after it.
    const removedIdentity = worktreeHostIdentity(context.store, args.worktreeId, removalHostId)
    const finish = (checkoutDeleteSignal?: AbortSignal): Promise<RemoveWorktreeResult> =>
      finishLocalWorktreeRemoval({
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
      })
    if (!background) {
      const result = await finish()
      context.runtime.publishWorktreeRemovalChange(repoId)
      return result
    }
    // After acceptance, deletion must survive request cancellation; other views observe the host's removing marker.
    void backgroundRemoval.startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: args.worktreeId,
        repoId,
        repoPath: repo.path,
        worktree: refreshedRegisteredWorktree,
        deleteBranch,
        force: args.force ?? false
      },
      run: async (stopSignal) => {
        const result = await finish(stopSignal)
        context.options?.onWorktreeLifecycle?.({
          kind: 'removed',
          worktreeId: args.worktreeId,
          path: canonicalWorktreePath,
          ...removedIdentity
        })
        return result
      },
      publish: () => context.runtime.publishWorktreeRemovalChange(repoId),
      admissionFailed: () => removalGate.finish(false),
      cleanupPushTargetRemote: cleanupPushTarget
    })
    await backgroundRemoval.waitForWorktreeRemovalAcceptance(args.worktreeId)
    return { removing: true }
  }
  return background ? worktreeRemovalLifetime.withPreparation(prepare) : prepare()
}
