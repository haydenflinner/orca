import { delayUnlessAborted } from '../../../shared/concurrency/abort-aware-delay'
import { AcpAgentError } from '../transport/acp-errors'
import type { PromptResponse } from '../generated/acp-protocol.generated'

function sessionBusy(error: unknown): boolean {
  return (
    error instanceof AcpAgentError &&
    error.code === -32003 &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'reason' in error.data &&
    error.data.reason === 'session_busy'
  )
}

/** Retain one logical prompt unless `concurrent` admits several; only an explicit busy refusal permits another wire attempt. */
export class AcpPromptRequest {
  private readonly active = new Set<AbortController>()
  private closedWith?: Error
  private waiting = false

  constructor(
    private readonly retryBusy: boolean,
    private readonly concurrent = false
  ) {}

  get waitingToRetry(): boolean {
    return this.waiting
  }

  async run(request: () => Promise<PromptResponse>): Promise<PromptResponse> {
    if (!this.concurrent && this.active.size > 0) {
      throw new Error('ACP prompt already in progress')
    }
    const active = new AbortController()
    this.active.add(active)
    try {
      let delayMs = 1_000
      for (;;) {
        if (this.closedWith) {
          throw this.closedWith
        }
        if (active.signal.aborted) {
          return { stopReason: 'cancelled' }
        }
        try {
          this.waiting = false
          return await request()
        } catch (error) {
          if (!this.retryBusy || !sessionBusy(error)) {
            throw error
          }
        }
        this.waiting = true
        await delayUnlessAborted(delayMs, active.signal)
        delayMs = Math.min(delayMs * 2, 5_000)
      }
    } finally {
      this.waiting = false
      this.active.delete(active)
    }
  }

  cancel(): void {
    for (const active of this.active) {
      active.abort()
    }
  }

  close(error: Error): void {
    this.closedWith = error
    this.cancel()
  }
}
