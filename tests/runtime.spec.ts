import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubKind } from '../src/sources/github.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { commentTrigger, githubChannel } from '../src/sources/github-trigger.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import { observePull, pullOf } from '../src/sources/github-pull.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { RuntimeHarness, MEMBER, CHAT, worktreeName } from './fixtures/runtime.ts'
import { viewsOf, overviewOf } from './fixtures/runtime-views.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('relays an explicit member mention as a candidate and creates the ticket, acknowledgement, subscription and worker on accept', async () => {
  const { trigger, ticket, sessionId } = await h.acceptedTicket()
  const candidate = h.relays(h.runtime.masterId).find((item) => item.kind === 'candidate')!
  expect(candidate).toMatchObject({
    strength: 'explicit',
    trigger_id: trigger.id,
    next_action: 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.',
  })
  expect(ticket).toMatchObject({
    title: '修复回归',
    mandate: {
      strength: 'explicit',
      basis: expect.objectContaining({
        via: 'addressed',
        source: 'feishu',
        sender: 'Alice',
        addressed: 'mention',
        scope: expect.objectContaining({ chatId: CHAT }),
      }),
    },
    execution: expect.objectContaining({ name: expect.stringMatching(/^fix-regression-/) }),
    origin: expect.objectContaining({ triggerId: trigger.id }),
  })
  expect(ticket).not.toHaveProperty('ended')
  // The ticket's execution environment is fixed at accept time: its directory under the execution root, and the Sources' values from its Trigger.
  expect(ticket.execution!.directory).toBe(join(h.directory, 'work', ticket.execution!.name))
  expect(Object.fromEntries(h.runtime.ticketEnvironment(ticket).map((variable) => [variable.key, variable.value]))).toMatchObject({
    DSH_SUPERAGENT_DIR: ticket.execution!.directory,
    DSH_SUPERAGENT_NAME: ticket.execution!.name,
    DSH_SUPERAGENT_TICKET: ticket.id,
    DSH_SUPERAGENT_FEISHU_CHAT: CHAT,
    DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets',
    DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot',
    DSH_SUPERAGENT_GITHUB_NUMBER: '',
  })
  expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
  expect(sessionId).toBe(`worker-${ticket.id}`)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_1`)?.subscriptions).toEqual([ticket.id])
  expect(h.runtime.store.replyStatus(key('ack', trigger.id))).toBe('sent')
  const larkCalls = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  expect(larkCalls.find((args) => args[1] === '+messages-reply')).toEqual(
    expect.arrayContaining(['--message-id', 'om_1', '--markdown', '收到，修复回归。'])
  )
  // The first message holds the request itself: an explicit ticket has no assignment text beyond it, and nothing to read first.
  const first = h.relays(sessionId)[0]!
  expect(first).toEqual({
    ticket_id: ticket.id,
    title: '修复回归',
    trigger: expect.objectContaining({ trigger_id: trigger.id, from: MEMBER, thread: `feishu:${CHAT}:om_1`,
      text: JSON.stringify({ kind: 'untrusted_trigger_text', text: trigger.text }) }),
  })
  expect(first.trigger).not.toHaveProperty('read')
  expect(
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'again', worktree_name: worktreeName, acknowledgement: 'x' })
  ).toMatchObject({ ticket: { ticket_id: ticket.id } })
})

it("fans a person's later thread message out to the live worker as context and tells the orchestrator, without an Eval", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  h.agent.deliveries.mockClear()
  const followup = h.feishu('2', '顺便看看日志', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await h.receive(followup)
  const worker = h.relays(sessionId)
  expect(worker).toHaveLength(1)
  expect(worker[0]).toMatchObject({ trigger_id: followup.id, from: 'ou_guest',
    text: JSON.stringify({ kind: 'untrusted_trigger_text', text: '顺便看看日志' }) })
  expect(worker[0]).not.toHaveProperty('read')
  // Its resource renders the same, from the ticket; no body of it is stored.
  const resource = `ticket/${ticket.id}/input/${key(h.runtime.store.tickets.get(ticket.id)!.inputs[0]!.id)}`
  expect(JSON.parse(((await h.runTool(sessionId, 'orchestrator_read', { resource })) as { text: string }).text)).toEqual(worker[0])
  expect(h.runtime.store.get(resource)).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: followup.id })])
  expect(h.relays(h.runtime.masterId)).toEqual([
    {
      kind: 'follow_up',
      trigger_id: followup.id,
      from: 'ou_guest',
      thread: `feishu:${CHAT}:om_1`,
      at: followup.at,
      text: JSON.stringify({ kind: 'untrusted_trigger_text', text: '顺便看看日志' }),
      delivered_to: [{ ticket_id: ticket.id, title: '修复回归', state: 'working' }],
      note: expect.stringContaining('worker has it and decides'),
    },
  ])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_1`).map((decision) => decision.triggerIds)).toEqual([
    [ticket.origin.triggerId],
  ])
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `trigger/${followup.id}` })).toMatchObject({
    trigger_id: followup.id,
    around: { before: expect.objectContaining({ read: `trigger/${key('feishu', 'om_1')}` }) },
  })
})

