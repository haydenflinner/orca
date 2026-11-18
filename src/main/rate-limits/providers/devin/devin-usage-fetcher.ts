import { getMainHttpClient } from '../../../network/http-client'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import {
  readDevinCredentials,
  type DevinCredentials,
  type DevinCredentialsReadResult
} from './devin-credentials'

// Devin CLI reports quota through the same Codeium Connect service it authenticates against.
const GET_USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus'
const API_TIMEOUT_MS = 10_000
const DAILY_WINDOW_MINUTES = 1_440
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

type DevinPlanStatus = {
  planInfo?: { planName?: string; billingStrategy?: string }
  planEnd?: string
  dailyQuotaRemainingPercent?: number
  weeklyQuotaRemainingPercent?: number
  dailyQuotaResetAtUnix?: string
  weeklyQuotaResetAtUnix?: string
  hideWeeklyQuota?: boolean
  acuConsumed?: number
  acuLimit?: number
}

type DevinUserStatusResponse = {
  userStatus?: {
    email?: string
    name?: string
    planStatus?: DevinPlanStatus
  }
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'devin',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function unixSecondsToMs(value: string | undefined): number | null {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

function resetDescription(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null
  }
  const date = new Date(resetsAt)
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function quotaWindow(
  remainingPercent: number | undefined,
  resetAtUnix: string | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) {
    return null
  }
  const resetsAt = unixSecondsToMs(resetAtUnix)
  return {
    usedPercent: Math.min(100, Math.max(0, 100 - remainingPercent)),
    windowMinutes,
    resetsAt,
    resetDescription: resetDescription(resetsAt)
  }
}

// ACU-billed orgs report credit consumption against the plan period instead of daily/weekly quotas.
function acuWindow(planStatus: DevinPlanStatus): RateLimitWindow | null {
  const limit = planStatus.acuLimit
  const consumed = planStatus.acuConsumed
  if (
    typeof limit !== 'number' ||
    typeof consumed !== 'number' ||
    !Number.isFinite(limit) ||
    !Number.isFinite(consumed) ||
    limit <= 0
  ) {
    return null
  }
  const resetsAt = planStatus.planEnd ? Date.parse(planStatus.planEnd) : Number.NaN
  const resetsAtMs = Number.isFinite(resetsAt) ? resetsAt : null
  return {
    usedPercent: Math.min(100, Math.max(0, (consumed / limit) * 100)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: resetsAtMs,
    resetDescription: resetDescription(resetsAtMs)
  }
}

// The seat-management RPC requires the CLI's full metadata block; a bare apiKey is rejected.
function devinMetadata(credentials: DevinCredentials): Record<string, string> {
  return {
    apiKey: credentials.apiKey,
    ideName: 'devin',
    ideVersion: '1.0.0',
    extensionName: 'devin',
    extensionVersion: '1.0.0',
    requestId: String(Date.now()),
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  }
}

export async function fetchDevinRateLimits(
  options: { signal?: AbortSignal; credentialReadResult?: DevinCredentialsReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.credentialReadResult ?? readDevinCredentials()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Devin — run devin auth login', {
      failureKind: 'missing-credentials',
      source: 'cli'
    })
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error, { failureKind: 'missing-credentials', source: 'cli' })
  }
  const { credentials } = readResult
  try {
    const res = await getMainHttpClient().fetch(
      `${credentials.apiServerUrl}${GET_USER_STATUS_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          Accept: 'application/json'
        },
        body: JSON.stringify({ metadata: devinMetadata(credentials) }),
        signal: abortSignalWithTimeout(options.signal, API_TIMEOUT_MS)
      }
    )
    if (res.status === 401 || res.status === 403) {
      return result('error', `Devin usage request unauthorized (HTTP ${res.status})`, {
        failureKind: 'stale-token',
        source: 'cli'
      })
    }
    if (!res.ok) {
      return result('error', `Devin usage request failed (HTTP ${res.status})`, {
        failureKind: 'server',
        source: 'cli'
      })
    }
    const data: unknown = await res.json()
    const planStatus =
      typeof data === 'object' && data !== null
        ? (data as DevinUserStatusResponse).userStatus?.planStatus
        : undefined
    if (!planStatus) {
      return result('unavailable', 'Devin account status did not include plan usage', {
        failureKind: 'usage-unavailable',
        source: 'cli'
      })
    }
    const session = quotaWindow(
      planStatus.dailyQuotaRemainingPercent,
      planStatus.dailyQuotaResetAtUnix,
      DAILY_WINDOW_MINUTES
    )
    const weekly = planStatus.hideWeeklyQuota
      ? null
      : quotaWindow(
          planStatus.weeklyQuotaRemainingPercent,
          planStatus.weeklyQuotaResetAtUnix,
          WEEKLY_WINDOW_MINUTES
        )
    const monthly = session || weekly ? null : acuWindow(planStatus)
    if (!session && !weekly && !monthly) {
      return result('unavailable', 'Devin did not report quota usage for this account', {
        failureKind: 'usage-unavailable',
        source: 'cli'
      })
    }
    const userStatus = (data as DevinUserStatusResponse).userStatus
    return {
      provider: 'devin',
      session,
      weekly,
      ...(monthly ? { monthly } : {}),
      planType: planStatus.planInfo?.planName ?? null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        source: 'cli',
        authProvenance: userStatus?.email?.trim() || userStatus?.name?.trim() || 'Devin account'
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Devin usage request failed'
    return result('error', message, {
      failureKind: classifyThrownUsageRequestError(err),
      source: 'cli'
    })
  }
}
