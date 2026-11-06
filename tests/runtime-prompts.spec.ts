import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { mandateInstructions } from '../src/executor/dsh.ts'
import { masterPrompt } from '../src/app/context.ts'
import { reference } from './fixtures/deployment.ts'
import { policyVersion } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import { RuntimeHarness, MEMBER, CHAT } from './fixtures/runtime.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('assesses a proactive observation in the orchestrator Session and creates the ticket only on a positive auto-mode decision', async () => {
  const observe = (mode: 'observe' | 'auto') =>
    h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode }, h.runtime.store.blockRevision('eval'), 'panel')
  await observe('observe')
  const trigger = h.feishu('3', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await h.receive(trigger)
  const candidate = h.relays(h.runtime.masterId).at(-1)!
  expect(candidate).toMatchObject({
    kind: 'candidate',
    strength: 'inferred',
    mode: 'observe',
    next_action: expect.stringContaining('orchestrator_eval'),
  })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_3', chat_id: CHAT }] })
  const details = await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  // The rules are in the main Session's Policy section; the context names the Policy version it was built from.
  expect(details).not.toHaveProperty('rules')
  expect(details).toMatchObject({
    trigger_id: trigger.id,
    strength: 'inferred',
    policy_version: policyVersion(h.runtime.store.settings()),
    thread: expect.objectContaining({ complete: true, loaded_messages: 0 }),
  })
  const decision = (id: string) => ({
    trigger_id: id,
    decision: 'accept',
    title: '文案修订',
    worktree_name: 'copy-fix',
    scope: '改副标题',
    reason: 'explicit copy change',
    intent_evidence: 'quoted',
    acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [
      { rule_id: 'copy', matched: true, reason: 'copy change' },
      { rule_id: 'visual', matched: false, reason: 'not visual' },
    ],
    direction: {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: 'the message names the replacement',
    },
  })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', decision(trigger.id))).toMatchObject({
    decision: 'ignore',
    reason: expect.stringContaining('Observe mode'),
  })
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_3`)[0]!.audit).toMatchObject({
    would_accept: true,
    proposal: { title: '文案修订' },
  })
  await observe('auto')
  const again = h.feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await h.receive(again)
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: again.id })
  const accepted = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', decision(again.id))
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.mandate).toMatchObject({
    strength: 'inferred',
    basis: expect.objectContaining({ via: 'admission', rules: ['copy'], observation: { mode: 'auto' } }),
  })
  expect(h.runtime.store.replyStatus(key('ack', again.id))).toBeDefined()
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({
    text: expect.stringContaining('Proactively accepted under copy'),
  })
})

it('accepts silently under a rule that says so, gives the worker the rule procedure, and closes it as dropped when nothing is left for a human', async () => {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save(
    'policy',
    {
      ...policy,
      rules: [
        ...policy.rules,
        { id: 'silent-bugfix', name: '沉默地复现和修复', enabled: true, instruction: 'Reproduce minimally first; accept silently.' },
      ],
    },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  await h.runtime.settings.save(
    'eval',
    { ...h.runtime.store.settings().eval, mode: 'auto' },
    h.runtime.store.blockRevision('eval'),
    'panel'
  )
  const trigger = h.feishu('20', '切换主题后刷新，图标颜色不对', { mentions: [] })
  await h.receive(trigger)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_20', chat_id: CHAT }] })
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  const accepted = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
    trigger_id: trigger.id,
    decision: 'accept',
    title: '主题图标颜色',
    worktree_name: 'theme-icon-color',
    scope: 'bug',
    reason: 'reported defect',
    intent_evidence: 'quoted',
    rule_assessments: [
      { rule_id: 'copy', matched: false, reason: 'no' },
      { rule_id: 'visual', matched: false, reason: 'no' },
      { rule_id: 'silent-bugfix', matched: true, reason: 'bug report' },
    ],
    direction: {
      implementation_requested: true,
      target_basis: 'existing-standard',
      requires_design_decision: false,
      evidence: 'expected colour is the light palette',
    },
  })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(h.runtime.store.replyStatus(key('ack', trigger.id))).toBeUndefined()
  await h.runtime.idle()
  expect(h.agent.sections.get(`worker-${ticket.id}`)!.text({})).toContain(mandateInstructions({ strength: 'inferred' }))
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({
    text: expect.stringContaining('沉默地复现和修复 (silent-bugfix): Reproduce minimally first; accept silently.'),
  })
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow(
    'not ready'
  )
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'blocked', summary: 'needs a decision' })
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow(
    'not ready'
  )
  // Nothing left for a human: the ticket closes instead of waiting, and the rule's closing sentence can still be delivered.
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'dropped', summary: 'too complex; recorded in #123' })
  expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'dropped' }) })
  expect(
    await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      purpose: 'result',
      text: '看到这个问题我试了一下，能复现，修复需要较大改动，已记在 #123。',
    })
  ).toEqual({ status: 'sent' })
})

it('tells live workers about policy changes instead of revoking them and restarts in-flight assessments', async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  const pending = h.feishu('8', '新观察', { mentions: [], sender_id: MEMBER, root_id: undefined })
  await h.receive(pending)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_8`)?.evaluating).toBeDefined()
  h.agent.deliveries.mockClear()
  const settings = h.runtime.store.settings()
  const result = await h.runtime.settings.save(
    'policy',
    { ...settings.policy, rules: settings.policy.rules.map((rule) => ({ ...rule, enabled: rule.id === 'copy' })) },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  await h.runtime.idle()
  expect(result).toMatchObject({ saved: true, policy_changed: true })
  // The rules changed, but not as they bear on this explicit ticket, whose requester is still allowed: its worker is not woken.
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([])
  expect(h.relays(sessionId)).toEqual([])
  // Its requester comes off the allowed list: the worker is told so, inline, and the ticket goes on.
  const current = h.runtime.store.settings().policy
  await h.runtime.settings.save(
    'policy',
    { ...current, sources: { ...current.sources, feishu: { ...current.sources.feishu!, allowed: [] } } },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([
    expect.objectContaining({ kind: 'policy-changed', effect: { requesterAllowed: false, requester: { source: 'feishu', id: MEMBER } } }),
  ])
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(h.relays(sessionId)).toEqual([{ text: expect.stringContaining('may no longer start work') }])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_8`)[0]).toMatchObject({
    kind: 'unavailable',
    reason: [{ code: 'policyChanged' }],
  })
  expect(h.relays(h.runtime.masterId).filter((item) => item.kind === 'candidate' && item.trigger_id === pending.id)).toHaveLength(1)
})

it('refuses an accept through orchestrator_route for inferred candidates so proactive work always goes through Eval', async () => {
  const observed = h.feishu('21', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await h.receive(observed)
  await expect(
    h.route({ kind: 'accept', trigger_id: observed.id, title: 'x', worktree_name: 'copy-fix', acknowledgement: 'x' })
  ).rejects.toThrow('explicit requests from allowed senders')
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it("tells both roles the execution environment through a generated prompt section, and each worker its own ticket's", async () => {
  const preview = h.runtime.prompts.preview(h.runtime.prompts.current().config)
  const section = preview.parts.worker.at(-1)!
  expect(section.name).toBe('runtime/environment')
  for (const line of [
    '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets"',
    '- DSH_SUPERAGENT_GITHUB_ACCOUNT = "agent-bot"',
    '- DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL = "7+agent-bot@users.noreply.github.com"',
  ])
    expect(section.text).toContain(line)
  expect(section.text).not.toContain('MERGE_ACCOUNT')
  // Outside a ticket there is no ticket directory.
  expect(section.text).not.toContain('DSH_SUPERAGENT_DIR')
  // The main Session's Policy section follows it.
  expect(preview.orchestrator).toContain(`${section.text}\n\n## Policy`)
  const { ticket, sessionId } = await h.acceptedTicket()
  expect(h.agent.sections.get(sessionId)!.text({})).toContain(`- DSH_SUPERAGENT_DIR = ${JSON.stringify(ticket.execution!.directory)}`)
  expect(h.agent.sections.get(h.runtime.masterId)!.text({})).not.toContain('DSH_SUPERAGENT_DIR')
  const next = await h.restart({}, { feishu: null })
  await next.ready
  expect(Object.keys(next.prompts.preview(next.prompts.current().config).skills)).not.toContain('feishu')
})

