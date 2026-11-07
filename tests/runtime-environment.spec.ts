import { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { SCHEMA_VERSION } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { githubKind } from '../src/sources/github.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { RuntimeHarness, type Accounts } from './fixtures/runtime.ts'
import { overviewOf } from './fixtures/runtime-views.ts'
import { GIT_HELPERS as HELPERS } from './fixtures/deployment.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it("waits for setup without the agent's GitHub CLI: the panel works, and nothing is polled, assessed or dispatched", async () => {
  const { ticket, sessionId } = await h.acceptedTicket()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'crashed' })
  expect(() => h.runtime.checkSetup()).toThrow('Setup is complete')
  h.agent.controller.create.mockClear()
  h.agent.deliveries.mockClear()
  const next = await h.restart({}, { github: { cli: '' } })
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toEqual({ place: 'github', code: 'agentCliUnset', values: {}, detail: 'The agent GitHub CLI is not set.' })
  expect(next.health.runtime).toMatchObject({ state: 'paused', code: 'setupPending' })
  expect(() => next.deployment).toThrow('dsh-superagent is waiting for setup: The agent GitHub CLI is not set.')
  expect((await h.api('GET', 'state')).body).toMatchObject({
    setup: { problem: { place: 'github' }, accounts: null, machine: { stateDir: h.directory } },
  })
  expect(overviewOf(next).problems[0]).toEqual({ kind: 'setup', ...next.setupProblem })
  await h.receive(h.feishu('30', '@bot 修一下'), next)
  // A retry waits for setup instead of launching a worker that cannot run, and no report reaches the orchestrator.
  await next.engine.retryTicket(ticket.id)
  expect(next.store.tickets.get(ticket.id)!.assignments.map((item) => item.state)).toEqual(['ended', 'pending'])
  expect(h.agent.controller.create).not.toHaveBeenCalled()
  expect(h.agent.deliveries).not.toHaveBeenCalled()
  // A save that changes nothing records nothing; any other save runs setup again, since it may be the fix, and so does a
  // check after a fix outside dsh-superagent.
  const revision = next.store.get<number>('settings-revision')
  expect(await next.settings.save('policy', next.store.settings().policy, next.store.blockRevision('policy'), 'panel')).toMatchObject({
    saved: true,
    restarting: false,
  })
  expect(next.store.get<number>('settings-revision')).toBe(revision)
  expect(
    await next.settings.save('policy', { ...next.store.settings().policy, rules: [] }, next.store.blockRevision('policy'), 'panel')
  ).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(1))
  next.checkSetup()
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(2))
})

