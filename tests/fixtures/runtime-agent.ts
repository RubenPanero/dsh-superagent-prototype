import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { vi, type Mock } from 'vitest'
type RegisteredTool = {
  name: string
  output: { render: (args: unknown, result: unknown) => unknown }
  execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
}
type Section = { name: string; text: (context: { signal?: AbortSignal }) => string; interpolate?: boolean }
type Guard = (execution?: { name: string; arguments: unknown }) => string | undefined
type Agent = {
  id: string
  status: string
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
}
type Controller = Record<'create' | 'selectModel' | 'resolveAgent' | 'rename' | 'prompt' | 'inspect', Mock>
/** Isolated agent registry with scoped tools, inboxes and delivery observations. */
export class RuntimeAgents {
  readonly agents = new Map<string, Agent>()

  readonly tools = new Map<string, Map<string, RegisteredTool>>()

  readonly sections = new Map<string, Section>()

  readonly guards = new Map<string, Guard>()

  readonly restricts = new Map<string, unknown[]>()

  readonly deliveries: Mock<(request: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }) => void> =
    vi.fn<(request: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }) => void>()

  readonly inherited = [
    'bash',
    'read',
    'read_image',
    'skill',
    'job_output',
    'job_list',
    'job_kill',
    'grep',
    'web_search',
    'ask_user_question',
    'plugin_manager',
    'schedule_create',
    'create_goal',
    'session_create',
    'session_send_message',
    'feishu_doc_edit',
  ]

  private registerTools(context: Context, sessionId: string, preset: object) {
    const sessionTools = new Map<string, RegisteredTool>()
    this.tools.set(sessionId, sessionTools)
    context.reflect.provide('tools', {
      register: (tool: RegisteredTool) => {
        sessionTools.set(tool.name, tool)
        return () => sessionTools.delete(tool.name)
      },
      get: (name: string, scope?: object) => {
        const own = scope === this.agents.get(sessionId)
        return ((scope === preset || own) && this.inherited.includes(name)) || (own && name === 'subagent') ? { name } : undefined
      },
      restrict: vi.fn((rule: { allow: string[] }) => {
        if (rule.allow.some((name) => !this.inherited.includes(name))) throw new Error('Restriction names a non-inherited tool')
        this.restricts.set(sessionId, [...(this.restricts.get(sessionId) ?? []), rule])
        return () => {}
      }),
      guard: vi.fn((check: Guard) => {
        this.guards.set(sessionId, check)
        return () => {}
      }),
    })
  }

  private inbox() {
    const nextTurn: UserMessage[] = [],
      nextStep: UserMessage[] = []
    return {
      nextTurn,
      nextStep,
      remove: (id: string) =>
        [nextTurn, nextStep].some((list) => {
          const at = list.findIndex((message) => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }),
    }
  }

  private async create({ sessionId, agentPreset }: { sessionId: string; agentPreset?: unknown }) {
    if (this.agents.has(sessionId)) return
    const context = new Context(),
      preset = {}
    this.registerTools(context, sessionId, preset)
    context.reflect.provide('skills', { register: () => () => {} })
    context.reflect.provide('systemPrompt', {
      section: (spec: Section) => {
        this.sections.set(sessionId, spec)
        return () => {}
      },
    })
    const messages = this.inbox()
    const modelEvents: { type: string; data: unknown }[] = []
    const deliver = (mode: 'queue' | 'steer') =>
      vi.fn((message: UserMessage) => {
        messages[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        this.deliveries({
          sessionId,
          mode,
          id: message.id,
          text: message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
        })
        const agent = this.agents.get(sessionId)
        if (!agent) throw new Error('Delivery target is not registered')
        agent.status = 'running'
      })
    const agent = {
      id: sessionId,
      ctx: context,
      inbox: messages,
      followup: deliver('queue'),
      steer: deliver('steer'),
      status: 'idle',
      inject: vi.fn(),
      session: {
        id: sessionId,
        header: { agentPreset },
        snapshotEvents: () => modelEvents,
        requestHeader: () => undefined,
        append: vi.fn((type: string, data: unknown) => {
          modelEvents.push({ type, data })
        }),
      },
      cancel: vi.fn(),
      whenIdle: async () => {},
    }
    this.agents.set(sessionId, agent)
    bindScopeParent(agent, preset)
  }

  readonly controller: Controller = {
    create: vi.fn(this.create.bind(this)),
    selectModel: vi.fn(async () => {}),
    resolveAgent: vi.fn(async (id: string) =>
      this.agents.has(id) ? { agent: this.agents.get(id) } : { error: { code: 'session/not-found' } }
    ),
    rename: vi.fn(async () => {}),
    prompt: vi.fn(() => {
      throw new Error('Plugin delivery must not use user RPC')
    }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
}
