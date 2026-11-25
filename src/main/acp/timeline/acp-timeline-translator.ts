import { BoundedMap } from '../../../shared/collections/bounded-map'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  acpNotificationEnvelopeSchema,
  readAcpSessionEvent,
  type AcpSessionEvent
} from '../protocol/acp-session-events'
import { AcpContextTimeline } from './acp-context-usage'
import { AcpThreadGoalTimeline } from './acp-thread-goal-timeline'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import { AcpAgentTurns } from './acp-agent-turns'
import { GENERIC_ACP_DIALECT, type AcpDialect } from '../acp-dialects/acp-dialect'
import type { AcpAgentError } from '../transport/acp-errors'
import { AcpPromptTurns } from './acp-prompt-turns'
import { AcpTurnLifecycle } from './acp-turn-lifecycle'

import { translateAcpRequest } from '../requests/acp-timeline-requests'
import { AcpUrlElicitations } from '../requests/acp-url-elicitation'
import { ACP_SUBSTANTIVE_UPDATES, acpSessionUpdate } from './acp-session-update'
import { AcpSubagents } from './acp-subagents'
import { AcpChildSessions } from './acp-child-sessions'
import { AcpTimelineOwnership } from './acp-timeline-ownership'
import { AcpTurnFailures } from './acp-turn-failures'
import { acpAuthenticationRequired, acpPromptErrorDetail } from '../turns/acp-prompt-failure'
import type { AcpTextDrop } from './acp-turn-messages'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'

export type AcpTimelineTranslatorOptions = {
  sessionId: string
  dialect?: AcpDialect
  agentName?: string
  onTextDropped?: (drop: AcpTextDrop) => void
}

type OpenedPrompt = { promptId: string; events: ProviderTimelineEvent[] }