it('reports each setup problem where the operator fixes it, and checks the agent CLI the way worker shells run it', async () => {
  const needs = async (place: string, code: string, values: Record<string, string>, accounts: Accounts = {}) => {
    const next = await h.restart({}, accounts)
    await next.ready
    expect(next.setupProblem).toMatchObject({ place, code, values })
  }
  h.answers[`${h.clis.agent} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] =
    '{"name":"acme/widgets","push":false}\n'
  await needs('github', 'repositoryReadOnly', { account: 'agent-bot', repository: 'acme/widgets' })
  h.answers[`${h.clis.agent} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] =
    '{"name":"acme/widgets","push":true}\n'
  // The agent CLI runs in the workers' environment: without the shims on PATH.
  const check = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).find((argv) => argv.includes(h.clis.agent))!
  expect(check[0]).toBe('env')
  expect(check[1]!.startsWith('PATH=')).toBe(true)
  expect(check[1]!.slice('PATH='.length).split(':')).not.toContain(join(h.directory, 'worker-bin'))
  const valid = { ...h.answers }
  // git older than 2.32 ignores GIT_CONFIG_GLOBAL and reads the operator's configuration.
  h.answers = { ...valid, [HELPERS]: 'file:/home/me/.gitconfig\0!gh auth git-credential\0' }
  await needs('deployment', 'gitTooOld', {})
  await needs('github', 'repositoryUnset', {}, { github: { repository: '' } })
  // A broken Feishu bot leaves Feishu out and says why; GitHub work goes on.
  h.answers = { ...valid, [`${h.clis.bot} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await h.restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.deployment.feishu).toBeUndefined()
  expect(next.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it("reports a failure to write the agent environment as environmentFailed and leaves this process's environment as it was", async () => {
  await h.runtime.stop()
  // The shim directory cannot be made: a file has its name.
  rmSync(join(h.directory, 'worker-bin'), { recursive: true, force: true })
  writeFileSync(join(h.directory, 'worker-bin'), '')
  const environment = { ...process.env }
  const next = await h.restart()
  await next.ready
  expect(next.setupProblem).toMatchObject({
    place: 'deployment',
    code: 'environmentFailed',
    values: { output: expect.stringContaining('EEXIST') },
  })
  expect(process.env).toEqual(environment)
})

it('runs setup again while the Feishu bot check failed, and restores the process environment when git fails its check', async () => {
  h.answers[`${h.clis.bot} config strict-mode`] = 'strict-mode: off (source: profile)'
  const next = await h.restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.feishuProblem?.code).toBe('feishuUserIdentity')
  next.checkSetup()
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(1))
  h.answers[HELPERS] = 'file:/home/me/.gitconfig\0!gh auth git-credential\0'
  const broken = await h.restart()
  await broken.ready
  expect(broken.setupProblem).toMatchObject({ place: 'deployment', code: 'gitTooOld' })
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(join(h.directory, 'worker-bin'))
})

it('writes worker shims and the agent environment from the configuration only, and restores the environment on stop', async () => {
  const bin = join(h.directory, 'worker-bin')
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
  expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain(`exec '${h.clis.bot}'`)
  h.runtime.store.saveSettings({
    ...h.runtime.store.settings(),
    executor: { ...h.runtime.store.settings().executor, blockedCommands: ['personal-gh'] },
  })
  const next = await h.restart({}, { feishu: null })
  await next.ready
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
  expect(readFileSync(join(bin, 'personal-gh'), 'utf8')).toContain(
    'personal-gh is blocked in this installation; use gh, which acts as agent-bot.'
  )
  expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
  expect(readFileSync(join(bin, 'gh'), 'utf8')).toContain(`exec '${h.clis.agent}'`)
  expect(readFileSync(workerGitConfig(h.directory), 'utf8')).toContain(
    `[credential "https://github.com"]\n\thelper = "${credentialHelper(h.clis.agent)}"`
  )
  expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(h.directory), GIT_CONFIG_NOSYSTEM: '1' })
  expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(process.env.PATH?.split(':')[0]).toBe(bin)
  await next.stop()
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(bin)
})

it('waits for setup when the shim directory holds a file dsh-superagent did not write, and leaves the file alone', async () => {
  writeFileSync(join(h.directory, 'worker-bin', 'my-script'), '#!/bin/sh\n')
  const next = await h.restart()
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toMatchObject({
    place: 'deployment',
    code: 'foreignFile',
    values: { file: join(h.directory, 'worker-bin', 'my-script') },
  })
  expect(readFileSync(join(h.directory, 'worker-bin', 'my-script'), 'utf8')).toBe('#!/bin/sh\n')
  await next.stop()
})

it('rewrites the blocked-command shims when the Executor settings change them, without a restart', async () => {
  const bin = join(h.directory, 'worker-bin')
  const save = (blockedCommands: string[]) =>
    h.runtime.settings.save(
      'executor',
      { ...h.runtime.store.settings().executor, blockedCommands },
      h.runtime.store.blockRevision('executor'),
      'panel'
    )
  expect(await save(['personal-gh'])).toMatchObject({ saved: true, restarting: false })
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
  await save([])
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
  // The commands workers need cannot be blocked.
  await expect(save(['gh'])).rejects.toThrow()
  expect(h.restarts).not.toHaveBeenCalled()
})

it('runs a GitHub-only deployment: the GitHub part of the Policy decides alone, and the Feishu part has nothing to sync', async () => {
  const next = await h.restart({}, { feishu: null })
  await next.ready
  expect(next.health).not.toHaveProperty('feishu')
  expect(next.health).not.toHaveProperty('sync:feishu')
  const problems = () => overviewOf(next).problems
  const unregister = next.sources.register(githubKind)
  expect(next.health.github).toEqual({ state: 'starting', detail: '' })
  const policy = next.store.settings().policy
  await next.settings.save('policy', { ...policy, sources: {} }, next.store.blockRevision('policy'), 'panel')
  expect(problems()).toContainEqual({ kind: 'no-allowed' })
  await next.settings.save(
    'policy',
    { ...policy, sources: { github: { allowed: [{ id: 'bob' }] } } },
    next.store.blockRevision('policy'),
    'panel'
  )
  expect(next.store.settings().policy.sources).toEqual({ github: { allowed: [{ id: 'bob' }], admission: {} } })
  expect(problems()).not.toContainEqual({ kind: 'no-allowed' })
  await expect(
    next.settings.save(
      'policy',
      { ...next.store.settings().policy, sources: { github: { allowed: [{ name: 'Nobody' }] } } },
      next.store.blockRevision('policy'),
      'panel'
    )
  ).rejects.toThrow()
  await expect(next.settings.sync('feishu')).rejects.toThrow('nothing to sync from')
  unregister()
  expect(next.health).not.toHaveProperty('github')
})

it('refuses a second process on the same state directory before it opens the database, so it migrates nothing', () => {
  // A database the running build would read as schema 10 stays as it is.
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(h.services)) ctx.reflect.provide(name, service)
  expect(() => new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())).toThrow(/already being held/)
  expect(h.runtime.store.get(KV.store.schema)).toBe(10)
  h.runtime.store.set(KV.store.schema, SCHEMA_VERSION)
})

it('releases the database and the state directory lock when it fails to start, so it can start again in this process', async () => {
  await h.runtime.stop()
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='99' WHERE key='schema'").run()
  db.close()
  const context = () => {
    const ctx = new Context()
    for (const [name, service] of Object.entries(h.services)) ctx.reflect.provide(name, service)
    return ctx
  }
  expect(() => new Runtime(context(), testMachine({ stateDir: h.directory }), vi.fn())).toThrow(
    'Unsupported orchestrator database version 99'
  )
  const fixed = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  fixed.prepare('UPDATE kv SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema')
  fixed.close()
  // A lock kept by the failed start would make this throw that the lock is already held.
  h.runtime = new Runtime(context(), testMachine({ stateDir: h.directory }), vi.fn())
  await h.runtime.ready
  expect(h.runtime.store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
})
