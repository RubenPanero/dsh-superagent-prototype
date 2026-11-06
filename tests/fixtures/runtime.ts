import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { Runtime } from '../../src/app/runtime.ts'
import { jobRegistry } from './host.ts'
import { runtimeAccounts, testMachine } from './deployment.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { Commands } from '../../src/infra/commands.ts'
import { threadKey, type Trigger } from '../../src/core/index.ts'
import { RuntimeAgents } from './runtime-agent.ts'

export const MEMBER = 'ou_alice',
  CHAT = 'oc_team',
  worktreeName = 'fix-regression'
export interface Accounts {
  github?: Record<string, unknown>
  feishu?: Record<string, unknown> | null
}
type HttpHandler = (req: unknown, res: unknown) => Promise<void>

/** A complete application on an isolated DSH host, shared by subsystem integration suites. */
export class RuntimeHarness {
  runtime!: Runtime
  readonly directory = mkdtempSync(join(tmpdir(), 'orchestrator-runtime-'))
  readonly clis = runtimeAccounts(this.directory)
  readonly agent = new RuntimeAgents()
  answers: Record<string, string | Error> = { ...this.clis.answers }
  readonly restarts = vi.fn<() => void>()
  jobs = jobRegistry()
  services: Record<string, unknown> = {}
  http!: HttpHandler

  readonly subprocess = {
    spawn: vi.fn((spec: { argv: readonly string[] }) => {
      const argv = [...spec.argv]
      while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
      const answer = this.answers[argv.join(' ')] ?? ''
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return {
        done: Promise.resolve({ exitCode: answer instanceof Error ? 1 : 0, signal: null }),
        collected: { stdout: reader(answer instanceof Error ? '' : answer), stderr: reader(answer instanceof Error ? answer.message : '') },
      }
    }),
  }

  private seed(store: Store, accounts: Accounts = {}) {
    const settings = store.settings()
    const { feishu: _feishu, ...others } = settings.sources
    const feishu = accounts.feishu === null ? undefined : { ...settings.sources.feishu?.config, cli: this.clis.bot, ...accounts.feishu }
    store.saveSettings(
      SettingsSchema.parse({
        ...settings,
        sources: {
          ...others,
          github: { enabled: true, config: { repository: 'acme/widgets', cli: this.clis.agent, ...accounts.github } },
          ...(feishu ? { feishu: { enabled: true, config: feishu } } : {}),
        },
      })
    )
  }

  private commands() {
    vi.spyOn(Commands.prototype, 'gh').mockImplementation(async (args) => {
      if (args[1] === 'user') return { login: 'agent-bot' }
      if (args[1]?.includes('/pulls/'))
        return {
          state: 'open',
          user: { login: 'agent-bot' },
          html_url: 'https://github.com/acme/widgets/pull/' + args[1].split('/').at(-1),
          head: {
            ref: `agent/${String(this.runtime.store.tickets.list()[0]?.execution?.name)}`,
            sha: 'head-1',
            repo: { full_name: 'acme/widgets' },
          },
        }
      return { default_branch: 'master', permissions: { push: true } }
    })
    vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
    vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  }

