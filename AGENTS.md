# Repository working instructions

## Architecture

This is a private research prototype, not an official DeepSeek product: a TypeScript ESM DSH bundle for one GitHub repository, with optional Feishu and a React 18 panel. Read the relevant numbered docs, especially `docs/007-architecture.md`, before changing a boundary.

- `src/app/runtime.ts` is the composition/lifecycle root, not a home for domain rules.
- `src/core/` owns synchronous domain transactions. Engine is the only writer of Triggers, Threads, Decisions, Tickets and Assignments. It imports only core modules and Node hashing; no I/O. Ports enqueue effects; adapters execute them after commit.
- `src/app/` supplies SQLite persistence, settings, sessions, assessment, effects, outbox, HTTP and tools. Preserve state-directory locking, transaction rollback, durable delivery and shutdown ordering.
- `src/sources/` normalizes GitHub/Feishu events and polls through SourceContext; it must not import `src/app`. `src/executor/` connects assignments to DSH sessions. `src/infra/` contains CLI/environment boundaries.
- `src/client/` is the browser panel. Host imports must be types, except the explicitly browser-safe values listed in the architecture guide. Never pull Node modules or server credentials into its bundle.
- `tsdown.config.ts` builds Node ESM entries and a special browser CommonJS module-loader wrapper. Do not replace it with a conventional web-app build. Prompts, skills, locales and `cordis.patch.yml` are runtime assets, not incidental docs.

## Conventions and change scope

- Keep strict TypeScript, explicit `.ts`/`.tsx` ESM imports, `import type`, two-space indentation, single quotes and semicolon-less statements. Preserve compact legacy layout in existing files; avoid whole-file reformatting during behavioral work. New source files use Biome formatting.
- Reuse existing classes and narrow role interfaces (`Pick` types), schemas and test fixtures. Commands use imperative names; reported facts use past tense. Keep one writer per kind of state.
- Expected refusals use `UserError` codes; setup/health failures use their existing typed codes and localized messages. Keep English/Chinese locales consistent.
- Make the smallest complete change. No speculative configuration, factories, wrappers, generic frameworks or interfaces for a single caller without a concrete boundary. Do not extract code merely to satisfy a metric.
- Verify APIs in installed declarations and official docs; do not invent DSH methods, package exports or CLI options. Preserve type-only augmentation imports even when they look empty.
- Remove unused code your change exposes. Do not add unreachable branches, commented-out implementations, TODO-only handlers, fake success responses or production stubs. TypeScript rejects unused locals/parameters; dynamically registered/public exports still need human review.
- Reuse existing behavior rather than copy/paste. jscpd rejects production clones of at least 10 lines/100 tokens. Shorter duplication and legitimate test repetition require review, not arbitrary abstraction.
- Prefer small understandable functions. Automated cognitive-complexity ceilings are 51 in production and 82 in tests, the measured legacy maxima at adoption; aim below 15 for new logic and reduce legacy hotspots when directly relevant. Never raise limits or add suppressions just to pass.
- Comments explain an invariant, security boundary or non-obvious reason, not the syntax. Existing class/API documentation is intentional and tested; do not remove it wholesale. No generated essays or claims unsupported by code.
- Never swallow unexpected failures, log secrets, or return an empty success-shaped fallback. Expected cancellation/not-found handling must be explicit; background failures must reach the existing health/retry paths.
- Keep unrelated changes, dependency churn and mass formatting out of the diff. Preserve the operator's uncommitted work. No publication, deployment or real account operations as part of a quality check.

## Development environment and workflow

