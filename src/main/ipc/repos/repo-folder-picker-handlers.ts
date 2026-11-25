import type { BrowserWindow, OpenDialogOptions } from 'electron'
import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { withoutWslMovedRepos } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { showSingleFlightOpenDialog } from '../dialogs/single-flight-open-dialog'

// Why: the OS's last-used folder is shared with attachment and save dialogs, so start beside the newest local project.
function newestLocalProjectParent(store: Pick<Store, 'getRepos'>): string | undefined {
  let newest: Repo | undefined
  for (const repo of withoutWslMovedRepos(store.getRepos())) {
    if (
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      (!newest || repo.addedAt > newest.addedAt)
    ) {
      newest = repo
    }
  }
  return newest ? dirname(newest.path) : undefined
}

export function registerRepoFolderPickerHandlers(
  mainWindow: BrowserWindow,
  store: Pick<Store, 'getRepos' | 'getUI' | 'updateUI'>
): void {
  const projectPickerOptions = (properties: OpenDialogOptions['properties']): OpenDialogOptions => {
    // A moved or deleted path is ignored by the OS dialog, which falls back to its default.
    const defaultPath = store.getUI().lastProjectPickerDirectory ?? newestLocalProjectParent(store)
    return { defaultPath, properties }
  }
  const rememberPickedDirectory = (filePaths: string[]): void => {
    const directory = filePaths[0] ? dirname(filePaths[0]) : undefined
    if (directory && directory !== store.getUI().lastProjectPickerDirectory) {
      store.updateUI({ lastProjectPickerDirectory: directory })
    }
  }

  ipcMain.handle('repos:pickFolder', async () => {
    const result = await showSingleFlightOpenDialog(
      projectPickerOptions(['openDirectory']),
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths[0]
  })

  ipcMain.handle('repos:pickFolders', async () => {
    const result = await showSingleFlightOpenDialog(
      projectPickerOptions(['openDirectory', 'multiSelections']),
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths
  })

  // Clone destinations need a generic picker because they may not contain a Git repo.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await showSingleFlightOpenDialog(
      // macOS creates typed partial paths when directory creation is enabled; defer creation to submit.
      projectPickerOptions(['openDirectory']),
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths[0]
  })
}
