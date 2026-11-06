import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { Commands } from '../src/infra/commands.ts'
import { key, runningAssignment, threadKey, type Trigger } from '../src/core/index.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { observePull } from '../src/sources/github-pull.ts'
import { RuntimeHarness, CHAT } from './fixtures/runtime.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('treats GitHub comments through the same gate: mentions by members are explicit, others need an existing task', async () => {
  const stranger = commentTrigger(
    {
      id: 1,
      body: 'looks wrong',
      user: { login: 'someone' },
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-1',
      created_at: '2026-09-09T00:00:00Z',
    },
    { number: 7, isPr: true },
    'conversation',
    'agent-bot'
  )
  await h.receive(stranger)
  expect(h.runtime.store.decisions.byThread('github:7')).toEqual([
    expect.objectContaining({ kind: 'ignore', reason: [expect.objectContaining({ code: 'not_a_member' })] }),
  ])
  const mention = commentTrigger(
    {
      id: 2,
      body: '@agent-bot please fix',
      user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-2',
      created_at: '2026-09-09T00:01:00Z',
    },
    { number: 7, isPr: true },
    'conversation',
    'agent-bot'
  )
  await h.receive(mention)
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: mention.id })
  const result = await h.route({
    kind: 'accept',
    trigger_id: mention.id,
    title: 'Fix PR 7',
    worktree_name: 'fix-pr',
    acknowledgement: 'On it: fixing the review finding.',
  })
  const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.channels).toEqual([expect.objectContaining({ source: 'github', address: expect.objectContaining({ number: '7' }) })])
  // The PR's head is a variable of the ticket's execution environment; a prepare command may fetch it.
  expect(Object.fromEntries(h.runtime.ticketEnvironment(ticket).map((variable) => [variable.key, variable.value]))).toMatchObject({
    DSH_SUPERAGENT_GITHUB_NUMBER: '7',
    DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/7/head',
    DSH_SUPERAGENT_FEISHU_CHAT: '',
  })
  const ci = { ...stranger, id: 'ci-1', human: false, text: 'GitHub PR #7 CI: failing', meta: { ci: true } }
  await h.receive(ci)
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ triggerId: 'ci-1' })])
})

it("relays an allowed sender's mention in a new Issue as an explicit candidate from the poll that reads its notification", async () => {
  const issue = {
    id: 1012,
    number: 12,
    title: 'Login fails',
    body: '@agent-bot please fix the login',
    state: 'open',
    created_at: '2026-09-09T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/12',
    user: { login: 'alice', type: 'User' },
  }
  const notification = {
    id: 'n1',
    updated_at: issue.created_at,
    reason: 'mention',
    repository: { full_name: 'acme/widgets' },
    subject: { url: 'https://api.github.com/repos/acme/widgets/issues/12', type: 'Issue', title: issue.title },
  }
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
  vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
  vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
  h.runtime.store.set('github-since', '2026-09-08T23:59:00.000Z')
  await pollRound(h.runtime.context(githubKind))
  await h.runtime.idle()
  const candidate = h.relays(h.runtime.masterId).at(-1)
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: key('github-issue', '12'), thread: 'github:12' })
})