it('lets a worker read the prompt version it works under and the ones it worked under before, also after a restart, and no other', async () => {
  const { sessionId } = await h.acceptedTicket()
  const save = () => {
    const { config, revision } = h.runtime.prompts.current()
    return h.runtime.prompts.save({ ...config, delivery: `${config.delivery}.` }, revision, 'panel').revision
  }
  // A model request reads the system prompt, which binds the Session to the version current then.
  const request = () => h.agent.sections.get(sessionId)!.text({ signal: new AbortController().signal })
  const read = (resource: string) => h.runTool(sessionId, 'orchestrator_read', { resource })
  const first = save(),
    second = save()
  expect(request()).not.toBe('')
  await expect(read(`prompts/${first}`)).rejects.toThrow('inaccessible prompt version')
  const third = save()
  // Until its next request it works under the version it read; after it, it may still read that one.
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${second}` })
  expect(request()).not.toBe('')
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${third}` })
  expect(await read(`prompts/${second}`)).toMatchObject({ resource: `prompts/${second}` })
  expect(h.runtime.sessions.status().sessions).toContainEqual({ sessionId, revision: third })
  const next = await h.restart()
  await next.ready
  expect([
    next.sessions.promptVersion(sessionId).revision,
    next.sessions.mayRead(sessionId, second),
    next.sessions.mayRead(sessionId, first),
  ]).toEqual([third, true, false])
})

