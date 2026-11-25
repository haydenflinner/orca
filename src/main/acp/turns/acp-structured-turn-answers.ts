import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AcpSend, AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'
import { AcpAgentError, AcpConnectionClosedError } from '../transport/acp-errors'
import { acpPromptRejection } from './acp-prompt-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { PromptResponse } from '../generated/acp-protocol.generated'

/** What a turn lane needs from its owner to settle an answered or failed prompt. */
export type AcpTurnAnswerHost = Pick<
  AcpStructuredTurnsDeps,
  'lane' | 'now' | 'modelRefusal' | 'sessionLost'
> & {
  /** Only an in-flight send settles; stale answers are dropped. */
  inFlight(send: AcpSend): boolean
  accept(clientMessageId: string): void
  reject(clientMessageId: string, fact: SubmissionRejectionFact): void
  finish(send: AcpSend): void
  /** Stops and preparing steers mark the answered turn cancelled. */
  cancelled(send: AcpSend): boolean
  /** A lost session refuses later sends. */
  markEnded(): void
}

export function acpTurnAnswered(
  host: AcpTurnAnswerHost,
  send: AcpSend,
  result: PromptResponse
): void {
  if (!host.inFlight(send)) {
    return
  }
  const { lane } = host
  const { clientMessageId } = send
  lane.apply(
    lane.translator.promptResult(clientMessageId, result, host.now(), host.cancelled(send))
  )
  host.accept(send.clientMessageId)
  acpTurnFinishRetireIfLost(host, send, lane.translator.failures.takeSessionLoss())
}

export function acpTurnErrored(host: AcpTurnAnswerHost, send: AcpSend, error: unknown): void {
  if (!host.inFlight(send) || error instanceof AcpConnectionClosedError) {
    // Connection teardown owns unknown-send settlement.
    return
  }
  if (!(error instanceof AcpAgentError)) {
    const { lane } = host
    // Unreadable replies fail the turn but allow the next send.
    lane.apply(
      lane.translator.promptFailed(
        send.clientMessageId,
        error instanceof Error ? error : new Error(String(error)),
        host.now()
      )
    )
    host.accept(send.clientMessageId)
    host.finish(send)
    return
  }
  acpAgentTurnFailed(host, send, error)
}

export function acpAgentTurnFailed(
  host: AcpTurnAnswerHost,
  send: AcpSend,
  error: AcpAgentError
): void {
  const { lane } = host
  const refusal = lane.translator.promptRefused(send.clientMessageId, error)
  // Also retires the proof of a model the agent turned out not to have.
  const noModel = host.modelRefusal?.(error)
  if (refusal !== null) {
    const signedOut = lane.translator.authenticationRequired(error)
    host.reject(send.clientMessageId, acpPromptRejection(refusal, signedOut, noModel))
  } else {
    lane.apply(lane.translator.promptFailed(send.clientMessageId, error, host.now()))
  }
  const lost = lane.translator.sessionLost(error)
  acpTurnFinishRetireIfLost(host, send, lost ? error : undefined)
}

export function acpTurnFinishRetireIfLost(
  host: AcpTurnAnswerHost,
  send: AcpSend,
  sessionLoss: Error | undefined
): void {
  // Held steers must not reach the dead session.
  if (sessionLoss !== undefined) {
    host.markEnded()
  }
  host.finish(send)
  if (sessionLoss) {
    host.sessionLost(sessionLoss)
  }
}

export function acpCancelForSteer(args: {
  deps: Pick<AcpStructuredTurnsDeps, 'withdrawRequests' | 'connection'>
  send: AcpSend | null
  steerCancelled: AcpSend | null
  setSteerCancelled: (send: AcpSend | null) => void
}): void {
  const { deps, send, steerCancelled, setSteerCancelled } = args
  if (!send) {
    return
  }
  deps.withdrawRequests()
  if (steerCancelled === send) {
    return
  }
  setSteerCancelled(send)
  deps.connection.cancel().catch(() => {
    // A failed write lets the next steer retry.
    setSteerCancelled(null)
  })
}

export function acpTurnRejected(
  host: Pick<AcpStructuredTurnsDeps, 'agentName' | 'settle'>,
  unsettled: Set<string>,
  clientMessageId: string,
  fact: SubmissionRejectionFact
): void {
  if (unsettled.delete(clientMessageId)) {
    const words = agentSessionFailureWords(fact, {
      surface: 'rejection',
      agentName: host.agentName
    })
    host.settle({ clientMessageId, state: 'rejected', ...words })
  }
}
