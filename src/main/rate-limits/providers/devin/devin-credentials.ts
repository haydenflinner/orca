import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  defaultDevinDataHome,
  devinDataHomeVariable
} from '../../../devin/devin-acp-account-binding'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'

export type DevinCredentials = {
  apiKey: string
  apiServerUrl: string
}

export type DevinCredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: DevinCredentials }

const DEFAULT_API_SERVER_URL = 'https://server.codeium.com'
const DEVIN_API_KEY_ENV = 'WINDSURF_API_KEY'

// Devin ignores DEVIN_HOME: its credentials.toml follows the data folder like the ACP launch binding.
function devinDataHomeCandidates(): string[] {
  const variable = devinDataHomeVariable(process.platform)
  const homes: string[] = []
  if (process.platform !== 'win32') {
    try {
      // Managed Devin accounts sign in to a per-account data home; their quota is the one Orca sessions spend.
      const managed = getManagedDataAccountService().launchEnvironment('devin').XDG_DATA_HOME
      if (managed) {
        homes.push(managed)
      }
    } catch {
      // The app environment is not up during early construction probes; the next fetch cycle retries.
    }
  }
  homes.push(process.env[variable] ?? defaultDevinDataHome(process.platform, homedir()))
  return homes
}

export function readDevinCredentials(): DevinCredentialsReadResult {
  const envKey = process.env[DEVIN_API_KEY_ENV]?.trim()
  let sawError = false
  for (const home of devinDataHomeCandidates()) {
    const path = join(home, 'devin', 'credentials.toml')
    if (!existsSync(path)) {
      continue
    }
    try {
      const parsed: unknown = parseToml(readFileSync(path, 'utf-8'))
      if (typeof parsed !== 'object' || parsed === null) {
        sawError = true
        continue
      }
      const record = parsed as Record<string, unknown>
      const fileKey = typeof record.windsurf_api_key === 'string' ? record.windsurf_api_key : ''
      const apiKey = envKey || fileKey
      if (!apiKey) {
        continue
      }
      const server =
        typeof record.api_server_url === 'string' && record.api_server_url.trim()
          ? record.api_server_url.trim().replace(/\/$/, '')
          : DEFAULT_API_SERVER_URL
      return { status: 'ok', credentials: { apiKey, apiServerUrl: server } }
    } catch {
      sawError = true
    }
  }
  if (envKey) {
    return { status: 'ok', credentials: { apiKey: envKey, apiServerUrl: DEFAULT_API_SERVER_URL } }
  }
  if (sawError) {
    // Keep filesystem paths/usernames out of renderer and mobile account state.
    return { status: 'error', error: 'Unable to read Devin credentials file' }
  }
  return { status: 'missing' }
}
