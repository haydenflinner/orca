import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  absorbAcpCompactionFrame,
  acpCompactionEnd,
  type AcpCompaction,
  type AcpCompactionFrame
} from '../turns/acp-compaction-turn'
import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import { acpPromptFailureEnding } from '../turns/acp-prompt-failure'
import type { AcpTurnFailures } from './acp-turn-failures'
import { hookOutcomeRowBody } from '../../../shared/agent-session/journal/agent-session-hook-outcome'
import type { SessionUpdate } from '../generated/acp-protocol.generated'

export type AcpPromptTurn = {
  clientMessageId: string
  turn: string
  requestedAt: number
  opened: boolean
  durationMs?: number
  compaction?: AcpCompaction
}

export const acpPromptTurnId = (clientMessageId: string): string => `prompt:${clientMessageId}`

export class AcpPromptTurns {
  current?: AcpPromptTurn
  /** The in-flight side-chain prompt; it runs concurrently with `current`. */
  side?: AcpPromptTurn
  /** Retain the ended prompt so its reply can supply a late failure reason. */
  last?: AcpPromptTurn

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName?: string
  ) {}

  /** The prompt this turn belongs to, in either lane. */
  byTurn(turn: string | undefined): AcpPromptTurn | undefined {
    return this.current?.turn === turn
      ? this.current
      : this.side?.turn === turn
        ? this.side
        : undefined
  }

  /** True while a prompt in either lane owns this turn. */
  tracks(turn: string): boolean {
    return this.byTurn(turn) !== undefined
  }

  /** The prompt answering this send, in either lane. */
  byMessage(clientMessageId: string): AcpPromptTurn | undefined {
    return this.current?.clientMessageId === clientMessageId
      ? this.current
      : this.side?.clientMessageId === clientMessageId
        ? this.side
        : undefined
  }

  /** Devin puts no chain id on session/update frames, so a lone side prompt owns them;
   *  overlapping frames fold into the main prompt's turn. */
  promptTurn(activeTurn: string | undefined): string | undefined {
    if (this.side && !this.current && (activeTurn === undefined || activeTurn === this.side.turn)) {
      return this.side.turn
    }
    return this.current?.opened ? this.current.turn : activeTurn
  }

  /** Retire whichever lane's prompt this turn ended. */
  finishTurn(turn: string): void {
    if (this.current?.turn === turn) {
      this.finish()
    }
    if (this.side?.turn === turn) {
      this.finishSide()
    }
  }

  /** An unopened side turn folds its acceptance into an open turn; with none, it still opens
   *  and ends so the send's acceptance lands. */
  finishUnopenedSide(
    prompt: AcpPromptTurn,
    ending: AcpTurnEnding,
    joinTurn: string | undefined
  ): ProviderTimelineEvent[] {
    this.finishSide()
    const accepted = {
      type: 'input.accepted' as const,
      clientMessageId: prompt.clientMessageId,
      requestedAt: prompt.requestedAt
    }
    if (joinTurn !== undefined) {
      return [{ ...accepted, join: { thread: this.sessionId, turn: joinTurn } }]
    }
    return [
      { type: 'turn.open', turn: prompt.turn, at: ending.at },
      { ...accepted, join: { thread: this.sessionId, turn: prompt.turn } },
      ...acpTurnEndEvents(this.sessionId, prompt.turn, ending)
    ]
  }

  // Write failure reasons before ending the turn so their rows join it; onEnd retires ownership.
  endTurn(
    turn: string,
    ending: AcpTurnEnding,
    failures: AcpTurnFailures,
    onEnd: (turn: string) => void
  ): ProviderTimelineEvent[] {
    const events = this.endCompaction(turn, ending, failures) ?? [
      ...failures.ended(turn, ending),
      ...acpTurnEndEvents(this.sessionId, turn, ending)
    ]
    onEnd(turn)
    this.finishTurn(turn)
    return events
  }

  failure(
    clientMessageId: string,
    error: Error,
    at: number,
    failures: AcpTurnFailures
  ): AcpTurnEnding | ProviderTimelineEvent[] {
    const ending = acpPromptFailureEnding(this.dialect, error, at)
    if (this.byMessage(clientMessageId) === undefined) {
      // A late answer may supply a failure reason missing from the provider's end.
      return this.last?.clientMessageId === clientMessageId && failures.has(this.last.turn)
        ? failures.row(this.last.turn, ending)
        : []
    }
    return ending
  }

  /** Reuse the host's already-open command turn for compaction. */
  open(
    clientMessageId: string,
    at: number,
    compactionTurn?: string
  ): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.current) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    if (compactionTurn !== undefined) {
      this.current = {
        clientMessageId,
        turn: compactionTurn,
        requestedAt: at,
        opened: true,
        compaction: { reply: '' }
      }
      return { promptId: compactionTurn, events: [] }
    }
    const turn = acpPromptTurnId(clientMessageId)
    this.current = { clientMessageId, turn, requestedAt: at, opened: false }
    const injected = this.dialect.injectedPromptIdentity === true
    return { promptId: turn, events: injected ? [] : this.start(turn, at) }
  }

  /** The side chain serializes its own lane; its turn opens lazily on the first attributed frame. */
  openSide(clientMessageId: string, at: number): { promptId: string; events: never[] } {
    if (this.side) {
      throw new Error('ACP side prompt overlaps a side prompt')
    }
    const turn = acpPromptTurnId(clientMessageId)
    this.side = { clientMessageId, turn, requestedAt: at, opened: false }
    return { promptId: turn, events: [] }
  }

  compacting(turn: string | undefined): AcpPromptTurn | undefined {
    return turn !== undefined && this.current?.turn === turn && this.current.compaction
      ? this.current
      : undefined
  }

  /** True suppresses rendering the compaction's frame. */
  absorbCompaction(
    turn: string | undefined,
    extension: AcpCompactionFrame | undefined,
    update: SessionUpdate | undefined
  ): boolean {
    const prompt = this.compacting(turn)
    return prompt !== undefined && absorbAcpCompactionFrame(prompt, extension, update)
  }

  endCompaction(
    turn: string,
    ending: AcpTurnEnding,
    failures: Pick<AcpTurnFailures, 'write'>
  ): ProviderTimelineEvent[] | undefined {
    const prompt = this.compacting(turn)
    if (!prompt?.compaction) {
      return undefined
    }
    return acpCompactionEnd({
      ...prompt,
      ...ending,
      failures,
      compaction: prompt.compaction,
      thread: this.sessionId,
      dialect: this.dialect,
      agentName: this.agentName
    })
  }

  finish(): void {
    this.last = this.current
    this.current = undefined
  }

  finishSide(): void {
    this.last = this.side ?? this.last
    this.side = undefined
  }

  /** Only discard refusals received before the turn opens. */
  refuse(clientMessageId: string): boolean {
    if (this.current?.clientMessageId === clientMessageId && !this.current.opened) {
      this.current = undefined
      return true
    }
    if (this.side?.clientMessageId === clientMessageId && !this.side.opened) {
      this.side = undefined
      return true
    }
    return false
  }

  start(turn: string, at: number): ProviderTimelineEvent[] {
    const prompt =
      this.current?.turn === turn ? this.current : this.side?.turn === turn ? this.side : undefined
    if (prompt === undefined || prompt.opened) {
      return []
    }
    prompt.opened = true
    return [
      { type: 'turn.open', turn, at },
      {
        type: 'input.accepted',
        clientMessageId: prompt.clientMessageId,
        requestedAt: prompt.requestedAt,
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}

/** Hook denial completes the turn; a stable row key deduplicates repeated endings. */
export function acpTurnEndEvents(
  thread: string,
  turn: string,
  { stopReason, at, durationMs, providerTurnId, hookBlock }: AcpTurnEnding
): ProviderTimelineEvent[] {
  const end = acpTurnEnd(turn, hookBlock ? 'end_turn' : stopReason, at, durationMs, providerTurnId)
  const body = hookBlock && hookOutcomeRowBody('blocked', [hookBlock.reason ?? ''])
  return body
    ? [{ type: 'item.update', item: `hook-block:${turn}`, body, join: { thread, turn } }, end]
    : [end]
}

export function acpTurnEnd(
  turn: string,
  stopReason: string,
  at: number,
  durationMs?: number,
  providerTurnId?: string
): ProviderTimelineEvent {
  return {
    type: 'turn.end',
    turn,
    at,
    state: stopReason === 'cancelled' ? 'interrupted' : 'completed',
    ...(stopReason === 'end_turn'
      ? { outcome: 'success' as const }
      : stopReason === 'cancelled'
        ? { outcome: 'cancellation' as const }
        : ['refusal', 'max_tokens', 'max_turn_requests', 'error', 'rate_limit'].includes(stopReason)
          ? { outcome: 'failure' as const }
          : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(providerTurnId === undefined ? {} : { providerTurnId })
  }
}
