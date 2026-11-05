# Security validation — 2026-11-04

Baseline: `b1770d288c6d92a1e6abda4d889eef89923ce838`. Node 24.22.1, pnpm 11.7.0.

## Text formatting and the UI boundary

The four CodeQL findings point to the same presentation helper in `src/app/views/text.ts`, not four independent HTML sinks. Two stripping passes could reconstruct a tag or comment after the last pass. For example, expanding every `<` in `<script>alert(1)</script>` to `<<x>` twice left the original script markup in the output. Reducing Markdown links to their labels could also reconstruct tags in `plain()`.

The helper now repeats stripping and basic entity decoding until the string stops changing. Every change shortens the string, so it terminates. Plain-text conversion also strips after reducing Markdown syntax. Regressions cover nested tags/comments, recursively encoded entities, reconstructed Markdown labels, comparisons, and ordinary Markdown.

Scope traced in the source:

- `triggerView()` produces plain text and previews; `ticketDetail()` formats text/note inputs; `ticketSummary()` formats attention questions.
- Ticket questions and inputs reach `MarkdownLite` in `src/client/ticket.tsx`.
- `MarkdownLite` and `ClampText` in `src/client/widgets.tsx` render strings as React children, not raw HTML. Their parsers only create HTTP(S) links. Titles and previews also use text children.

**HTML removal is presentation formatting, not a general-purpose HTML sanitizer or the XSS security boundary.** The client must keep rendering untrusted strings as text. Malformed markup, numeric entities, or other syntax not recognized by the helper must never be handed to `innerHTML` or `dangerouslySetInnerHTML`.

`tests/panel-execution.spec.tsx` exercises the actual ticket screen, including a deliberately unformatted question to verify that safety does not depend on the backend formatter. Script/image/SVG markup and event-handler attributes create no corresponding DOM elements; `javascript:` and `data:` links remain text, while safe bold and HTTPS links still work. The test passed even before the formatter fix.

A separate local Chromium smoke check mounted the actual `PanelProvider`, `MarkdownLite`, and `ClampText` components through Vite, with raw, formatted, reconstructed, and recursively encoded inputs. All four cases created zero script/image/SVG/iframe/object/embed elements or executable event attributes; only HTTPS anchors appeared. Dispatching load/error events did not change the execution marker. This was an isolated component fixture, not a test of an authenticated DSH deployment. Its temporary fixture and browser artifacts are not committed. The fixture's missing API/favicon requests returned expected 404s.

React's documented boundary: [children versus raw HTML](https://react.dev/reference/react-dom/components/common#dangerously-setting-the-inner-html).

## Why Dependabot did not update the three packages

[Dependabot run 41891013868](https://github.com/RubenPanero/dsh-superagent-prototype/actions/runs/41891013868) reported `security_update_not_possible` for `source-map-js`, `undici`, and `vite`. All three vulnerable copies are transitive dependencies:

| Dependency path | Vulnerable resolution | Resolution applied |
| --- | --- | --- |
| `jsdom → css-tree → source-map-js` | 1.2.1 | 1.2.2 |
| `jsdom → undici` | 7.29.1 | 7.30.1 |
| `vitest → vite` (also optional peer of `@vitest/mocker`) | 8.2.2 | 8.2.4 |

The updater executed these commands, each returning success without changing the vulnerable resolutions:

```sh
pnpm update source-map-js@1.2.2 --lockfile-only --no-save -r
pnpm update undici@8.12.3 --lockfile-only --no-save -r
pnpm update vite@8.3.5 --lockfile-only --no-save -r
```

Reproduction on a temporary directory containing only the baseline `package.json` and `pnpm-lock.yaml`, using the repository's pinned **pnpm 11.7.0**, produced **exit 0 and a byte-identical lockfile for all three commands**. A named update without transitive selection does not update these indirect dependencies. In addition, asking for Undici 8 does not patch the separate vulnerable Undici 7 copy used by jsdom.

The logs include `VulnerabilityAuditor: missing lockfile`, but the checked-in pnpm lockfile exists and the updater reads its resolutions. That message is not evidence that the repository lacks a lockfile. The logs also show pnpm 12.10.1 after an attempted installation of the requested 11.7.0; the pinned-version local reproduction demonstrates that the version discrepancy is not necessary to reproduce the no-op.

For a safe reproduction, copy the baseline manifests to a temporary directory, not over the current checkout, verify pnpm is 11.7.0, then compare `sha256sum pnpm-lock.yaml` before and after each command above.

The remediation is in `pnpm-workspace.yaml`: root overrides restricted to the affected ranges. The lockfile was regenerated with pnpm 11.7.0. This preserves the already-corrected Undici 8.12.3 used by DSH and avoids major-version upgrades or adding transitive dependencies to the direct dependency list. The overrides are an explicit workaround; they do not repair Dependabot's updater. Revisit them when upstream dependency resolutions and the updater can carry the fixes without them.

References: [pnpm overrides](https://pnpm.io/settings#overrides), [pnpm update](https://pnpm.io/cli/update). Current documentation describes newer indirect-update warnings/errors; the exit-zero no-op above was measured on 11.7.0, not inferred from newer versions.

## Verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run tests/views.spec.ts tests/markdown.spec.ts tests/panel-execution.spec.tsx
pnpm typecheck
pnpm build
pnpm audit --json
LC_ALL=C pnpm check
```

- Frozen install: passed; no lifecycle scripts required.
- Targeted tests: **37 passed**. Five added formatter cases failed against the original implementation and passed after the fix.
- Typecheck and build: passed.
- Audit: **0 vulnerabilities**, including development dependencies.
- Chromium component smoke: passed, with the scope described above.
- Full suite with `LC_ALL=C`: **1203 passed, 1 failed** across 59 files. The failure is `tests/sources.spec.ts:1097`, where the Feishu consumer's health is `ready` rather than the expected JSON error. An unmodified archive of the baseline commit, installed offline with its original frozen lockfile, reproduces the same failure. It is not changed in this security branch.
- With the host's Spanish locale, `tests/environment.spec.ts:154` also fails because it expects `/bad config/` but Git reports `mala línea de config`. The original baseline reproduces that failure too; `LC_ALL=C` avoids it.
- pi-lens follow-up: corrected two YAML line-length errors, the missing YAML document marker, and both non-null assertion warnings in `text.ts`. Direct `yamllint` and the full `tsc --noEmit` run pass; the refreshed session cache has no errors or warnings for either file. The active LSP probe cannot reconfirm the TypeScript file when its push-only server is silent on a clean re-check; this is covered separately by the successful typecheck.
- Merge readiness: the full `LC_ALL=C pnpm check` was rerun after the pi-lens fixes and still has the pre-existing Feishu failure described above. A clean GitHub merge status is not equivalent to an entirely passing test suite.

GitHub's default-branch Dependabot and CodeQL alerts are not manually dismissed here. Audit results on this branch do not mean that GitHub has already closed its alerts; those require the relevant branch analysis/default-branch update.
