import type { RateLimitWindow } from '../rate-limits/rate-limit-types'

/** Percent of the window's period already elapsed (0–100), or null when the period bounds are unknown. */
export function getUsageWindowElapsedPercent(window: RateLimitWindow, now: number): number | null {
  if (window.resetsAt === null || window.windowMinutes <= 0) {
    return null
  }
  const durationMs = window.windowMinutes * 60_000
  const remainingMs = window.resetsAt - now
  return Math.min(100, Math.max(0, (1 - remainingMs / durationMs) * 100))
}
