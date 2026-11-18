import { join } from 'node:path'
import { resolveWorktreeHostPath } from '../../../../shared/git/metadata/git-metadata-path'
import { isWorktreePathMissing } from '../../../workspaces/removal/worktree-removal-safety'
import {
  SUBMODULE_DIRTY_REMOVAL_DETAIL,
  SUBMODULE_REMOVAL_REFUSAL
} from '../../../../shared/worktree/removal/removal'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitStreamStdout } from '../../command-runner/git-stream-stdout'
import { resolveGitDir } from '../../source-control/resolve-git-dir'
import { findExistingWorktreeSymlinkPaths } from '../content-paths/worktree-symlink-detection'
import type { WorktreeRemovalPreflightOptions } from '../worktree-operation-options'
import {
  WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS,
  gitExecOptions
} from '../worktree-operation-options'

/** Resolves to the ?? entries tolerated as symlinks; git worktree remove still refuses them, so callers unlink them first. */
export async function assertWorktreeCleanForRemoval(
  worktreePath: string,
  force = false,
  options: WorktreeRemovalPreflightOptions = {},
  adminDirectory?: string
): Promise<string[]> {
  if (force) {
    return []
  }

  const { ignoredUntrackedPaths = [], ...gitOptions } = options
  const bound = adminDirectory
    ? { env: { ...process.env, GIT_DIR: join(worktreePath, '.git'), GIT_WORK_TREE: worktreePath } }
    : {}
  const execution = {
    ...gitExecOptions(worktreePath, gitOptions),
    ...bound,
    timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
  }
  // Native Windows deletion bypasses Git, so Git's refusal must hold here, before any status read.
  if (
    adminDirectory &&
    (await containsSubmoduleCheckout(worktreePath, execution, adminDirectory))
  ) {
    throw new Error(SUBMODULE_DIRTY_REMOVAL_DETAIL)
  }
  // Windows refused above; elsewhere Git re-checks on delete, so a failed probe leaves the decision to Git.
  const hasSubmoduleCheckout = async (): Promise<boolean> =>
    !adminDirectory &&
    containsSubmoduleCheckout(
      resolveWorktreeHostPath(worktreePath, gitOptions) ?? worktreePath,
      execution,
      await resolveGitDir(worktreePath, gitOptions)
    ).catch(() => false)
  const { stdout } = await gitExecFileAsync(
    [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      // User ignore-submodules config must not hide edits from the dirty check.
      '--ignore-submodules=none'
    ],
    execution
  )
  const toleratedUntrackedPaths = normalizedToleratedUntrackedPaths(ignoredUntrackedPaths)
  const statusEntries = stdout.split('\0').filter(Boolean)
  const untrackedCandidates = statusEntries
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3).replace(/\\/g, '/'))
    .filter((path) => !toleratedUntrackedPaths.has(path))
  // Dir-only ignore rules cannot match a symlink, so shared links like node_modules report ??;
  // removal unlinks them without touching the target, which is not lost worktree content.
  const untrackedSymlinkPaths =
    untrackedCandidates.length === 0
      ? []
      : await findExistingWorktreeSymlinkPaths(worktreePath, untrackedCandidates, {
          wslDistro: gitOptions.wslDistro
        })
  for (const linkPath of untrackedSymlinkPaths) {
    toleratedUntrackedPaths.add(linkPath)
  }
  // Use the same entries for the verdict and the error message.
  const blockingEntries = statusEntries.filter(
    (entry) =>
      !(entry.startsWith('?? ') && toleratedUntrackedPaths.has(entry.slice(3).replace(/\\/g, '/')))
  )
  if (blockingEntries.length === 0) {
    // Git refuses these even when clean; refuse before teardown instead of after terminals stop.
    if (await hasSubmoduleCheckout()) {
      throw new Error(SUBMODULE_REMOVAL_REFUSAL)
    }
    return untrackedSymlinkPaths
  }

  const blockingStatus = blockingEntries.join('\n')
  if (await hasSubmoduleCheckout()) {
    // Force Delete also destroys submodule-only commits; put that detail before stdout for the formatter.
    throw new Error(`${SUBMODULE_DIRTY_REMOVAL_DETAIL}\n${blockingStatus.trim()}`)
  }

  // Render filtered entries without raw NULs or tolerated shared links.
  throw Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
    stdout: blockingStatus
  })
}

/** Git's own refusal test: submodule repositories under the admin directory, or a gitlink checked out with its `.git`. */
async function containsSubmoduleCheckout(
  hostWorktreePath: string,
  execution: Parameters<typeof gitExecFileAsync>[1],
  adminDirectory: string | null
): Promise<boolean> {
  if (adminDirectory && !(await isWorktreePathMissing(join(adminDirectory, 'modules')))) {
    return true
  }
  for (const gitlink of await readGitlinkPaths(execution)) {
    if (!(await isWorktreePathMissing(join(hostWorktreePath, gitlink, '.git')))) {
      return true
    }
  }
  return false
}

/** Stream the index keeping only gitlinks; a large repository's full listing exceeds the buffered cap. */
async function readGitlinkPaths(
  execution: Parameters<typeof gitExecFileAsync>[1]
): Promise<string[]> {
  const { cwd, env, wslDistro, signal, admissionTier, timeout } = execution
  const gitlinks: string[] = []
  const keepGitlink = (entry: string): void => {
    if (entry.startsWith('160000 ')) {
      gitlinks.push(entry.slice(entry.indexOf('\t') + 1))
    }
  }
  let carry = ''
  await gitStreamStdout(['ls-files', '--stage', '-z'], {
    cwd,
    env,
    wslDistro,
    signal,
    admissionTier,
    timeoutMs: timeout,
    // Only gitlink paths are retained, so index size is not a memory risk.
    maxBuffer: Number.MAX_SAFE_INTEGER,
    maxStderrBuffer: 64 * 1024,
    onStdout: (chunk) => {
      const entries = (carry + chunk).split('\0')
      carry = entries.pop() ?? ''
      entries.forEach(keepGitlink)
    }
  })
  keepGitlink(carry)
  return gitlinks
}

function normalizedToleratedUntrackedPaths(paths: readonly string[]): Set<string> {
  return new Set(
    paths
      .map((entry) =>
        entry
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/')
      )
      .filter((entry) => entry && !entry.split('/').includes('..'))
  )
}
