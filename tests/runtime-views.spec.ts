import { afterEach, beforeEach, expect, it } from 'vitest'
import { evalsHealth } from '../src/app/views/overview.ts'
import { TextCache } from '../src/app/cache.ts'
import { UserError, key, said, waitsForPerson } from '../src/core/index.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { preview, readable } from '../src/app/views/text.ts'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.ts'
import { ticketDetail, ticketList } from '../src/app/views/tickets.ts'
import { RuntimeHarness, CHAT } from './fixtures/runtime.ts'
import { viewsOf, overviewOf } from './fixtures/runtime-views.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('lists each ticket with the Threads it subscribes to, as their Sources describe them', async () => {
  const { sessionId, ticket } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  const line = () => ticketList(viewsOf(h.runtime), 'working', 0, 20).items.find((item) => item.id === ticket.id)!
  h.runtime.store.threads.describe('github:42', {
    label: '#42 Fix the margin',
    facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } },
  })
  expect(line()).not.toHaveProperty('prNumber')
  expect(line().threads).toContainEqual(
    expect.objectContaining({
      key: 'github:42',
      source: 'github',
      title: '#42 Fix the margin',
      facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } },
    })
  )
  h.runtime.store.threads.describe('github:42', { facts: { ci: null } })
  expect(line().threads.find((thread) => thread.key === 'github:42')!.facts).toEqual({ number: { value: '#42' } })
})

it('shows a message that carries JSON, with or without a label, as its label and values on lines', () => {
  const text = `GitHub PR #7 CI: ${JSON.stringify({
    head: 'abc1234',
    checks: [
      { name: 'e2e', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'in_progress', conclusion: null },
    ],
    statuses: [],
  })}`
  expect(readable(text)).toBe('GitHub PR #7 CI\nhead: abc1234\nchecks:\n- e2e · completed · failure\n- lint · in_progress\nstatuses: ')
  expect(preview(text)).toBe('GitHub PR #7 CI head: abc1234 checks: e2e · completed · failure lint · in_progress statuses:')
  expect(readable('see {this} later')).toBe('see {this} later')
  expect(readable('label: {not json}')).toBe('label: {not json}')
})

it('projects ticket, thread and decision read models for the management page', async () => {
  const { ticket, trigger } = await h.acceptedTicket()
  const threadKeyValue = `feishu:${CHAT}:om_1`
  expect(overviewOf(h.runtime)).toMatchObject({
    person: [],
    executor: { queued: 0, maxWorkers: 3, idle: 0 },
    flow: { received: 0, accepted: 0, judged: 0 },
  })
  expect(ticketList(viewsOf(h.runtime), 'working', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working' })])
  expect(ticketList(viewsOf(h.runtime), 'open', 0, 20).items).toEqual([
    expect.objectContaining({ id: ticket.id, stage: 'working', sessionId: `worker-${ticket.id}`, strength: 'explicit' }),
  ])
  expect(ticketDetail(viewsOf(h.runtime), ticket.id)).toMatchObject({
    mandate: { strength: 'explicit' },
    decision: { kind: 'accept' },
    threads: [expect.objectContaining({ key: threadKeyValue, title: '@bot 修一下回归' })],
    channels: [expect.objectContaining({ source: 'feishu' })],
  })
  const follow = h.feishu('20', '补充：日志在这里', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await h.receive(follow)
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 20).items).toEqual([
    expect.objectContaining({ key: threadKeyValue, lastAt: follow.at, tickets: [{ id: ticket.id, title: '修复回归', state: 'open' }] }),
  ])
  const detail = threadDetail(viewsOf(h.runtime), threadKeyValue, undefined, 50)!
  expect(detail.timeline.map((item) => item.id)).toEqual([trigger.id, follow.id])
  expect(detail.timeline[0]!.disposition).toMatchObject({ decision: { outcome: 'accept', ticketId: ticket.id } })
  expect(detail.timeline[1]!.disposition).toMatchObject({ fanout: [ticket.id] })
  expect(search(viewsOf(h.runtime), '日志在这里', new TextCache(0)).items).toEqual([
    expect.objectContaining({ id: follow.id, threads: [threadKeyValue], threadTitle: '@bot 修一下回归' }),
  ])
  expect(decisionList(viewsOf(h.runtime), ['accept'], 0, 10)).toEqual({
    items: [expect.objectContaining({ kind: 'accept', ticketId: ticket.id, threadTitle: '@bot 修一下回归' })],
    next_offset: null,
  })
  const thread = h.runtime.store.threads.get(threadKeyValue)!
  h.runtime.store.threads.describe(thread.key, { label: 'Named by its source' })
  expect(threadList(viewsOf(h.runtime), 'all', 0, 20).items[0]).toMatchObject({ title: 'Named by its source' })
})

it('removes thread subscriptions through the management API and keeps state focused on health', async () => {
  await h.acceptedTicket()
  const threadKeyValue = `feishu:${CHAT}:om_1`
  expect((await h.api('GET', 'state')).body).not.toHaveProperty('tickets')
  // scripts/dsh-superagent and agents read health from GET state (docs/006, Management API); settings and their revisions have their own route.
  expect((await h.api('GET', 'state')).body).toMatchObject({
    health: { runtime: { state: expect.any(String) } },
    paused: false,
    load: { maxWorkers: 3 },
  })
  expect((await h.api('GET', 'settings')).body).toMatchObject({
    sources: expect.arrayContaining([
      expect.objectContaining({ id: 'github', revision: expect.any(Number), value: expect.objectContaining({ enabled: true }) }),
    ]),
    blocks: { policy: { revision: expect.any(Number) } },
  })
  expect((await h.api('POST', `threads/${encodeURIComponent(threadKeyValue)}/unsubscribe`)).body).toMatchObject({ removed: true })
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 20).items).toEqual([])
  expect(h.agent.agents.get(h.runtime.masterId)!.inject).toHaveBeenCalled()
})