it('records worker reports, binds the task PR, ends the ticket on ready without a PR, and relays attention', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  h.agent.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'started' })).toMatchObject({
    notification: 'internal_only',
  })
  expect(h.relays(h.runtime.masterId)).toEqual([])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: 'Desktop too?' })
  expect(h.runtime.store.tickets.get(ticket.id)!.attention).toMatchObject({ question: 'Desktop too?' })
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({
    kind: 'worker_attention',
    ticket: { ticket_id: ticket.id, attention: { question: 'Desktop too?' } },
  })
  await expect(
    h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'other', text: 'x' })
  ).rejects.toThrow('current attention question')
  expect(
    await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      purpose: 'attention',
      human_action: 'Desktop too?',
      text: '要不要也改桌面端？',
    })
  ).toEqual({ status: 'sent' })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42, human_action: null })
  const bound = h.runtime.store.tickets.get(ticket.id)!
  expect(pullOf(bound)).toBe(42)
  expect(bound.attention).toBeUndefined()
  expect(h.runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'ready' })
  expect(
    await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      purpose: 'result',
      text: '已提交 PR #42，待 review。',
    })
  ).toEqual({ status: 'sent' })
  const mergedAt = new Date().toISOString()
  const merged = {
    number: 42,
    state: 'closed',
    merged: true,
    merged_at: mergedAt,
    html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' },
    head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } },
  }
  await observePull(h.runtime.context(githubKind), merged)
  const ended = h.runtime.store.tickets.get(ticket.id)!
  expect(ended).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'merged' }) })
  // The ended ticket keeps its Subscription to the PR, so a later human comment there resumes it.
  expect(h.runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  // Its worker's last word was its ready report, so its turn is not cancelled: it ends it itself.
  expect(h.agent.agents.get(sessionId)!.cancel).not.toHaveBeenCalled()
  const notice = h.runtime.store.receipts.waiting().find((item) => item.kind === 'notice')
  expect(
    notice ?? h.runtime.store.replyStatus(key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged'))
  ).toBeTruthy()
})

it('ends a ticket on ready when no PR is bound', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done locally' })
  expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ outcome: 'completed' }) })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'late' })).rejects.toThrow('Ticket ended')
})

it("stops a ticket on a person's instruction for good, and resumes an ended one on any person's message on its thread", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  const request = h.feishu('5', '@bot 停下，不用修了', { root_id: 'om_1' })
  await h.receive(request)
  expect(await h.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id })).toMatchObject({
    decision: 'stop',
    reason: 'Human asked to stop',
    ticket: { ticket_id: ticket.id, state: 'stopped' },
  })
  // The end says it was a person's stop once: no reason that repeats the outcome, none copied onto the Assignment.
  const stopped = h.runtime.store.tickets.get(ticket.id)!
  expect(stopped.ended).toEqual({ at: expect.any(String), by: 'human', outcome: 'stopped' })
  expect(stopped.assignments[0]).not.toHaveProperty('endedReason')
  expect(h.agent.agents.get(sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  // A stop withdraws the mandate: later messages wait as context, and only new work restarts it.
  const guest = h.feishu('6', '继续吧', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await h.receive(guest)
  await h.runtime.pump()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: guest.id })).rejects.toThrow('stopped')
  // A ticket that ended by itself resumes on a person's message on its thread, whoever sent it.
  const other = await h.acceptedTicket(h.feishu('20', '@bot 修另一个'))
  await h.runTool(other.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'not reproduced' })
  expect(h.runtime.store.tickets.get(other.ticket.id)!.ended).toBeDefined()
  await h.receive(h.feishu('21', '我这边还能复现', { mentions: [], root_id: 'om_20', sender_id: 'ou_guest' }))
  await h.runtime.pump()
  const resumed = h.runtime.store.tickets.get(other.ticket.id)!
  expect(resumed.ended).toBeUndefined()
  expect(resumed.assignments).toHaveLength(2)
  expect(resumed.inputs.map((input) => input.kind)).toContain('resumed')
})