it('passes team text with template braces to every Session literally, without reading them as prompt variables', async () => {
  const delivery = 'Pin the build to ${{ github.sha }}; keep {{x}} as written.'
  const current = h.runtime.prompts.current()
  h.runtime.prompts.save({ ...current.config, delivery }, current.revision, 'panel')
  const { sessionId } = await h.acceptedTicket()
  for (const id of [h.runtime.masterId, sessionId]) {
    const section = h.agent.sections.get(id)!
    const text = renderPrompt({
      sections: [{ name: section.name, text: section.text({}), interpolate: section.interpolate }],
      contexts: [],
      tools: [],
      variables: {},
    })
    expect(text).toContain(delivery)
  }
})

it("leaves auto-merge to the delivery requirements, with the agent's own gh and the line threshold", async () => {
  const { ticket } = await h.acceptedTicket()
  expect(h.runtime.ticketEnvironment(ticket).map((variable) => variable.key)).not.toContain('DSH_SUPERAGENT_GITHUB_MERGE_ACCOUNT')
  expect(ticket.mandate).not.toHaveProperty('autoMergeLineLimit')
  const delivery = h.runtime.prompts.current().config.delivery
  expect(delivery).toContain('it changes fewer than 200 lines (additions plus deletions);')
  // Auto-merge is never enabled as the agent account; only a merge CLI the section names enables it.
  expect(delivery).toContain('Never enable auto-merge as the agent account')
  expect(delivery).toContain('<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha>')
  expect(h.runtime.prompts.preview(h.runtime.prompts.current().config).worker).not.toContain('gh-merge')
})

it('credits each human reviewer once in the default delivery requirements on every commit of the PR, never with an empty commit', async () => {
  const delivery = h.runtime.prompts.current().config.delivery
  expect(delivery).toContain('Co-authored-by: <name or login> <id+login@users.noreply.github.com>')
  expect(delivery).toContain('on every commit of the PR branch')
  expect(delivery).toContain('git filter-branch -f --msg-filter')
  expect(delivery).toContain('Never push an empty commit to credit a reviewer.')
  expect(delivery).toContain('Do not credit bots')
})