/** Consume frames once; callers retry returned events. State lasts only for this provider child. */
export class AcpTimelineTranslator {
  readonly providerSessionId: string
  readonly injectsPromptIdentity: boolean
  private readonly dialect: AcpDialect
  private readonly prompts: AcpPromptTurns
  private readonly backgroundTasks: AcpBackgroundTaskTimeline
  /** Drained by the lane in journal order. */
  readonly subagents = new AcpSubagents()
  readonly children: AcpChildSessions
  protected readonly ownership: AcpTimelineOwnership
  private readonly started = new BoundedMap<string, true>({ maxEntries: 128 })
  readonly elicitations = new AcpUrlElicitations()
  readonly failures: AcpTurnFailures
  private loading = false
  private readonly context = new AcpContextTimeline()
  private readonly threadGoal = new AcpThreadGoalTimeline()
  protected turns!: AcpTurnLifecycle
  private readonly agentTurns: AcpAgentTurns

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.ownership = new AcpTimelineOwnership()
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.providerSessionId = options.sessionId
    this.injectsPromptIdentity = this.dialect.injectedPromptIdentity === true
    this.failures = new AcpTurnFailures(options.sessionId, this.dialect, options.agentName)
    this.backgroundTasks = new AcpBackgroundTaskTimeline((callId) =>
      this.ownership.tools.join(callId)
    )
    this.prompts = new AcpPromptTurns(options.sessionId, this.dialect, options.agentName)
    const tools = this.ownership.tools
    this.children = new AcpChildSessions(options.sessionId, this.dialect, this.subagents, tools)
    this.agentTurns = new AcpAgentTurns(this.dialect, tools, this.backgroundTasks)
    this.turns = new AcpTurnLifecycle({
      sessionId: options.sessionId,
      prompts: this.prompts,
      agentTurns: this.agentTurns,
      failures: this.failures,
      ownership: this.ownership,
      started: this.started
    })
  }

  dispose(): void {
    this.ownership.dispose()
    this.subagents.dispose()
  }

  publication = (): (() => void) | undefined => this.ownership.publication()

  /** Use the host's command turn for compaction; inject prompt identity only when supported. */
  openPrompt(clientMessageId: string, at: number, compactionTurn?: string): OpenedPrompt {
    if (this.loading) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    const prompt = this.prompts.open(clientMessageId, at, compactionTurn)
    this.agentTurns.resume()
    if (this.prompts.current?.opened) {
      this.ownership.operation().open(prompt.promptId)
    }
    return prompt
  }

  /** A mid-turn steer shares the open turn; its acceptance renders once that turn opens. */
  joinPrompt(clientMessageId: string, at: number): OpenedPrompt {
    if (this.loading) {
      throw new Error('ACP steer overlaps a load')
    }
    return this.prompts.join(clientMessageId, at)
  }

  /** Side prompts share the session's ownership; their frames attribute while they run alone. */
  openSidePrompt(clientMessageId: string, at: number): { promptId: string; events: never[] } {
    if (this.loading) {
      throw new Error('ACP side prompt overlaps a load')
    }
    return this.prompts.openSide(clientMessageId, at)
  }
  /** The lane ends unprompted work on quiet, Stop or a send. */
  endAgentTurn(at: number, stopReason = 'end_turn'): ProviderTimelineEvent[] {
    const turn = this.agentTurns.take(this.turns.activeTurn, at, stopReason)
    return turn ? this.turns.endTurn(turn, { stopReason, at }) : []
  }

  isSyntheticBackgroundTask = (taskId: string): boolean => this.ownership.tools.backgrounds(taskId)

  agentTurnCalls = (): 'none' | 'running' | null => this.agentTurns.calls(this.turns.activeTurn)

  promptResult(
    clientMessageId: string,
    result: PromptResponse,
    at: number,
    cancelRequested = false
  ): ProviderTimelineEvent[] {
    const { stopReason, _meta } = result
    const providerTurnId = this.dialect.promptTurnId?.(_meta)
    const ending = {
      stopReason,
      at,
      hookBlock: this.dialect.hookBlock?.(_meta),
      cancelRequested,
      ...(providerTurnId === undefined ? {} : { providerTurnId })
    }
    return this.turns.finishPrompt(clientMessageId, ending)
  }

  /** Only agent-authored failures supply diagnostic text; connection loss is handled separately. */
  promptFailed(clientMessageId: string, error: Error, at: number): ProviderTimelineEvent[] {
    const result = this.prompts.failure(clientMessageId, error, at, this.failures)
    return Array.isArray(result) ? result : this.turns.finishPrompt(clientMessageId, result)
  }

  sessionLost = (error: AcpAgentError): boolean =>
    this.dialect.sessionLost?.(error, this.options.sessionId) === true

  authenticationRequired = (error: unknown): boolean =>
    acpAuthenticationRequired(this.dialect, error)

  /** Return the agent's refusal before turn open; afterward the error belongs to `promptFailed`. */
  promptRefused(clientMessageId: string, error: AcpAgentError): string | null {
    return this.prompts.refuse(clientMessageId) ? acpPromptErrorDetail(this.dialect, error) : null
  }

  contextModels = (models: unknown, at: number): ProviderTimelineEvent[] =>
    this.context.models(models, at, this.dialect, { thread: this.options.sessionId })

  /** Discard loaded history except context-window information. */
  beginLoad(): void {
    if (this.prompts.current || this.loading) {
      throw new Error('ACP load overlaps a prompt or load')
    }
    this.loading = true
  }

  finishLoad(): void {
    this.loading = false
  }

  reconcileSubagent(
    id: string,
    state: NativeChatSubagentState,
    at: number
  ): ProviderTimelineEvent[] {
    return this.subagents.reconcile(id, state, this.options.sessionId, at)
  }

  /** Provisionally settle missing tasks; later provider endings may revise the outcome. */
  reconcileBackgroundTask(taskId: string): ProviderTimelineEvent[] {
    return this.backgroundTasks.reconcile(taskId, this.options.sessionId)
  }

  sessionEvent(event: AcpSessionEvent, at: number): ProviderTimelineEvent[] {
    const params = event.kind === 'known' ? event.notification : event.raw
    return this.notification('session/update', params, at)
  }

  notification(method: string, params: unknown, at: number): ProviderTimelineEvent[] {
    if (this.ownership.disposed) {
      return []
    }
    if (this.elicitations.completes(method, this.dialect)) {
      return this.elicitations.complete(params, at)
    }
    const extension = this.dialect.notification?.(method, params, at)
    // (Upstream ask: cognition.ai/chain on update _meta would make this attribution exact.)
    const open = this.prompts.promptTurn(this.turns.activeTurn)
    const child = this.children.notification(method, params, extension, this.loading, open, at)
    if (child) {
      return child
    }
    if (extension?.disposition === 'ignore') {
      return []
    }
    if (method !== 'session/update' && !extension) {
      return []
    }
    const envelope = acpNotificationEnvelopeSchema.safeParse(params)
    const read = method === 'session/update' ? readAcpSessionEvent(params) : null
    const standard = read?.kind === 'known' ? read.notification : undefined
    const update = standard?.update
    const markedReplay =
      (envelope.success && envelope.data._meta?.isReplay === true) || extension?.replay === true
    if (markedReplay || (extension?.replay === undefined && this.loading)) {
      return this.context.history(update, extension?.usage, at, { thread: this.options.sessionId })
    }
    const opens =
      (update !== undefined && ACP_SUBSTANTIVE_UPDATES.includes(update.sessionUpdate)) ||
      extension?.end !== undefined ||
      extension?.started === true
    const offeredTurn = extension?.turn ?? open ?? this.agentTurns.mint(opens, at, update)
    const operation = this.ownership.operation()
    const owner = update
      ? this.ownership.messages.owner(offeredTurn, update, operation.settled)
      : { turn: offeredTurn }
    // Host command IDs cannot join provider-keyed turns, even when their late frames outlive `last`.
    const settledCommand =
      owner.turn?.startsWith('compact:') === true && this.prompts.current?.turn !== owner.turn
    const turn = this.prompts.compacting(owner.turn) || settledCommand ? undefined : owner.turn
    const drop = this.ownership.messages.rejection(update, owner, this.options.sessionId, turn)
    if (drop) {
      this.ownership.messages.observe(owner.turn, update)
      this.options.onTextDropped?.(drop)
      return []
    }
    const events: ProviderTimelineEvent[] = []
    if (turn && opens) {
      events.push(...this.start(turn, extension?.at ?? at, operation))
    }
    this.ownership.messages.observe(owner.turn, update)
    const join = { thread: this.options.sessionId, ...(turn === undefined ? {} : { turn }) }
    if (extension?.backgroundTasks) {
      const tasks = extension.backgroundTasks.filter((task) => !this.subagents.has(task.taskId))
      events.push(...this.backgroundTasks.translate(tasks, join))
    }
    if (extension?.subagents) {
      events.push(...this.subagents.translate(extension.subagents, join, at))
    }
    if (extension?.usage) {
      events.push(...this.context.update(extension.usage, join))
    }
    events.push(...this.threadGoal.update(extension?.threadGoal, join, at))
    if (settledCommand || this.prompts.absorbCompaction(owner.turn, extension, update)) {
      return events
    }
    events.push(...this.failures.notification(turn, extension))
    if (extension?.disposition === 'map' && extension.failure && standard) {
      return events
    }
    if (extension?.end && turn) {
      // Hook refusal ends immediately; normal completion waits for the prompt reply.
      const livePrompt = this.prompts.byTurn(turn)
      const end = extension.end
      if (livePrompt && ['end_turn', 'cancelled'].includes(end.stopReason) && !end.hookBlock) {
        livePrompt.durationMs = end.durationMs
      } else {
        events.push(
          ...this.prompts.endTurn(turn, { ...end, at }, this.failures, (t) => this.turns.end(t))
        )
      }
      return events
    }
    if (extension?.consumed === true) {
      return events
    }
    if (standard) {
      const messageKey =
        turn && this.dialect.injectedPromptIdentity
          ? this.ownership.messages.key(turn, standard.update)
          : undefined
      return [
        ...events,
        ...acpSessionUpdate(standard, turn, at, {
          tools: this.ownership.tools,
          dialect: this.dialect,
          backgroundTasks: this.backgroundTasks,
          subagents: this.subagents,
          failures: this.failures,
          messageKey
        })
      ]
    }
    if (method === 'session/update') {
      events.push({ type: 'provider.frame', frameKind: method, payload: params, join })
    }
    return events
  }

  request(
    method: string,
    params: unknown,
    id: string | number
  ): ReturnType<typeof translateAcpRequest> {
    return this.elicitations.track(
      translateAcpRequest(method, params, id, {
        sessionId: this.options.sessionId,
        dialect: this.dialect,
        tools: this.ownership.tools
      })
    )
  }

  protected start(
    turn: string,
    at: number,
    operation = this.ownership.operation()
  ): ProviderTimelineEvent[] {
    return this.turns.start(turn, at, operation)
  }
}
