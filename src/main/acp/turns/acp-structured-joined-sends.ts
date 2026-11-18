import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { AcpSend, AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'

/** Mid-turn steers share the running prompt's turn; several may be in flight together. */
export class AcpJoinedSends {
  private readonly sends = new Set<AcpSend>()

  constructor(
    private readonly deps: Pick<AcpStructuredTurnsDeps, 'connection' | 'lane'>,
    private readonly host: {
      readonly answered: (send: AcpSend, result: PromptResponse) => void
      readonly errored: (send: AcpSend, error: unknown) => void
    }
  ) {}

  inFlight(send: AcpSend): boolean {
    return this.sends.has(send)
  }

  find(clientMessageId: string): AcpSend | undefined {
    return [...this.sends].find((send) => send.clientMessageId === clientMessageId)
  }

  /** Shares the open turn and resolves when it ends; false when no turn admits a join. */
  join(send: AcpSend): boolean {
    const { lane } = this.deps
    let joined: { promptId: string; events: Parameters<typeof lane.apply>[0] }
    try {
      joined = lane.translator.joinPrompt(send.clientMessageId, send.requestedAt)
    } catch {
      return false
    }
    this.sends.add(send)
    lane.apply(joined.events)
    const meta = lane.translator.injectsPromptIdentity
      ? { promptId: joined.promptId, requestId: joined.promptId }
      : undefined
    this.deps.connection.prompt(send.prompt, meta, 'steer').then(
      (result) => this.host.answered(send, result),
      (error: unknown) => this.host.errored(send, error)
    )
    return true
  }

  finish(send: AcpSend): boolean {
    return this.sends.delete(send)
  }

  /** Teardown detaches in-flight sends so the caller settles them once. */
  takeAll(): AcpSend[] {
    const sends = [...this.sends]
    this.sends.clear()
    return sends
  }
}