  async start() {
    this.commands()
    this.services = {
      agents: this.agent.agents,
      llm: { resolveCallConfig: vi.fn(async (value) => value) },
      sessionController: this.agent.controller,
      sessionPersistence: {
        flush: vi.fn(async () => {}),
        open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })),
      },
      workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
      permissionPresets: { set: () => {} },
      subprocess: this.subprocess,
      webServer: {
        host: '127.0.0.1',
        port: 3082,
        register: (route: { handler: HttpHandler }) => {
          this.http = route.handler
          return () => {}
        },
      },
      jobs: this.jobs.service,
    }
    for (const cli of [this.clis.agent, this.clis.other, this.clis.bot]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    const store = new Store(join(this.directory, 'orchestrator.sqlite'))
    this.seed(store)
    store.close()
    this.runtime = new Runtime(this.context(), testMachine({ stateDir: this.directory }), this.restarts)
    await this.runtime.ready
    this.runtime.sources.register(feishuKind)
    this.runtime.sources.register(githubKind)
    const settings = this.runtime.store.settings()
    this.runtime.store.saveSettings({
      ...settings,
      policy: {
        ...settings.policy,
        sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } },
      },
      eval: { ...settings.eval, mode: 'auto' },
      sources: {
        github: { enabled: true, config: { repository: 'acme/widgets', cli: this.clis.agent } },
        feishu: { enabled: true, config: { cli: this.clis.bot, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } },
      },
    })
    this.agent.deliveries.mockClear()
  }

  private context() {
    const context = new Context()
    for (const [name, service] of Object.entries(this.services)) context.reflect.provide(name, service)
    return context
  }

  async stop() {
    expect(this.agent.controller.prompt).not.toHaveBeenCalled()
    await this.runtime?.stop()
    vi.restoreAllMocks()
    rmSync(this.directory, { recursive: true, force: true })
  }

  async restart(machine: Parameters<typeof testMachine>[0] = {}, accounts: Accounts = {}) {
    await this.runtime.stop()
    const store = new Store(join(this.directory, 'orchestrator.sqlite'))
    this.seed(store, accounts)
    store.close()
    this.runtime = new Runtime(this.context(), testMachine({ stateDir: this.directory, ...machine }), this.restarts)
    return this.runtime
  }

  async api(method: string, path: string): Promise<{ status: number; body: unknown }> {
    let status = 0,
      text = ''
    await this.http(
      { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } },
      {
        writeHead: (code: number) => {
          status = code
        },
        end: (data: string) => {
          text = data
        },
      }
    )
    return { status, body: JSON.parse(text) }
  }

  async runTool(sessionId: string, name: string, args: unknown) {
    const tool = this.agent.tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    const output = await tool.execute(args, { signal: new AbortController().signal })
    expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output)
    await this.runtime.idle()
    return output as Record<string, unknown>
  }

  subscribe(ticketId: string, ref: { source: string; id: string }) {
    const key = threadKey(ref)
    const thread = this.runtime.store.threads.get(key) ?? {
      key,
      ref,
      createdAt: '',
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    }
    this.runtime.store.threads.save({ ...thread, subscriptions: [...new Set([...thread.subscriptions, ticketId])] })
  }

  async receive(trigger: Trigger, target = this.runtime) {
    const result = target.receive(trigger)
    await target.idle()
    return result
  }

  relays(sessionId: string) {
    return this.agent.deliveries.mock.calls
      .map(([call]) => call)
      .filter((call) => call.sessionId === sessionId)
      .map((call) => {
        try {
          return JSON.parse(call.text) as Record<string, unknown>
        } catch {
          return { text: call.text } as Record<string, unknown>
        }
      })
  }

  feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
    const trigger = feishuTrigger(
      {
        message_id: `om_${id}`,
        chat_id: CHAT,
        chat_type: 'group',
        sender_id: MEMBER,
        sender_type: 'user',
        content: text,
        create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000),
        mentions: [{ id: 'ou_bot' }],
        ...overrides,
      },
      'ou_bot',
      'cli_bot'
    )
    if (!trigger) throw new Error('Fixture message did not produce a trigger')
    return trigger
  }

  async route(item: Record<string, unknown>) {
    const { results } = (await this.runTool(this.runtime.masterId, 'orchestrator_route', { decisions: [item] })) as {
      results: Record<string, unknown>[]
    }
    const [first] = results
    if (!first) throw new Error('Router returned no decision')
    if (first.refused) throw new Error(String(first.refused))
    return first
  }

  async acceptedTicket(trigger = this.feishu('1', '@bot 修一下回归')) {
    await this.receive(trigger)
    expect(this.relays(this.runtime.masterId).some((item) => item.trigger_id === trigger.id)).toBe(true)
    const result = await this.route({
      kind: 'accept',
      trigger_id: trigger.id,
      title: '修复回归',
      worktree_name: worktreeName,
      acknowledgement: '收到，修复回归。',
    })
    const ticket = this.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)
    if (!ticket) throw new Error('Accepted ticket was not stored')
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
}
