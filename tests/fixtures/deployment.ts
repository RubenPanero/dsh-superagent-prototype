/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach } from 'vitest'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'

let stateDir: string | undefined
const fixtureDirectory = () => (stateDir ??= mkdtempSync(join(tmpdir(), 'dsh-superagent-test-')))
afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  stateDir = undefined
})

export const GIT_HELPERS = 'git config -z --show-origin --get-all credential.https://github.com.helper'
const GIT_SCOPED = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'

/** Synthetic account executables and their startup-probe responses. */
export function runtimeAccounts(directory: string) {
  const agent = join(directory, 'agent-gh'),
    other = join(directory, 'other-gh'),
    bot = join(directory, 'lark-bot')
  return {
    agent,
    other,
    bot,
    answers: {
      [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
      [`git -C ${directory} remote get-url --push origin`]: 'https://github.com/acme/widgets.git\n',
      [`${agent} api user`]: '{"login":"agent-bot","id":7}',
      [`${agent} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
      [`${other} api user`]: '{"login":"agent-bot","id":7}',
      [`${other} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
      [`${bot} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
      [`${bot} config strict-mode`]: 'strict-mode: bot (source: profile)',
      [`${bot} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
      [GIT_HELPERS]: `file:${workerGitConfig(directory)}\0${credentialHelper(agent)}\0`,
      [GIT_SCOPED]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(agent)}\0`,
    },
  }
}

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return {
    get: () => current as never,
    set: (next) => {
      current = next
    },
  }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: overrides.stateDir ?? fixtureDirectory(),
  promptMaxChars: reference(100000),
  admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000),
  ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(),
  repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
