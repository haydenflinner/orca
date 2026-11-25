import type { BoundedMap } from '../../../shared/collections/bounded-map'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpTurnEnding } from '../acp-dialects/acp-dialect'
import type { AcpAgentTurns } from './acp-agent-turns'
import { acpTurnEndEvents } from './acp-prompt-turns'
import type { AcpPromptTurns } from './acp-prompt-turns'
import type { AcpTimelineOwnership } from './acp-timeline-ownership'
import type { AcpTurnFailures } from './acp-turn-failures'

export type AcpTurnLifecycleDeps = {
  sessionId: string
  prompts: AcpPromptTurns
  agentTurns: AcpAgentTurns
  failures: AcpTurnFailures
  ownership: AcpTimelineOwnership
  started: BoundedMap<string, true>
}

/** Turn open/end bookkeeping the translator shares across its prompt and notification paths. */
export class AcpTurnLifecycle {
  activeTurn?: string

  constructor(private readonly deps: AcpTurnLifecycleDeps) {}

  start(
    turn: string,
    at: number,
    operation = this.deps.ownership.operation()
  ): ProviderTimelineEvent[] {
    const { prompts, started } = this.deps
    if (operation.settled(turn) || (!prompts.tracks(turn) && started.has(turn))) {
      return []
    }
    // A side turn streams beside the main turn; anything else still displaces the active one.
    if (this.activeTurn && this.activeTurn !== turn && turn !== prompts.side?.turn) {
      this.end(this.activeTurn)
    }
    operation.open(turn)
    // Late frames must not reopen or retarget this prompt.
    const events = prompts.tracks(turn)
      ? prompts.start(turn, at)
      : [{ type: 'turn.open' as const, turn, at }]
    started.set(turn, true)
    this.activeTurn = turn
    return events
  }

  end(turn: string): void {
    this.deps.ownership.end(turn)
    if (this.activeTurn === turn) {
      this.activeTurn = undefined
    }
  }

  // Write failure reasons before ending the turn so their rows join it.
  endTurn(turn: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    const { prompts, agentTurns, failures, sessionId } = this.deps
    const events = prompts.endCompaction(turn, ending, failures) ?? [
      ...agentTurns.background(turn, ending, sessionId),
      ...failures.ended(turn, ending),
      ...acpTurnEndEvents(sessionId, turn, failures.ending(turn, ending))
    ]
    this.end(turn)
    if (prompts.current?.turn === turn) {
      prompts.finish()
    }
    return events
  }

  finishPrompt(clientMessageId: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    const { prompts, started, failures } = this.deps
    const prompt = prompts.byMessage(clientMessageId)
    if (prompt === undefined) {
      return []
    }
    if (prompt === prompts.side && !prompt.opened) {
      // Late frames must not reopen the never-opened side turn.
      started.set(prompt.turn, true)
      const join = prompts.current?.opened ? prompts.current.turn : this.activeTurn
      return prompts.finishUnopenedSide(prompt, ending, join)
    }
    return [
      ...this.start(prompt.turn, ending.at),
      ...prompts.endTurn(
        prompt.turn,
        { ...ending, durationMs: prompt.durationMs },
        failures,
        (turn) => this.end(turn)
      )
    ]
  }
}
