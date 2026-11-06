import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { jobRegistry } from './fixtures/host.ts'
import { waitsForPerson } from '../src/core/index.ts'
import { RuntimeHarness, CHAT } from './fixtures/runtime.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('relaunches running assignments after a restart with a recovery note', async () => {
  const { ticket } = await h.acceptedTicket()
  h.runtime.executor.resume()
  const recovered = h.runtime.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map((item) => item.state)).toEqual(['ended', 'pending'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  h.agent.deliveries.mockClear()
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments[1]).toMatchObject({ state: 'running' })
  // The new Assignment's message says only what is new, as the Session holds the first; the launch's own pass delivers the
  // recovery note as it reads.
  expect(h.relays(`worker-${ticket.id}`)).toEqual([
    { ticket_id: ticket.id, assignment: 2 },
    { text: expect.stringContaining('host restarted') },
  ])
})

it('leaves waiting and blocked assignments alone after a restart and keeps blocked workers paused', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'need credentials' })
  h.runtime.executor.resume()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(true)
  const other = await h.acceptedTicket(h.feishu('12', '@bot 另一个', { root_id: undefined }))
  await h.runTool(other.sessionId, 'orchestrator_report', { state: 'progress', summary: 'midway' })
  h.runtime.executor.resume()
  expect(h.runtime.store.tickets.get(other.ticket.id)!.assignments.map((item) => item.state)).toEqual(['ended', 'pending'])
})

it("runs the prepare command once for a new ticket, under the execution root with the ticket's environment, and fails the ticket with its output", async () => {
  const prepare = (command: string) =>
    h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: command } })
  const runs = () =>
    h.subprocess.spawn.mock.calls
      .map(([spec]) => spec as { argv: string[]; cwd: string; env?: Record<string, string> })
      .filter((spec) => spec.argv[0] === 'sh')
  prepare('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"')
  const { ticket } = await h.acceptedTicket()
  expect(runs()).toEqual([
    expect.objectContaining({
      argv: ['sh', '-c', 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"'],
      cwd: join(h.directory, 'work'),
      env: expect.objectContaining({
        DSH_SUPERAGENT_DIR: ticket.execution!.directory,
        DSH_SUPERAGENT_NAME: ticket.execution!.name,
        DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets',
        DSH_SUPERAGENT_FEISHU_CHAT: CHAT,
      }),
    }),
  ])
  // A retry reuses the prepared directory.
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(runs()).toHaveLength(1)
  h.answers['sh -c exit 3'] = new Error('fatal: no such clone')
  prepare('exit 3')
  const failed = await h.acceptedTicket(h.feishu('9', '@bot 修一下标题'))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)).toMatchObject({
    report: expect.objectContaining({
      state: 'failed',
      summary: expect.stringContaining('The prepare command failed: fatal: no such clone'),
    }),
  })
  expect(waitsForPerson(h.runtime.store.tickets.get(failed.ticket.id)!)).toBe(true)
})

it('counts a ticket whose directory the host prepared before prepare commands existed as prepared', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  // A ticket from before prepare commands has its worktree.
  const stored = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...stored, execution: { ...stored.execution!, directory: h.directory } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: 'exit 1' } })
  h.subprocess.spawn.mockClear()
  await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === 'sh')).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.state).toBe('running')
})

it('restarts a worker that was mid-work when the host stopped with the recovery note, and records no end of its turn', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'halfway' })
  // Stopping cancels the worker's turn: it goes idle and reports the abort as an error, which a stopping host takes as no end.
  const agent = h.agent.agents.get(sessionId)! as { status: string; cancel: ReturnType<typeof vi.fn> }
  const stopping = (h.runtime as unknown as { ctx: Context }).ctx
  agent.cancel.mockImplementation(() => {
    agent.status = 'idle'
    stopping.emit('agent/status', { agent, status: 'idle' } as never)
    stopping.emit('agent/error', {
      agent,
      turn: 1,
      step: 1,
      error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    } as never)
  })
  const next = await h.restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map((item) => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.assignments[0]!.report).toMatchObject({ state: 'progress', summary: 'halfway' })
  expect(recovered.assignments.flatMap((item) => (item.report ? [item.report.state] : []))).toEqual(['progress'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('keeps the report of a blocked, failed or ready worker whose turn ends, and relays nothing more', async () => {
  for (const state of ['blocked', 'failed', 'ready'] as const) {
    const { ticket, sessionId } = await h.acceptedTicket(
      h.feishu(String(20 + ['blocked', 'failed', 'ready'].indexOf(state)), `@bot 修 ${state}`, { root_id: undefined })
    )
    await h.runTool(sessionId, 'orchestrator_report', { state, summary: `${state} report` })
    const relayed = h.relays(h.runtime.masterId).length
    const agent = h.agent.agents.get(sessionId)! as { status: string }
    agent.status = 'idle'
    ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state, summary: `${state} report` })
    expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
  }
})

it("relays the status-request hint when a worker's turn ends with no text and no report", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  const agent = h.agent.agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'waiting' }))
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({
    kind: 'worker_report',
    ticket: { ticket_id: ticket.id },
    state: 'waiting',
    summary: expect.stringContaining('orchestrator_ticket_request_status'),
  })
})

