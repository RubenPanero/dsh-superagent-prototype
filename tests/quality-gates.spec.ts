import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, LC_ALL: 'C', PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` }
let directory: string
let base: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
const commit = () => git('-c', 'user.name=Quality', '-c', 'user.email=quality@example.invalid', 'commit', '-qm', 'Fixture')
const check = () =>
  spawnSync(process.execPath, ['scripts/check-format.mjs'], {
    cwd: directory,
    env: { ...env, QUALITY_BASE: base },
    encoding: 'utf8',
  })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'quality-gates-'))
  mkdirSync(join(directory, 'scripts'))
  mkdirSync(join(directory, 'src'))
  for (const file of ['package.json', 'tsconfig.json', 'biome.json', '.jscpd.json', 'scripts/check-format.mjs']) {
    copyFileSync(join(root, file), join(directory, file))
  }
  // Existing source is deliberately not canonical Biome layout.
  writeFileSync(join(directory, 'src/legacy.ts'), 'export const legacy=1;\n')
  git('init', '-q')
  git('add', '.')
  commit()
  base = git('rev-parse', 'HEAD')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('preserves existing layout while rejecting new whitespace errors', () => {
  expect(check().status).toBe(0)
  writeFileSync(join(directory, 'src/legacy.ts'), 'export const legacy=2;  \n')
  const result = check()
  expect(result.status).not.toBe(0)
  expect(result.stdout + result.stderr).toContain('trailing whitespace')
})

it.each(['untracked', 'staged', 'committed'])('checks formatting of %s new source files', (state) => {
  writeFileSync(join(directory, 'src/new.ts'), 'export const answer=42;\n')
  if (state !== 'untracked') git('add', 'src/new.ts')
  if (state === 'committed') commit()
  const result = check()
  expect(result.status).not.toBe(0)
  expect(result.stdout + result.stderr).toContain('Formatter would have printed')
  writeFileSync(join(directory, 'src/new.ts'), 'export const answer = 42\n')
  expect(check().status).toBe(0)
})

it('fails closed when the comparison base does not exist', () => {
  base = 'refs/heads/does-not-exist'
  const result = check()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('unknown revision')
})