it('retries only a failed, blocked or undelivered ticket with a new assignment', async () => {
  const { ticket } = await h.acceptedTicket()
  expect(() => h.runtime.engine.retryTicket(ticket.id)).toThrow(new UserError('notRetryable'))
  const current = h.runtime.store.tickets.get(ticket.id)!
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'LlmError: offline' })
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(true)
  // A person may continue a failed worker in its Session; only an ended Ticket locks its tools.
  expect(h.agent.guards.get(`worker-${ticket.id}`)!()).toBeUndefined()
  const retried = await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.map((item) => item.state)).toEqual(['ended', 'running'])
  expect(retried.assignments.length).toBeGreaterThan(current.assignments.length)
  expect(retried.assignments.at(-2)!.endedReason).toBe('retried')
  // The worker's Session holds the assignment, so the new one says only that a person retried it.
  expect(h.relays(`worker-${ticket.id}`).at(-1)).toEqual({
    ticket_id: ticket.id,
    assignment: 2,
    note: expect.stringContaining('A person retried this ticket'),
  })
  // A Session someone deleted gets the whole first message again with the next Assignment.
  h.runtime.store.atomic(() => {
    h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'LlmError: offline' })
  })
  h.agent.agents.delete(`worker-${ticket.id}`)
  h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(h.relays(`worker-${ticket.id}`).at(-1)).toMatchObject({
    ticket_id: ticket.id,
    title: '修复回归',
    trigger: expect.objectContaining({ text: JSON.stringify({ kind: 'untrusted_trigger_text', text: '@bot 修一下回归' }) }),
  })
})