it('fails a ticket at once on a worker error that is not passing, and relays it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/error', {
    agent: h.agent.agents.get(sessionId),
    turn: 1,
    step: 1,
    error: new Error('Invalid tool schema'),
  } as never)
  await vi.waitFor(() =>
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({
      state: 'failed',
      summary: expect.stringContaining('Invalid tool schema'),
    })
  )
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'failed' })
})

it('retries a transient launch failure three times before failing its ticket', async () => {
  const original = h.agent.controller.resolveAgent.getMockImplementation()! as (id: string) => Promise<unknown>
  const later = async (now: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now })
    try {
      await h.runtime.pump()
      await h.runtime.idle()
    } finally {
      vi.useRealTimers()
    }
  }
  for (const [index, error] of [
    Object.assign(new Error('Service Unavailable'), { status: 503 }),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  ].entries()) {
    let tries = 0
    h.agent.controller.resolveAgent.mockImplementation(async (id: string) => {
      if (String(id).startsWith('worker-')) {
        tries++
        throw error
      }
      return original(id)
    })
    const { ticket } = await h.acceptedTicket(h.feishu(String(30 + index), `@bot 修 ${index}`, { root_id: undefined }))
    await h.runtime.idle()
    let now = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
      now += 5000 * 2 ** attempt + 1000
      await later(now)
    }
    expect(tries).toBe(4)
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
    h.agent.controller.resolveAgent.mockImplementation(original)
  }
})

it('fails a prepare command at once, then prepares again only after an explicit retry', async () => {
  const runs = () => h.subprocess.spawn.mock.calls.filter(([spec]) => (spec as { argv: string[] }).argv[0] === 'sh').length
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: 'exit 3' } })
  h.answers['sh -c exit 3'] = new Error('fatal: unable to access: The requested URL returned error: 503')
  const before = runs()
  const prepared = await h.acceptedTicket(h.feishu('40', '@bot 修 prepare', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)!.report).toMatchObject({
    state: 'failed',
    summary: expect.stringContaining('503'),
  })
  expect(runs()).toBe(before + 1)
  // A retry runs the prepare command again, for the directory it left empty was removed; resuming relaunches no failed launch.
  delete h.answers['sh -c exit 3']
  h.runtime.executor.resume()
  await h.runtime.idle()
  expect(runs()).toBe(before + 1)
  h.runtime.engine.retryTicket(prepared.ticket.id)
  await h.runtime.idle()
  expect(runs()).toBe(before + 2)
  expect(h.runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
})

it("launches a queued Assignment once when the host resumes, and gives a failed launch's slot back", async () => {
  h.runtime.store.saveSettings({
    ...h.runtime.store.settings(),
    executor: { ...h.runtime.store.settings().executor, maxWorkers: 1, prepare: 'exit 3' },
  })
  h.answers['sh -c exit 3'] = new Error('fatal: no such clone')
  const failed = await h.acceptedTicket(h.feishu('50', '@bot 修 一', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
  // The failed launch holds no slot: the next ticket launches in the only one.
  delete h.answers['sh -c exit 3']
  const next = await h.acceptedTicket(h.feishu('51', '@bot 修 二', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(next.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
  // A third waits for the slot; resuming queues its launch again, which runs once the slot frees.
  const queued = await h.acceptedTicket(h.feishu('52', '@bot 修 三', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'pending' })
  h.runtime.executor.resume()
  h.runtime.executor.resume()
  const launches = () => h.agent.deliveries.mock.calls.filter(([call]) => call.sessionId === queued.sessionId).length
  ;(h.agent.agents.get(next.sessionId)! as { status: string }).status = 'idle'
  await h.runtime.pump()
  await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' }))
  expect(launches()).toBe(1)
})

it('restarts a worker whose shell job the host stop ended with the recovery note, as a worker mid-work', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'running the tests' })
  // Its turn ended with a test run in the background, so it is busy, not waiting.
  h.jobs.run(sessionId)
  const agent = h.agent.agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress' })
  // The host stops, and its jobs end with it.
  h.jobs = jobRegistry()
  h.services.jobs = h.jobs.service
  const next = await h.restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map((item) => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('gives the Assignment a restart starts the messages the replaced one had delivered but no step took, once', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  // A follow-up reaches the worker mid-turn, and the process stops before a step took it: DSH disposes the worker's agent
  // with its inbox.
  await h.receive(h.feishu('2', '另外改一下按钮', { root_id: 'om_1' }))
  const sent = () =>
    h.agent.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId && call.text.includes('另外改一下按钮')).length
  expect(sent()).toBe(1)
  const inbox = (h.agent.agents.get(sessionId)! as unknown as { inbox: { nextTurn: unknown[]; nextStep: unknown[] } }).inbox
  inbox.nextTurn.length = 0
  inbox.nextStep.length = 0
  const next = await h.restart()
  await next.ready
  await next.idle()
  expect(next.store.tickets.get(ticket.id)!.assignments.map((item) => item.state)).toEqual(['ended', 'running'])
  expect(sent()).toBe(2)
})
