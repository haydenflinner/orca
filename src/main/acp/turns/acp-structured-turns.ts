import type { AcpSend, AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'
// Steers wait for the active prompt to answer cancellation; agent-initiated turns accept sends directly.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { acpCompactPrompt } from './acp-compaction-turn'
import { AcpJoinedSends } from './acp-structured-joined-sends'
import { AcpTurnIdlers } from './acp-turn-idlers'
import { AcpSideSends } from './acp-structured-side-sends'
import {
  acpAgentTurnFailed,
  acpCancelForSteer,
  acpTurnAnswered,
  acpTurnErrored,
  acpTurnRejected,
  type AcpTurnAnswerHost
} from './acp-structured-turn-answers'
import { AcpAuthRequiredError } from '../transport/acp-errors'

type Send = AcpSend

export class AcpStructuredTurns {
  private active: Send | null = null
  // One cancel per prompt; failed writes allow a later steer to retry.
  private steerCancelled: Send | null = null
  private readonly steers: Send[] = []
  /** Concurrent mid-turn steers sharing the active send's turn. */
  private readonly joined: AcpJoinedSends
  private readonly side: AcpSideSends
  private readonly answers: AcpTurnAnswerHost
  private readonly unsettled = new Set<string>()
  private readonly idlers = new AcpTurnIdlers()
  private ended = false
  private stopAt: number | null = null
  // Steers still preparing their controls; they hold their place like queued steers.
  private preparingSteers = 0
  // Counts Stops: finish() clears stopAt before a preparing steer can see it.
  private withdrawals = 0

  constructor(private readonly deps: AcpStructuredTurnsDeps) {
    this.answers = {
      ...deps,
      inFlight: (send) => this.inFlight(send),
      accept: (clientMessageId) => this.accept(clientMessageId),
      reject: (clientMessageId, fact) => this.reject(clientMessageId, fact),
      finish: (send) => this.finish(send),
      cancelled: (send) => this.stopAt !== null || this.steerCancelled === send,
      markEnded: () => (this.ended = true)
    }
    this.side = new AcpSideSends(deps, {
      ended: () => this.ended,
      started: () => {
        this.stopAt = null
      },
      answered: (send, result) => acpTurnAnswered(this.answers, send, result),
      errored: (send, error) => acpTurnErrored(this.answers, send, error),
      idle: () => {
        if (this.active === null) {
          this.idlers.notify()
        }
      }
    })
    this.joined = new AcpJoinedSends(deps, {
      answered: (send, result) => acpTurnAnswered(this.answers, send, result),
      errored: (send, error) => acpTurnErrored(this.answers, send, error)
    })
  }

  capturePendingSend(clientMessageId: string): () => boolean {
    const send =
      this.active?.clientMessageId === clientMessageId
        ? this.active
        : (this.joined.find(clientMessageId) ?? null)
    return () => send !== null && this.inFlight(send) && !this.ended
  }

  get running(): boolean {
    return this.active !== null || this.side.running
  }

  /** Interactive requests wait for the person, including in turns the agent began itself, unless Stop or a steer cuts them short. */
  get acceptsRequests(): boolean {
    return (
      this.stopAt === null &&
      (this.active === null || this.steerCancelled !== this.active) &&
      !this.ended
    )
  }

  get heldSends(): ReadonlySet<string> {
    return this.unsettled
  }

  get holdsSteers(): boolean {
    return this.steers.length > 0 || this.preparingSteers > 0 || this.side.queued
  }

  get withdrawalEpoch(): number {
    return this.withdrawals
  }

  get stopped(): boolean {
    return this.stopAt !== null
  }

  /** First Stop time on the Date.now clock. */
  get stoppedAt(): number | null {
    return this.stopAt
  }

  /** A Stop covers the running prompt or the agent's own open turn; later work may ask again. */
  stop(at: number): boolean {
    const agentTurn = this.active ? null : this.deps.lane.openTurnId
    if ((this.active || agentTurn !== null) && this.stopAt === null) {
      this.stopAt = at
      if (agentTurn !== null) {
        void this.deps.lane.whenTurnLeaves(agentTurn).then(() => {
          if (this.stopAt === at) {
            this.stopAt = null
          }
        })
      }
    }
    return this.withdrawSteers()
  }

  /** Earlier admitted steers retain their native queue and settlement while the host holds new input. */
  interruptForPermissionTransition(): void {
    if (this.active) {
      this.cancelForSteer()
    } else if (this.deps.lane.openTurnId !== null && !this.deps.lane.agentTurn.endUnasked()) {
      this.deps.withdrawRequests()
      void this.deps.connection.cancel().catch(() => undefined)
      this.deps.lane.agentTurn.end('cancelled')
    }
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    return this.idlers.whenIdle(() => !this.active && !this.side.running, signal)
  }

  /** A steer whose controls must run as a prompt first holds its place until released: Stop
   *  reaches it, and answers ahead of it are cancelled as they start, as for any newer steer. */
  holdSteer(): () => void {
    this.preparingSteers += 1
    // A mid-turn-capable agent takes the prepared steer without a cancel.
    if (this.deps.midTurnPrompts !== true) {
      this.cancelForSteer()
    }
    return () => void this.preparingSteers--
  }

  /** A Stop or teardown since `epoch` withdraws a preparing steer like any held steer. */
  withdrawnSince(epoch: number): 'stopped' | 'ended' | null {
    return this.ended ? 'ended' : this.withdrawals === epoch ? null : 'stopped'
  }

  dispatch(send: Send): void {
    this.unsettled.add(send.clientMessageId)
    // Side sends take the agent's read-only chain concurrently; anything else steers as before.
    if (send.side === true && this.deps.chains === true) {
      this.side.dispatch(send)
      return
    }
    if (this.active) {
      // Mid-turn-capable agents take a concurrent steer instead of a cancel; a prompt
      // already dying to an earlier cancel or owning its lane keeps the serial path.
      if (
        this.deps.midTurnPrompts === true &&
        this.steerCancelled !== this.active &&
        this.active.exclusive !== true &&
        this.joined.join(send)
      ) {
        return
      }
      this.steers.push(send)
      this.cancelForSteer()
      return
    }
    this.start(send)
  }

  /** The host owns compaction-message settlement; reuse its open command turn. */
  async compact(command: StructuredAgentSessionCommandRun): Promise<AgentSessionCommandAdmission> {
    if (this.active || this.side.running || this.ended) {
      throw new Error(`${this.deps.agentName} is still working`)
    }
    const { lane } = this.deps
    const agentTurn = lane.openTurnId
    // A backed-up journal admits the agent turn's end later; adopt the command after it.
    if (lane.agentTurn.end() && agentTurn !== null) {
      await lane.whenTurnLeaves(agentTurn)
      if (this.active || this.ended) {
        throw new Error(`${this.deps.agentName} is still working`)
      }
    }
    const send: Send = {
      clientMessageId: command.clientMessageId,
      prompt: acpCompactPrompt(command.instructions, this.deps.compactCommand),
      requestedAt: this.deps.now(),
      exclusive: true
    }
    lane.beginCommand(command)
    this.stopAt = null
    try {
      const opened = lane.translator.openPrompt(
        send.clientMessageId,
        send.requestedAt,
        command.turnId
      )
      this.active = send
      this.run(send, opened.promptId)
    } catch (error) {
      lane.forgetCommand(command.turnId)
      throw error
    }
    return { state: 'accepted', providerIdentity: null }
  }

  accept(clientMessageId: string): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({
        clientMessageId,
        providerIdentity: { provider: 'orca', clientMessageId }
      })
    }
  }

  private withdrawSteers(): boolean {
    this.withdrawals += 1
    const withdrawn = [...this.steers.splice(0), ...this.side.withdraw()]
    for (const send of withdrawn) {
      this.reject(
        send.clientMessageId,
        agentSessionFailureFact('cancelled', { neverReachedAgent: true })
      )
    }
    return withdrawn.length > 0
  }

  /** Teardown rejects held steers; unconfirmed in-flight sends remain unknown. */
  end(reason: string, cause?: Error): void {
    this.ended = true
    for (const send of [...this.steers.splice(0), ...this.side.withdraw()]) {
      this.reject(send.clientMessageId, agentSessionFailureFact('providerExited'))
    }
    for (const inFlight of [this.active, this.side.takeInFlight(), ...this.joined.takeAll()]) {
      if (!inFlight) {
        continue
      }
      if (cause instanceof AcpAuthRequiredError) {
        acpAgentTurnFailed(this.answers, inFlight, cause)
      } else if (this.unsettled.delete(inFlight.clientMessageId)) {
        this.deps.settle({ clientMessageId: inFlight.clientMessageId, state: 'unknown', reason })
      }
    }
    this.active = null
    this.steerCancelled = null
    this.idlers.notify()
  }

  private start(send: Send): void {
    const { lane } = this.deps
    // A new message is not covered by a Stop of the agent's own earlier turn.
    this.stopAt = null
    this.active = send
    lane.agentTurn.end()
    const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
    lane.apply(opened.events)
    this.run(send, opened.promptId)
  }

  private inFlight(send: Send): boolean {
    return send.side === true
      ? this.side.inFlight(send)
      : this.active === send || this.joined.inFlight(send)
  }

  private run(send: Send, promptId: string): void {
    const { lane } = this.deps
    // Inject identity only for dialects that echo it on turn events.
    const meta = lane.translator.injectsPromptIdentity
      ? { promptId, requestId: promptId }
      : undefined
    const answered = this.deps.connection.prompt(send.prompt, meta)
    if (this.deps.midTurnPrompts === true && send.exclusive !== true) {
      // Queued and preparing steers join this fresh turn instead of restarting it.
      for (const steer of this.steers.splice(0)) {
        this.joined.join(steer)
      }
    } else if (this.steers.length > 0 || this.preparingSteers > 0) {
      this.cancelForSteer()
    }
    answered.then(
      (result) => acpTurnAnswered(this.answers, send, result),
      (error: unknown) => acpTurnErrored(this.answers, send, error)
    )
  }

  private finish(send: Send): void {
    if (send.side === true) {
      this.side.finish(send)
      return
    }
    if (this.joined.finish(send)) {
      if (!this.active && !this.side.running) {
        this.idlers.notify()
      }
      return
    }
    if (this.active === send) {
      this.active = null
      this.stopAt = null
    }
    if (this.steerCancelled === send) {
      this.steerCancelled = null
    }
    const next = this.ended ? undefined : this.steers.shift()
    if (next) {
      this.start(next)
    } else if (!this.active && !this.side.running) {
      this.idlers.notify()
    }
  }

  /** Steering waits indefinitely for cancellation; Stop can still end the child. */
  private cancelForSteer(): void {
    acpCancelForSteer({
      deps: this.deps,
      send: this.active,
      steerCancelled: this.steerCancelled,
      setSteerCancelled: (send) => {
        this.steerCancelled = send
      }
    })
  }

  private reject(clientMessageId: string, fact: SubmissionRejectionFact): void {
    acpTurnRejected(this.deps, this.unsettled, clientMessageId, fact)
  }
}