it('applies a changed prompt size limit to the next save and request without a restart', async () => {
  const limit = reference(100000)
  const next = await h.restart({ promptMaxChars: limit })
  await next.ready
  const put = async (config: unknown) => {
    let status = 0,
      text = ''
    const chunks = [Buffer.from(JSON.stringify({ config, baseRevision: next.prompts.current().revision }))]
    const req = {
      method: 'PUT',
      url: '/orchestrator/api/prompts',
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    await h.http(req, {
      writeHead: (code: number) => {
        status = code
      },
      end: (data: string) => {
        text = data
      },
    })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  const config = next.prompts.current().config
  const size = JSON.stringify(config).length
  expect(await put({ ...config, delivery: 'x'.repeat(size) })).toMatchObject({ status: 200 })
  // The loader commits a lower limit in place; the next save reads it.
  limit.set(size + 1000)
  expect(await put({ ...config, delivery: `${config.delivery}${'y'.repeat(2000)}` })).toMatchObject({
    status: 400,
    body: { code: 'promptTooLong', values: { limit: String(size + 1000) } },
  })
  // So does the request body limit, four bytes a character and a margin.
  const bytes = 4 * (size + 1000) + 4096
  expect(await put({ ...config, delivery: 'z'.repeat(bytes) })).toMatchObject({
    status: 400,
    body: { error: `Request exceeds ${bytes} bytes` },
  })
  expect(h.restarts).not.toHaveBeenCalled()
})

it('refuses the main Session a bash command that runs sleep and a long job wait, as reports arrive by themselves, and no worker', async () => {
  const bash = (command: string) => ({ name: 'bash', arguments: { command, description: 'x' } })
  const main = h.agent.guards.get(h.runtime.masterId)!
  for (const command of [
    'sleep 60; echo done',
    'cd x && sleep 5',
    'gh pr checks 7 || sleep 30',
    'echo a\nsleep 90',
    'while true; do sleep 30; done',
    '(sleep 5)',
    '/bin/sleep 240',
    'while sleep 30; do gh pr checks 7; done',
    'if sleep 5; then gh pr view 7; fi',
    '{ sleep 60; }',
    '! sleep 5',
    'nohup sleep 60',
    'exec sleep 60',
    'time sleep 60',
    'until sleep 1; do :; done',
    'command sleep 5',
    'env sleep 5',
  ])
    expect(main(bash(command)), command).toMatch(/^Reports, follow_up notices, new candidates and a background job's end/)
  // A command that names sleep as data, not at a command position, runs.
  for (const command of ['gh api repos/acme/widgets/pulls', 'echo "sleep"', 'grep sleep file', 'sleeper --help', 'command -v sleep'])
    expect(main(bash(command)), command).toBeUndefined()
  // A command that asks to hold the step longer than 30 seconds, however it waits, under any preset.
  const timed = (command: string, args: { timeoutMs?: number; run_in_background?: boolean } = {}) => ({
    name: 'bash',
    arguments: { command, description: 'x', ...args },
  })
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 120_000 }))).toMatch(/^Reports/)
  expect(main(timed("python3 -c 'import time;time.sleep(240)'", { timeoutMs: 600_000 }))).toMatch(/^Reports/)
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  // Under the router preset, the shell moves a command without a timeout to a background job after 5 seconds, and a job
  // wait without one ends after 5 seconds too; a longer job wait waits for nothing that arrives that way.
  expect(main(timed('gh pr checks 7 --watch'))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 30_000 } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j' } })).toBeUndefined()
  // A main Session created before runs under standard, whose shell waits 60 seconds by default and whose job waits last 30:
  // a command without a timeout runs in the background or names one, and a job wait names one.
  ;(h.agent.agents.get(h.runtime.masterId) as unknown as { session: { header: { agentPreset: string } } }).session.header = {
    agentPreset: 'standard',
  }
  expect(main(timed('gh pr checks 7 --watch'))).toMatch(/^This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000/)
  expect(main(timed('gh pr checks 7 --watch', { run_in_background: true }))).toBeUndefined()
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  // A worker waits for its own work as it needs.
  const { sessionId } = await h.acceptedTicket()
  expect(h.agent.guards.get(sessionId)!(bash('sleep 60'))).toBeUndefined()
  // The main Session's role says so.
  expect(masterPrompt).toContain(
    "Worker reports, follow_up notices, new candidates and a background job's end, with its output, arrive by themselves as messages"
  )
})