it('attaches an event to an existing open task through orchestrator_route', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  const other = h.feishu('9', '@bot 顺手把这里也改了', { root_id: undefined })
  await h.receive(other)
  h.agent.deliveries.mockClear()
  expect(await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id, note: '同一个页面' })).toMatchObject({
    ticket: { ticket_id: ticket.id },
  })
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([ticket.id])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_9`)).toEqual([
    expect.objectContaining({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticket.id } }] }),
  ])
  expect(h.relays(sessionId)[0]).toMatchObject({ trigger_id: other.id,
    text: JSON.stringify({ kind: 'untrusted_trigger_text', text: '@bot 顺手把这里也改了' }), routing_note: '同一个页面' })
})

it('acknowledges a follow-up from the worker once and rejects events outside the task', async () => {
  const { sessionId, ticket } = await h.acceptedTicket()
  const followup = h.feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await h.receive(followup)
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({
    acknowledgement: 'sent',
    reused: false,
  })
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '不同措辞' })).toMatchObject({ reused: true })
  const stranger = h.feishu('11', '无关', { mentions: [], root_id: undefined })
  await h.receive(stranger)
  await expect(h.runTool(sessionId, 'orchestrator_ack', { trigger_id: stranger.id, text: 'x' })).rejects.toThrow('does not belong')
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs.map((input) => input.kind)).toEqual(['trigger'])
})

it('queues a requeued trigger visibly and tells the orchestrator', async () => {
  const stranger = commentTrigger(
    {
      id: 3,
      body: 'looks wrong',
      user: { login: 'someone' },
      html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-3',
      created_at: '2026-09-09T00:00:00Z',
    },
    { number: 8, isPr: true },
    'conversation',
    'agent-bot'
  )
  await h.receive(stranger)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  expect(threadDetail(viewsOf(h.runtime), 'github:8', undefined, 50)!.timeline[0]!.disposition).toMatchObject({ queued: true })
  await vi.waitFor(() => expect(h.agent.agents.get(h.runtime.masterId)!.inject).toHaveBeenCalled())
})

it("asks a question where the human message that raised it was written, not in the ticket's original conversation", async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket()
  h.subscribe(ticket.id, { source: 'github', id: '42' })
  const review = commentTrigger(
    {
      id: 5,
      body: 'Can you add the reason?',
      user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-5',
      created_at: '2026-09-09T00:02:00Z',
    },
    { number: 42, isPr: true },
    'review',
    'agent-bot'
  )
  await h.receive(review)
  await expect(
    h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', question_for_trigger_id: review.id })
  ).rejects.toThrow('needs the question it raised')
  await expect(
    h.runTool(sessionId, 'orchestrator_report', {
      state: 'progress',
      summary: 'x',
      human_action: 'Keep it?',
      question_for_trigger_id: 'unknown',
    })
  ).rejects.toThrow("the person's message that raised it")
  await h.runTool(sessionId, 'orchestrator_report', {
    state: 'progress',
    summary: 'no stop reason is recorded',
    human_action: 'Keep the PR and record the reason in a follow-up?',
    question_for_trigger_id: review.id,
  })
  const queued = vi.spyOn(h.runtime.outbox, 'send')
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
    ticket_id: ticket.id,
    purpose: 'attention',
    human_action: 'Keep the PR and record the reason in a follow-up?',
    text: 'Keep the PR and record the reason in a follow-up?',
  })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(review.channel)
  // A question about the ticket as a whole still goes to where the ticket started.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'y', human_action: 'Desktop too?' })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
    ticket_id: ticket.id,
    purpose: 'attention',
    human_action: 'Desktop too?',
    text: '要不要也改桌面端？',
  })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(trigger.channel)
})

it('keeps pages of Source reads, prompt previews and Feishu message links in memory, outside the kv area', async () => {
  const message = h.feishu('30', '随便说说', { mentions: [] })
  await h.receive(message)
  const link = 'https://applink.feishu.cn/client/message/link/open?token=t30'
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ messages: [{ message_id: 'om_30', chat_id: CHAT, message_app_link: link }] })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${message.id}` })).toMatchObject({
    source_url: link,
  })
  // An AppLink is found by the links read since dsh-superagent started.
  expect((await h.api('GET', `search?q=${encodeURIComponent(link)}`)).body).toMatchObject({
    items: [expect.objectContaining({ id: message.id })],
  })
  const config = h.runtime.prompts.current().config
  const { previews } = (await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config, preview: true })) as {
    previews: { read: string }[]
  }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: previews[0]!.read, offset: 4000 })).toMatchObject({
    offset: 4000,
  })
  expect(h.runtime.store.keys('').filter((name) => /-read:|source-link:|prompt-preview\//.test(name))).toEqual([])
})

