import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { DEVIN_ACP_DIALECT } from '../acp-dialects/devin-dialect'
import {
  GROK,
  openAcpAdapterRig,
  sendHello,
  type AcpAdapterRig
} from '../session/testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const DEVIN_SPEC = { ...GROK, dialect: DEVIN_ACP_DIALECT }
const CHAINS = {
  agentCapabilities: {
    loadSession: true,
    _meta: { 'cognition.ai/chains': true, 'cognition.ai/midTurnPrompts': true }
  }
}

function sendSide(rig: AcpAdapterRig, clientMessageId: string, text: string) {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }],
    sentAs: 'side'
  }
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body, fence: 1 })
}

describe('ACP side-chain sends', () => {
  it('runs a side-marked send on the agent chain without cancelling the turn', async () => {
    const rig = await openAcpAdapterRig({ spec: DEVIN_SPEC, initialize: CHAINS })
    await rig.acquire()
    expect(await sendHello(rig, 'main-1')).toEqual({ state: 'admitted' })
    await rig.frame('session/prompt')
    const { agent } = rig.child()

    expect(await sendSide(rig, 'side-1', 'side one')).toEqual({ state: 'admitted' })
    const first = await rig.frame('session/prompt', 1)
    expect(first.params).toMatchObject({ _meta: { 'cognition.ai/chain': 'side' } })
    expect(rig.sent('session/cancel')).toEqual([])

    // A second side send waits for the first on the single chain.
    expect(await sendSide(rig, 'side-2', 'side two')).toEqual({ state: 'admitted' })
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(2)
    agent.reply(first, { stopReason: 'end_turn' })
    const next = await rig.frame('session/prompt', 2)
    expect(next.params).toMatchObject({ _meta: { 'cognition.ai/chain': 'side' } })
    expect(rig.sent('session/cancel')).toEqual([])
  })

  it('steers a side-marked send as before when the agent advertises no chains', async () => {
    const rig = await openAcpAdapterRig({ spec: DEVIN_SPEC })
    await rig.acquire()
    expect(await sendHello(rig, 'main-1')).toEqual({ state: 'admitted' })
    const main = await rig.frame('session/prompt')
    const { agent } = rig.child()
    agent.on('session/cancel', () => agent.reply(main, { stopReason: 'cancelled' }))

    expect(await sendSide(rig, 'side-1', 'side one')).toEqual({ state: 'admitted' })
    await rig.frame('session/cancel')
    const resent = await rig.frame('session/prompt', 1)
    expect(resent.params).not.toMatchObject({ _meta: { 'cognition.ai/chain': 'side' } })
  })
})
