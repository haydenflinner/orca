import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { AcpSend, AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'

/** The side-chain lane: its in-flight prompt never steers or cancels the main one, and the
 *  single "side" chain id serializes sends — the second waits for the first to settle. */
export class AcpSideSends {
  private active: AcpSend | null = null
  private readonly queue: AcpSend[] = []

  constructor(
    private readonly deps: Pick<AcpStructuredTurnsDeps, 'connection' | 'lane'>,
    private readonly host: {
      /** True once teardown owns settlement; queued sends stop starting. */
      readonly ended: () => boolean
      /** A started send is no longer covered by an earlier Stop. */
      readonly started: () => void
      readonly answered: (send: AcpSend, result: PromptResponse) => void
      readonly errored: (send: AcpSend, error: unknown) => void
      /** No queued send followed: go idle when the main lane also is. */
      readonly idle: () => void
    }
  ) {}

  get running(): boolean {
    return this.active !== null
  }

  get queued(): boolean {
    return this.queue.length > 0
  }

  inFlight(send: AcpSend): boolean {
    return this.active === send
  }

  dispatch(send: AcpSend): void {
    if (this.active) {
      this.queue.push(send)
      return
    }
    this.start(send)
  }

  /** Start the next queued send once this one settled, or report the lane idle. */
  finish(send: AcpSend): void {
    if (this.active === send) {
      this.active = null
    }
    const next = this.host.ended() ? undefined : this.queue.shift()
    if (next) {
      this.start(next)
    } else {
      this.host.idle()
    }
  }

  /** Stop or teardown: held sends are settled by the caller, which receives them. */
  withdraw(): AcpSend[] {
    return this.queue.splice(0)
  }

  /** Teardown detaches the in-flight send so the caller settles it once. */
  takeInFlight(): AcpSend | null {
    const send = this.active
    this.active = null
    return send
  }

  private start(send: AcpSend): void {
    const { lane } = this.deps
    this.host.started()
    this.active = send
    const opened = lane.translator.openSidePrompt(send.clientMessageId, send.requestedAt)
    lane.apply(opened.events)
    const meta = {
      'cognition.ai/chain': 'side',
      ...(lane.translator.injectsPromptIdentity
        ? { promptId: opened.promptId, requestId: opened.promptId }
        : {})
    }
    this.deps.connection.prompt(send.prompt, meta, 'side').then(
      (result) => this.host.answered(send, result),
      (error: unknown) => this.host.errored(send, error)
    )
  }
}
