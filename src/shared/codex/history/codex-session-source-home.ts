/** Custom CODEX_HOME for Codex session-history discovery (defaults to ~/.codex).
 *  History-only: does not change which account/config/hooks Orca uses. */
export type CodexSessionSourceHome = {
  /** Absolute host path; empty/undefined falls back to ~/.codex. */
  host?: string
  /** Per-WSL-distro absolute Linux path; missing distro falls back to <wslHome>/.codex. */
  wsl?: Record<string, string>
}