it("reads the main Session's preset from a registry with or without presetForSession, and takes standard's caps when it cannot", async () => {
  const watch = { name: 'bash', arguments: { command: 'gh pr checks 7 --watch', description: 'x' } }
  const route = { name: 'orchestrator_route', arguments: { decisions: [] } }
  const guard = async (registry: Record<string, unknown>, projections?: Record<string, unknown>) => {
    h.services.agentPresets = registry
    if (projections) h.services.sessionProjections = projections
    else delete h.services.sessionProjections
    await (await h.restart()).ready
    return h.agent.guards.get(h.runtime.masterId)!
  }
  // A released DSH's registry has no presetForSession: the projection says standard, so standard's caps apply, and the
  // other tools run.
  let main = await guard(
    { select: vi.fn() },
    { stateOf: vi.fn((_session: unknown, key: string) => (key === 'agentPreset' ? 'standard' : undefined)) }
  )
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // Without the projection either, the preset it was created with counts: the router preset.
  main = await guard({ select: vi.fn() })
  expect([main(route), main(watch)]).toEqual([undefined, undefined])
  // The registry says standard though the Session was created with the router preset: standard's caps apply.
  main = await guard({ select: vi.fn(), presetForSession: () => 'standard' })
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // A registry that fails is read as standard, the safer caps, and the guard does not throw.
  main = await guard({
    select: vi.fn(),
    presetForSession: () => {
      throw new Error('no projection')
    },
  })
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
})

it("gives an explicit ticket's worker a prompt without the limits of an inferred Mandate", async () => {
  const { sessionId } = await h.acceptedTicket()
  await h.runtime.idle()
  expect(h.agent.sections.get(sessionId)!.text({})).not.toContain(mandateInstructions({ strength: 'inferred' }))
})

it("creates an Executor Session under the bundle's worker preset, and the main Session under its router preset", async () => {
  const { sessionId } = await h.acceptedTicket()
  const created = h.agent.controller.create.mock.calls.map(([options]) => options as { sessionId: string; agentPreset: string })
  expect(created.find((options) => options.sessionId === sessionId)).toMatchObject({ agentPreset: 'dsh-superagent-worker' })
  expect(created.find((options) => options.sessionId === h.runtime.masterId)).toMatchObject({ agentPreset: 'dsh-superagent-router' })
})

it('selects its own preset again for a main Session or worker a person switched before its first turn, and not after it', async () => {
  const { sessionId } = await h.acceptedTicket()
  // DSH's preset registry, which takes a selection only before a Session's first turn.
  const started = new Set<string>()
  const presets = {
    select: vi.fn(async (agent: { id: string }, preset: string) => {
      if (started.has(agent.id)) throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
      return preset
    }),
  }
  h.services.agentPresets = presets
  await (await h.restart()).ready
  const emit = (sessionId: string, preset: string) =>
    (h.runtime as unknown as { ctx: Context }).ctx.emit('agent-preset/selected', sessionId, preset)
  // A person opened the blank main Session in DSH's Web UI, which selected the default preset for it.
  emit(h.runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(h.agent.agents.get(h.runtime.masterId), 'dsh-superagent-router'))
  // Its own preset, which that selection announces the same way, is left alone.
  presets.select.mockClear()
  emit(h.runtime.masterId, 'dsh-superagent-router')
  await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  emit(sessionId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(h.agent.agents.get(sessionId), 'dsh-superagent-worker'))
  // Another Session is not one of dsh-superagent's.
  presets.select.mockClear()
  emit('someone-else', 'standard')
  emit('worker-nothing', 'standard')
  await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  // After its first turn the registry refuses any selection, which changes nothing and is not an error.
  started.add(h.runtime.masterId)
  emit(h.runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledTimes(1))
  await expect(presets.select.mock.results[0]!.value).rejects.toMatchObject({ code: 'agent-preset/locked' })
})

it("gives a subagent of a worker only the worker's work tools, and none once the ticket ended", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  // DSH creates the subagent under the standard preset, with the worker's Session as its parent.
  await (h.agent.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-1' })
  const child = h.agent.agents.get('child-1')! as unknown as { session: { header: { parentSession?: string } } }
  child.session.header = { parentSession: sessionId }
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: child } as never)
  expect(h.agent.restricts.get('child-1')).toEqual([
    { allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] },
  ])
  expect(h.agent.guards.get('child-1')!()).toBeUndefined()
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.agent.guards.get('child-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
  // Another Session's subagent is left as it is.
  await (h.agent.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-2' })
  const other = h.agent.agents.get('child-2')! as unknown as { session: { header: { parentSession?: string } } }
  other.session.header = { parentSession: 'someone-else' }
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: other } as never)
  expect(h.agent.restricts.get('child-2')).toBeUndefined()
})

