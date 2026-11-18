/** Waiters wake once the session reports idle; an aborted waiter releases without waking. */
export class AcpTurnIdlers {
  private readonly waiters = new Set<() => void>()

  whenIdle(isIdle: () => boolean, signal?: AbortSignal): Promise<void> {
    if (isIdle() || signal?.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  notify(): void {
    for (const wake of this.waiters) {
      wake()
    }
    this.waiters.clear()
  }
}