it('finds tickets by title and excludes decisions outside the requested window', async () => {
  const { ticket } = await h.acceptedTicket()
  expect(search(viewsOf(h.runtime), '修复', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(decisionList(viewsOf(h.runtime), [], 0, 10, '2999-01-01T00:00:00Z').items).toEqual([])
})

it('reports unavailable Evals as a problem until dismissal or a later judgement', async () => {
  await h.acceptedTicket()
  const accepted = h.runtime.store.read.recentDecisions(0, 1)[0]!
  h.runtime.store.decisions.save({
    ...accepted,
    id: 'unavailable-1',
    kind: 'unavailable',
    reason: [{ code: 'timeout' }],
    at: new Date().toISOString(),
  })
  const unjudged = () => overviewOf(h.runtime).problems.filter((problem) => problem.kind === 'eval-unavailable')
  expect(unjudged()).toEqual([
    expect.objectContaining({
      thread: expect.objectContaining({ key: accepted.threadKey }),
      reason: [{ code: 'timeout' }],
      triggerId: accepted.triggerIds[0],
    }),
  ])
  // Health shows it as an error for an hour, which `status` reports, and not as a runtime error on the overview.
  expect(evalsHealth(h.runtime.store)).toMatchObject({ state: 'error', detail: expect.stringContaining('Assessment timed out') })
  expect(evalsHealth(h.runtime.store, Date.now() + 3_700_000)).toMatchObject({ state: 'ready' })
  await h.runtime.pump()
  expect(h.runtime.health.evals).toMatchObject({ state: 'error' })
  expect(overviewOf(h.runtime).problems.filter((problem) => problem.kind === 'runtime-error')).toEqual([])
  // A person's dismissal removes it without a new judgement; only unavailable Evals can be dismissed.
  expect(await h.api('POST', `decisions/${accepted.id}/dismiss`)).toMatchObject({
    status: 404,
    body: { error: 'Unavailable Eval not found', code: 'unknownProblem' },
  })
  expect(await h.api('POST', 'decisions/unavailable-1/dismiss')).toEqual({ status: 200, body: { dismissed: true } })
  expect(unjudged()).toEqual([])
  expect(evalsHealth(h.runtime.store)).toMatchObject({ state: 'ready' })
  expect(h.runtime.store.decisions.get('unavailable-1')).toMatchObject({ dismissed: true })
  h.runtime.store.decisions.save({ ...h.runtime.store.decisions.get('unavailable-1')!, dismissed: undefined })
  expect(unjudged()).toHaveLength(1)
  // A later judgement on the same Thread resolves it.
  h.runtime.store.decisions.save({
    ...accepted,
    id: 'ignore-2',
    kind: 'ignore',
    reason: [said('context only')],
    at: new Date().toISOString(),
  })
  expect(unjudged()).toEqual([])
})

it('links Channels and Threads for people, finds tickets by a bare PR number, and keeps ended subscriptions out of the default Thread filter', async () => {
  const { ticket } = await h.acceptedTicket(
    h.feishu('1', '@_user_1 修一下回归', { mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'dsh-superagent' }] })
  )
  const home = `feishu:${CHAT}:om_1`
  expect(h.runtime.store.triggers.get(key('feishu', 'om_1'))!.text).toBe('@dsh-superagent 修一下回归')
  const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`
  expect(ticketDetail(viewsOf(h.runtime), ticket.id)!.channels).toEqual([expect.objectContaining({ source: 'feishu', url: chatLink })])
  expect(threadDetail(viewsOf(h.runtime), home, undefined, 10)!.url).toBe(chatLink)
  // A pull request the Ticket opened is a Thread it follows as its own.
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, follows: [{ thread: 'github:4996', own: true }] })
  expect(search(viewsOf(h.runtime), '4996', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 10).items.map((thread) => thread.key)).toEqual([home])
  h.runtime.engine.stopTicket(ticket.id)
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 10).items).toEqual([])
  expect(threadList(viewsOf(h.runtime), 'all', 0, 10).items.map((thread) => thread.key)).toContain(home)
  await h.receive(h.feishu('9', '别的群的消息', { chat_id: 'oc_elsewhere' }))
  expect(search(viewsOf(h.runtime), '别的群', new TextCache(0)).items).toEqual([
    expect.objectContaining({ filtered: { code: 'chat_not_allowed' }, threadTitle: undefined }),
  ])
})

it("counts every step of the day's flow over the same arriving messages and lists the same accepted Decisions", async () => {
  const now = String(Date.now())
  await h.acceptedTicket(h.feishu('1', '@bot 修一下回归', { create_time: now }))
  await h.receive(h.feishu('7', '另一个群', { chat_id: 'oc_elsewhere', create_time: now }))
  const since = new Date(Date.now() - 86_400_000).toISOString()
  expect(overviewOf(h.runtime).flow).toMatchObject({ received: 2, filtered: 1, triggers: 1, judged: 1, accepted: 1 })
  expect(decisionList(viewsOf(h.runtime), ['accept', 'reopen'], 0, 10, since).items).toHaveLength(1)
  expect(decisionList(viewsOf(h.runtime), ['accept', 'reopen'], 0, 10, new Date(Date.now() + 60_000).toISOString()).items).toEqual([])
})

it('finds triggers by #PR number, GitHub link prefix and Feishu message id', async () => {
  const comment = commentTrigger(
    {
      id: 4,
      body: 'please check',
      user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-4',
      created_at: '2026-09-09T00:00:00Z',
    },
    { number: 9, isPr: true },
    'conversation',
    'agent-bot'
  )
  await h.receive(comment)
  expect(search(viewsOf(h.runtime), '#9', new TextCache(0)).threads).toEqual([expect.objectContaining({ key: 'github:9' })])
  expect(search(viewsOf(h.runtime), 'https://github.com/acme/widgets/pull/9', new TextCache(0)).items.map((item) => item.id)).toContain(
    comment.id
  )
  const message = h.feishu('30', '随便说说', { mentions: [] })
  await h.receive(message)
  expect(search(viewsOf(h.runtime), 'https://x/y?id=om_30', new TextCache(0)).items.map((item) => item.id)).toContain(message.id)
})

it('lists Tickets that wait on a person with where to answer them, as the overview does', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '按钮用哪种颜色？' })
  expect(ticketList(viewsOf(h.runtime), 'person', 0, 20).items).toEqual([
    expect.objectContaining({ id: ticket.id, stage: 'person', reply: expect.objectContaining({ source: 'feishu' }) }),
  ])
})