it("gives a subagent of a worker's subagent the same work tools and guard", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  const create = h.agent.controller.create as (options: { sessionId: string }) => Promise<void>
  const created = (h.runtime as unknown as { ctx: Context }).ctx
  for (const [id, parent] of [
    ['child-1', sessionId],
    ['grandchild-1', 'child-1'],
  ] as const) {
    await create({ sessionId: id })
    const agent = h.agent.agents.get(id)! as unknown as { session: { header: { parentSession?: string } } }
    agent.session.header = { parentSession: parent }
    await created.parallel('agent/created', { agent } as never)
  }
  expect(h.agent.restricts.get('grandchild-1')).toEqual([
    { allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] },
  ])
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.agent.guards.get('grandchild-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
})

it("ends the main Session's prompt with its Policy section, each rule on one line, and says orchestrator_eval holds no rules", async () => {
  const settings = h.runtime.store.settings()
  const rules = settings.policy.rules.map((rule) =>
    rule.id === 'copy' ? { ...rule, name: 'Copy\nfixes', instruction: 'Fix typos.\n- Keep the tone.\n\n## Not a heading' } : rule
  )
  await h.runtime.settings.save('policy', { ...settings.policy, rules }, h.runtime.store.blockRevision('policy'), 'panel')
  const prompt = (h.agent.sections.get(h.runtime.masterId)!.text as (context: object) => string)({})
  const policy = prompt.slice(prompt.indexOf('## Policy'))
  // Nothing follows the section, whose lines after its head are exactly the enabled rules.
  expect(policy.trimEnd().split('\n').slice(2)).toEqual(
    h.runtime.store
      .settings()
      .policy.rules.filter((rule) => rule.enabled)
      .map((rule) =>
        rule.id === 'copy'
          ? '- Copy fixes (copy): Fix typos. - Keep the tone. ## Not a heading'
          : `- ${rule.name} (${rule.id}): ${rule.instruction}`
      )
  )
  expect(prompt.indexOf('## Policy')).toBeGreaterThan(prompt.indexOf('Execution environment'))
  expect((h.agent.tools.get(h.runtime.masterId)!.get('orchestrator_eval') as unknown as { description: string }).description).not.toMatch(
    /rules/
  )
})

it('keeps the current Policy after admission in the main Session prompt', () => {
  const prompt = () => (h.agent.sections.get(h.runtime.masterId)!.text as (context: object) => string)({})
  const policy = () => {
    const text = prompt(),
      at = text.indexOf('## Policy')
    return text.slice(at, text.indexOf('\n\n', at))
  }
  const settings = h.runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  expect(prompt().indexOf('## Policy')).toBeGreaterThan(prompt().indexOf('Assess proactive candidates yourself'))
  expect(
    policy()
      .split('\n')
      .filter((item) => item.startsWith('- '))
  ).toEqual(settings.policy.rules.filter((rule) => rule.enabled).map(line))
  expect(policy()).toContain(`Policy version ${policyVersion(settings)}; accept mode ${settings.eval.mode}.`)
  // The rules govern proactive candidates only; read beside an explicit request, they must not be taken to refuse it.
  expect(policy()).toContain(
    'The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.'
  )
})

it('uses the latest Policy save in the next prompt and explains when all proactive rules are disabled', async () => {
  const policy = () => {
    const text = h.agent.sections.get(h.runtime.masterId)!.text({})
    const at = text.indexOf('## Policy')
    return text.slice(at, text.indexOf('\n\n', at))
  }
  const settings = h.runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  const rules = settings.policy.rules.map((rule) =>
    rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep it short.` } : { ...rule, enabled: false }
  )
  await h.runtime.settings.save('policy', { ...settings.policy, rules }, h.runtime.store.blockRevision('policy'), 'panel')
  const saved = h.runtime.store.settings()
  expect(policy()).toContain(`Policy version ${policyVersion(saved)}`)
  expect(
    policy()
      .split('\n')
      .filter((item) => item.startsWith('- '))
  ).toEqual(rules.filter((rule) => rule.enabled).map(line))
  // With no rule enabled, a proactive candidate can only be ignored.
  await h.runtime.settings.save(
    'policy',
    { ...saved.policy, rules: rules.map((rule) => ({ ...rule, enabled: false })) },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  expect(policy()).toContain('No rule is enabled: a proactive candidate can only be ignored.')
  expect(policy()).toContain('The accept mode and the rules decide proactive candidates only')
})