it("ignores an allowed sender's new Issue that does not mention the agent, and an unlisted sender's mention, from the poll that reads them", async () => {
  const poll = async (number: number, body: string, login: string) => {
    const issue = {
      id: 1000 + number,
      number,
      title: 'Login fails',
      body,
      state: 'open',
      created_at: '2026-09-09T00:00:00Z',
      html_url: `https://github.com/acme/widgets/issues/${number}`,
      user: { login, type: 'User' },
    }
    const notification = {
      id: `n${number}`,
      updated_at: issue.created_at,
      reason: 'subscribed',
      repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${number}`, type: 'Issue', title: issue.title },
    }
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
    vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
    vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
    h.runtime.store.set('github-since', '2026-09-08T23:59:00.000Z')
    await pollRound(h.runtime.context(githubKind))
    await h.runtime.idle()
    await h.runtime.idle()
    return key('github-issue', String(number))
  }
  const quiet = await poll(12, 'The login page fails after the update', 'alice')
  expect(h.runtime.store.decisions.byThread('github:12')).toEqual([
    expect.objectContaining({ kind: 'ignore', reason: [{ code: 'no_mention', triggerId: quiet }] }),
  ])
  const stranger = await poll(13, '@agent-bot please fix the login', 'mallory')
  expect(h.runtime.store.decisions.byThread('github:13')).toEqual([
    expect.objectContaining({ kind: 'ignore', reason: [{ code: 'not_a_member', triggerId: stranger }] }),
  ])
  expect(h.relays(h.runtime.masterId).filter((item) => item.kind === 'candidate')).toEqual([])
})

it('keeps Issue Triggers stored before Issues arrived through notifications readable on their Thread', async () => {
  const stored: Trigger = {
    id: key('github-issue', '5'),
    source: 'github-issue',
    threads: [{ source: 'github', id: '5' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: '2026-09-01T00:00:00Z',
    text: 'Bug\n\ndetails',
    url: 'https://github.com/acme/widgets/issues/5',
    meta: { number: 5, isPr: false, eligibleAt: '2026-09-02T00:00:00.000Z' },
  }
  h.runtime.store.triggers.save(stored)
  h.runtime.store.threads.save({
    key: 'github:5',
    ref: { source: 'github', id: '5' },
    createdAt: stored.at,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
  })
  const read = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${stored.id}` })
  expect(read).toMatchObject({ trigger_id: stored.id, source: 'github-issue', text: 'Bug\n\ndetails' })
  const thread = (await h.api('GET', 'threads/github:5')).body
  expect(thread).toMatchObject({ timeline: [expect.objectContaining({ id: stored.id, source: 'github-issue' })] })
})

it("lets an Executor drop only its own ticket from a thread it finds unrelated, but not the thread it started on or its pull request's", async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket()
  const other = await h.acceptedTicket(h.feishu('5', '@bot 另一件事'))
  // An attached thread that turns out to be about something else, which another ticket also follows.
  const attached = { source: 'feishu', id: 'oc_side:om_side' }
  h.subscribe(ticket.id, attached)
  h.subscribe(other.ticket.id, attached)
  const inject = h.agent.agents.get(h.runtime.masterId)!.inject
  vi.mocked(inject).mockClear()
  expect(
    await h.runTool(sessionId, 'orchestrator_thread_unrelated', {
      thread: 'feishu:oc_side:om_side',
      reason: 'It discusses the login page, not this regression.',
    })
  ).toEqual({ removed: true, thread: 'feishu:oc_side:om_side' })
  expect(h.runtime.store.threads.get('feishu:oc_side:om_side')!.subscriptions).toEqual([other.ticket.id])
  await vi.waitFor(() => expect(JSON.stringify(vi.mocked(inject).mock.calls)).toContain('thread_unrelated'))
  await expect(
    h.runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'again' })
  ).rejects.toThrow('does not follow that thread')
  await expect(
    h.runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(trigger.threads[0]!), reason: 'no' })
  ).rejects.toThrow('the ticket started on')
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  await expect(h.runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'github:7', reason: 'no' })).rejects.toThrow('pull request')
  // A worker drops only its own ticket: the other ticket's thread is not one this ticket follows.
  await expect(
    h.runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(other.trigger.threads[0]!), reason: 'no' })
  ).rejects.toThrow('does not follow that thread')
})

it('tells the conversation that the PR merged when work a restart recovered ends with it later', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  // The host restarted with the worker mid-work: its Assignment starts again with a recovery note.
  const before = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.engine.assignmentInterrupted(ticket.id, runningAssignment(before)!.id)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
  // The PR merged before the restart; the recovered work goes on, and nothing is said yet.
  const merged = {
    number: 42,
    state: 'closed',
    merged: true,
    merged_at: before.assignments[0]!.createdAt,
    html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' },
    head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } },
  }
  await observePull(h.runtime.context(githubKind), merged)
  expect(h.runtime.store.tickets.get(ticket.id)).not.toHaveProperty('ended')
  const id = key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged')
  expect(h.runtime.store.replyStatus(id)).toBeUndefined()
  // Its ready report ends the ticket with the PR, and the conversation hears of the merge once.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Recovered and verified' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'merged' })
  expect(h.runtime.store.replyStatus(id)).toBeDefined()
  // The report that ended the ticket was the worker's own: its turn is not cancelled inside that tool call.
  expect(h.agent.agents.get(sessionId)!.cancel).not.toHaveBeenCalled()
})