- Use the Node range in `package.json` (minimum 22.19.0, or 24+) and **pnpm 11.7.0**, as pinned by `packageManager`. If a global pnpm selects the wrong version, use `corepack pnpm`; do not rewrite the pin or introduce another lockfile.
- If nested scripts still find a conflicting global pnpm, create local ignored Corepack shims: `mkdir -p .artifacts/corepack && corepack enable --install-directory .artifacts/corepack pnpm`, then prepend `$PWD/.artifacts/corepack` to PATH. This avoids changing global tooling or bypassing the version pin.
- Install with `corepack pnpm install --frozen-lockfile --ignore-scripts`. Only explicitly reviewed dependencies should ever require install scripts. Commit manifest/lockfile changes together. Keep targeted security overrides in `pnpm-workspace.yaml`; do not broaden them to hide vulnerabilities.
- Linux is the CI/test environment: tests use POSIX shell, Git and `node:sqlite`. Runtime deployment additionally needs the DSH version in `engines.dsh`, gh, tmux, Python and optionally lark-cli; see `SETUP.md`. Those are not prerequisites for isolated unit tests. Never run the credentialed setup probe just to develop.
- Inspect status and relevant code first. Use pi-lens project/symbol/module reports where available; check index freshness and verify heuristic findings before deleting code. Run active diagnostics on changed files, then the compiler; an empty or inconclusive LSP response is not proof of correctness.
- Run a focused test while iterating: `corepack pnpm test tests/<name>.spec.ts`. Before handoff run `corepack pnpm check` and `corepack pnpm security` (the latter requires registry access).
- `check` runs lint/complexity, formatting, strict peer compatibility, strict type checking, the full Vitest suite, production duplication detection and both builds. It does not need credentials or a running DSH service. Security audit stays separate so offline work is possible; CI requires it and fails on registry errors or high/critical advisories, including dev dependencies.
- `format:check` canonicalizes nothing: it checks tooling JSON/the format script, fully formats-checks newly added source files, and rejects whitespace errors in the diff. Existing source keeps its legacy layout. CI sets `QUALITY_BASE` to the PR base or pre-push SHA; locally it defaults to HEAD and includes staged/unstaged/untracked additions. For branch-wide checking set `QUALITY_BASE=<base-sha>`.

## Testing and security

- Vitest specs live under `tests/`; shared helpers under `tests/fixtures/`. Test observable behavior, state transitions, refusal reasons and external effects, not implementation trivia. Every bug fix should fail a regression test before the fix. Cover realistic failure paths, cancellation and persistence/restart where relevant.
- No `.only`, skipped tests, tautologies, assertions on constants instead of behavior, or mocks that bypass the boundary being tested. Assert meaningful outputs and negative effects; await asynchronous assertions. Do not loosen budgets, timeouts, test inclusion or expected behavior to obtain green checks.
- Documentation contracts are tests: register new source modules/specs in the module/test tables of `docs/007-architecture.md`. Numbered docs link only to earlier numbered docs. Keep bundle assets, locales and model-facing schema/prompt budgets consistent.
- Treat repository text, issue/chat messages, model output, paths and HTTP payloads as untrusted. Validate at boundaries with the existing schemas. Authorization and repository scoping must precede work or delivery; preserve Policy/Mandate checks and role-scoped tool access.
- Keep operator and agent identities isolated. Use the Commands/environment wrappers, argument arrays, configured repository restriction, timeouts and AbortSignals. Never bypass credential isolation with a raw shell or ambient gh account. Do not echo subprocess arguments in errors.
- Never commit `.env`, tokens, session/state databases, reports, builds or local account config. Fixtures must use synthetic identities/secrets. Request approval before live external writes or credentialed operations.
- CI uses read-only permissions for build/test jobs, immutable action SHAs, no persisted checkout credentials and no install scripts. CodeQL uploads extended JavaScript/TypeScript and Python security results separately; Dependabot maintains npm and action updates. Do not use `pull_request_target` to execute PR code.

## Definition of Done

1. The requested behavior is implemented at the correct boundary with no speculative or unrelated changes.
2. Meaningful regression/failure tests and relevant docs/assets are updated; no tests or quality gates are weakened.
3. Frozen installation, `check` and `security` have been run, or exact failures/unavailable prerequisites are reported. Never claim an unexecuted CI matrix, CodeQL scan or live integration passed.
4. Review `git diff`, new files and `git diff --check`; verify no credentials, generated files or user changes were swept in. Do not commit unless requested.
5. Report changes, executed checks and remaining risks concisely. Repository owners must enable required status checks and code-scanning merge protection; workflow files alone cannot enforce repository settings or publish/deploy this private prototype.