it('reads resources recorded under the pre-vocabulary names', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket()
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `event/${trigger.id}` })).toMatchObject({ trigger_id: trigger.id })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `task/${ticket.id}/assignment` })).toMatchObject({
    resource: `ticket/${ticket.id}/assignment`,
  })
})

it('shows a failed reply as a problem with its attempts, an error of the reply effects after three, until it is withdrawn', async () => {
  const { trigger } = await h.acceptedTicket()
  vi.spyOn(Commands.prototype, 'lark').mockRejectedValue(new Error('internal error (2200)'))
  h.runtime.outbox.send({ id: 'stuck', channel: trigger.channel!, text: '已合并。', kind: 'notice' })
  const outgoing = () => overviewOf(h.runtime).problems.filter((problem) => problem.kind === 'outgoing')
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try {
      await h.runtime.sendReplies()
    } finally {
      vi.useRealTimers()
    }
  }
  await h.runtime.sendReplies()
  expect(outgoing()).toEqual([
    { kind: 'outgoing', outgoing: expect.objectContaining({ id: 'stuck', attempts: 1, error: expect.stringContaining('2200') }) },
  ])
  expect(h.runtime.health.reply).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  // Its retries come after 5 and then 10 more seconds.
  await at(5000)
  await at(15_000)
  expect(h.runtime.health.reply).toMatchObject({ state: 'error', detail: expect.stringContaining('2200') })
  expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })
  // A withdrawn reply takes its effect with it, which clears the error at once.
  h.runtime.outbox.withdraw('stuck')
  expect([outgoing(), h.runtime.health.reply, h.runtime.effects.pending('reply', 'stuck')]).toEqual([
    [],
    expect.objectContaining({ state: 'ready', detail: 'Nothing waiting' }),
    false,
  ])
})

describe("the order of a Ticket's messages to one conversation", () => {
  const sent: string[] = []
  const refused = new Set<string>()
  const message = (id: string, ticketId: string, channel = feishuChannel(CHAT, 'om_1')) => ({
    id,
    channel,
    text: id,
    kind: 'reply' as const,
    ticketId,
  })
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try {
      await h.runtime.sendReplies()
    } finally {
      vi.useRealTimers()
    }
  }
  beforeEach(async () => {
    sent.length = 0
    refused.clear()
    await h.acceptedTicket()
    vi.spyOn(h.runtime.sources, 'send').mockImplementation(async (message) => {
      if (refused.has(message.id)) throw new Error('internal error (2200)')
      sent.push(message.id)
      return 'sent'
    })
  })
  it("sends a Ticket's later result after its acknowledgement that failed once, and holds no other Ticket's message in the chat", async () => {
    refused.add('ack-a')
    h.runtime.outbox.send(message('ack-a', 'a'))
    await h.runtime.sendReplies()
    refused.delete('ack-a')
    h.runtime.outbox.send(message('result-a', 'a'))
    // Another Ticket in the same chat, and the same Ticket in an Issue, are other orders.
    h.runtime.outbox.send(message('ack-b', 'b', feishuChannel(CHAT, 'om_2')))
    h.runtime.outbox.send(message('issue-a', 'a', githubChannel(7)))
    await h.runtime.sendReplies()
    expect([h.runtime.outbox.status('result-a'), sent]).toEqual(['pending', ['ack-b', 'issue-a']])
    await at(5000)
    expect(sent).toEqual(['ack-b', 'issue-a', 'ack-a', 'result-a'])
  })
  it("stops holding a Ticket's later messages behind one that failed three times, which the overview shows", async () => {
    refused.add('ack-a')
    h.runtime.outbox.send(message('ack-a', 'a'))
    await h.runtime.sendReplies()
    h.runtime.outbox.send(message('result-a', 'a'))
    // Its retries come after 5 and then 10 more seconds; the third failure releases the result.
    await at(5000)
    expect(sent).toEqual([])
    await at(15_000)
    expect(sent).toEqual(['result-a'])
    expect(overviewOf(h.runtime).problems).toContainEqual({
      kind: 'outgoing',
      outgoing: expect.objectContaining({ id: 'ack-a', attempts: 3 }),
    })
  })
})

