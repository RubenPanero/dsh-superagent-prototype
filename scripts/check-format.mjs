import { execFileSync, spawnSync } from 'node:child_process'

// Preserve legacy source layout; require canonical formatting for new files and tooling.
const base = process.env.QUALITY_BASE || 'HEAD'
const added = execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=A', base], { encoding: 'utf8' })
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
const source = [...new Set((added + untracked).split('\0'))].filter((path) => /^(src|tests)\/.*\.tsx?$/.test(path))
const files = ['package.json', 'tsconfig.json', 'biome.json', '.jscpd.json', 'scripts/check-format.mjs', ...source]
const format = spawnSync('biome', ['format', ...files], { stdio: 'inherit' })
if (format.error) throw format.error
if (format.status !== 0) process.exit(format.status ?? 1)
// Include staged and unstaged edits locally, and the complete branch diff in CI.
execFileSync('git', ['diff', '--check', base], { stdio: 'inherit' })