it('keeps the receipt of a message withdrawn while it went out, so its id is not queued again', async () => {
  const { trigger } = await h.acceptedTicket()
  vi.spyOn(h.runtime.sources, 'send').mockImplementation(async (message) => {
    h.runtime.outbox.withdraw(message.id)
    return 'sent'
  })
  h.runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  h.runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Again', kind: 'reply' })
  expect([h.runtime.store.receipts.get('raced'), h.runtime.effects.pending('reply')]).toEqual([
    expect.objectContaining({ text: 'Done', status: 'sent' }),
    false,
  ])
})

it('resumes several ended tickets on one thread from one message without the launch waiting on itself', async () => {
  const first = await h.acceptedTicket()
  const other = h.feishu('30', '@bot 顺手把这里也改了', { root_id: undefined })
  await h.receive(other)
  await h.route({ kind: 'attach', ticket_id: first.ticket.id, trigger_id: other.id })
  // A request on the first ticket's thread becomes a second ticket there once the first's worker hands it back.
  const another = h.feishu('31', '@bot 另一件事', { root_id: 'om_1' })
  await h.receive(another)
  await h.runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another change.' })
  const second = await h.acceptedTicket(another)
  for (const ticket of [first, second])
    await h.runTool(ticket.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  await h.receive(h.feishu('32', '还有问题', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  await vi.waitFor(
    () => expect([first, second].map((ticket) => h.runtime.store.tickets.get(ticket.ticket.id)!.ended)).toEqual([undefined, undefined]),
    { timeout: 3000 }
  )
  await vi.waitFor(
    () =>
      expect([first, second].map((ticket) => h.runtime.store.tickets.get(ticket.ticket.id)!.assignments.at(-1)!.state)).toEqual([
        'running',
        'running',
      ]),
    { timeout: 3000 }
  )
})

it('attaches a message to an ended ticket and so resumes it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const other = h.feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  await h.receive(other)
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined())
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
})

it('drops a message only when its conversation is gone or not listened to, newest drop first, and keeps it while its Source is off', async () => {
  const channel = h.feishu('7', 'x').channel!
  // Messages of no Ticket keep no order, so none waits behind another.
  const queue = (id: string, address: Record<string, string>) => {
    h.runtime.outbox.send({ id, channel: { ...channel, address }, text: '已合并。', kind: 'notice' })
  }
  queue('gone-reply', channel.address)
  queue('failing-reply', { ...channel.address, messageId: 'om_8' })
  vi.mocked(Commands.prototype.lark).mockImplementation(async (args) => {
    const replying = args.join(' ')
    if (replying.includes('om_7')) throw new CliError('the message was withdrawn', 230011)
    if (replying.includes('om_9')) return {}
    // Text that names a withdrawal is no answer from Feishu that the conversation is gone.
    throw new Error('Request failed: withdrawn tokens are not recalled messages')
  })
  await h.runtime.sendReplies()
  // The Feishu Channel reads the recall code as gone; any other failure keeps the reply for a retry.
  expect(h.runtime.store.replyStatus('gone-reply')).toBe('dropped')
  expect(h.runtime.store.replyStatus('failing-reply')).toBe('pending')
  const settings = h.runtime.store.settings(),
    feishuSource = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...feishuSource, enabled: false } } })
  queue('off-reply', { ...channel.address, messageId: 'om_9' })
  queue('ignored-reply', { chatId: 'oc_elsewhere', messageId: 'om_10' })
  await h.runtime.sendReplies()
  expect([h.runtime.store.replyStatus('off-reply'), h.runtime.store.replyStatus('ignored-reply')]).toEqual(['pending', 'pending'])
  // Once the Source is on again, the messages that waited go out or are dropped when they are tried again, after 5 seconds.
  h.runtime.store.saveSettings(settings)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5000 })
  try {
    await h.runtime.sendReplies()
  } finally {
    vi.useRealTimers()
  }
  expect([h.runtime.store.replyStatus('off-reply'), h.runtime.store.replyStatus('ignored-reply')]).toEqual(['sent', 'dropped'])
  const dropped = ((await h.api('GET', 'sources')).body as unknown as { dropped: { id: string }[] }[]).flatMap((source) => source.dropped)
  expect(dropped).toMatchObject([
    { id: 'ignored-reply', dropped: { reason: 'channelIgnored' } },
    { id: 'gone-reply', dropped: { reason: 'channelGone' } },
  ])
})

it("reports a dropped acknowledgement as dropped, with its Ticket on the Source status and in the last day's flow", async () => {
  const { sessionId, ticket } = await h.acceptedTicket()
  const followup = h.feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await h.receive(followup)
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({
    acknowledgement: 'dropped',
  })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${followup.id}` })).toMatchObject({
    acknowledgement: 'dropped',
  })
  const dropped = ((await h.api('GET', 'sources')).body as unknown as { dropped: unknown[] }[]).flatMap((source) => source.dropped)
  expect(dropped).toMatchObject([{ id: key('ack', followup.id), ticket: { id: ticket.id, title: ticket.title } }])
  expect(overviewOf(h.runtime).flow.dropped).toBe(1)
})

it('records a report, the PR it binds and its relay together, or none of them', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  h.agent.deliveries.mockClear()
  const before = h.runtime.store.tickets.get(ticket.id)!
  // A report the Engine refuses binds no PR, though the PR itself could be bound.
  await expect(
    h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done', pr_number: 42, human_action: 'Ship it?' })
  ).rejects.toThrow()
  // A PR the pull request rules refuse records no report.
  vi.mocked(Commands.prototype.gh).mockImplementation(async (args) =>
    args[1]?.includes('/pulls/')
      ? {
          state: 'open',
          user: { login: 'someone' },
          html_url: 'https://github.com/acme/widgets/pull/7',
          head: { ref: 'feature/other', sha: 'h', repo: { full_name: 'acme/widgets' } },
        }
      : { default_branch: 'master', permissions: { push: true } }
  )
  await expect(
    h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 7, human_action: 'Desktop too?' })
  ).rejects.toThrow()
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after).not.toHaveProperty('follows')
  expect(after).not.toHaveProperty('attention')
  expect(after.assignments).toEqual(before.assignments)
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toEqual([])
})

it('tells the main Session of each requeue of the same Trigger', async () => {
  const stranger = commentTrigger(
    {
      id: 4,
      body: 'still wrong',
      user: { login: 'someone' },
      html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-4',
      created_at: '2026-09-09T00:00:00Z',
    },
    { number: 8, isPr: true, url: 'https://github.com/acme/widgets/pull/8' },
    'conversation',
    'agent-bot'
  )
  await h.receive(stranger)
  const requeued = () =>
    h.agent.agents.get(h.runtime.masterId)!.inject.mock.calls.filter(([message]) => JSON.stringify(message).includes('trigger_requeued'))
      .length
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  await h.runtime.idle()
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  await h.runtime.idle()
  expect(requeued()).toBe(2)
})

it('keeps replies and acknowledgements to an IM conversation within the IM limit', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket()
  const long = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  await expect(
    h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: long })
  ).rejects.toThrow(`maximum is ${IM_WORDS}`)
  const follow = h.feishu('3', '还有一个问题', { mentions: [], root_id: trigger.meta.messageId as string, sender_id: MEMBER })
  await h.receive(follow)
  await expect(h.runTool(sessionId, 'orchestrator_ack', { trigger_id: follow.id, text: long })).rejects.toThrow(`at most ${IM_WORDS} words`)
})

it("refuses an ended ticket's worker its tools, and restricts the main Session to the tools it may use", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  expect(h.agent.guards.get(sessionId)!()).toBeUndefined()
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.agent.guards.get(sessionId)!()).toBe('Ticket ended; new work needs a new authorized ticket')
  expect(h.agent.restricts.get(h.runtime.masterId)).toEqual([
    { allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] },
  ])
  // A worker keeps only the profile's work tools: none that ask a person, change the profile, schedule or start work outside
  // the worker slots, reach other Sessions or edit documents, whenever they were registered.
  expect(h.agent.restricts.get(sessionId)).toEqual([
    { allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] },
  ])
})
