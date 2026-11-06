# Quality verification

## Corrected warning inventory

The original 71 warning sites were addressed without diagnostic suppressions or relaxed gates:

- Explicit Boolean conversion/predicates replace double negation.
- Guards and narrowed values replace non-null assertions at domain, resource and environment boundaries.
- Readable branches replace nested ternaries; response lists and disposer lists use non-mutating reversal.
- GitHub notification cursors choose the later ISO timestamp directly, without sorting or asserting a nonempty result. Read failures distinguish retrying from abandoned reads explicitly.
- Ticket transitions construct records without cleared optional fields. Reopening, resuming, retrying and ending preserve property absence rather than storing `undefined`; shared lifecycle tests cover the transitions.
- Resource reads await their handler while preserving the asynchronous error contract.
- Runtime integration tests are separated by subsystem and use shared host, agent and view fixtures. Large combined scenarios are split without deleting assertions. Synchronous prompt reads are consumed by assertions instead of being detached calls.

GitHub list decoding is now one validated response boundary with a contextual error and preserved cause. Malformed JSON still rejects the poll, preserves its checkpoint and recovers on the next valid response; regression cases cover notification and repository streams. No catch-and-ignore fallback was added.

This is not a claim that every heuristic warning across the whole repository is gone. A broader pi-lens CLI pass also reports independent legacy complexity, fan-out, import-coupling and mixed-async recommendations in production orchestration methods. Those are distinct from the corrected original warning sites; no blanket suppression or metric increase was used to hide them. Some active TypeScript LSP probes remain inconclusive on clean files, so the complete compiler run is the type-check evidence.

## Dependencies and local verification

The two DSH peer mismatches are resolved with exact dev dependency versions that match the installed alpha stack:

- `@deepseek-ai/cordis-plugin-include`: `1.0.10-alpha.1`
- `@deepseek-ai/cordis-plugin-group`: `1.0.5-alpha.1`

No peer ranges were widened and no peer-warning ignores were added. `strictPeerDependencies` is enabled and `pnpm check` now includes `pnpm peers check`.

On Node 24.22.1 and pinned pnpm 11.7.0, frozen installation with scripts disabled, lint/complexity, formatting, peer checks, strict type checking, the full Vitest suite, production duplication detection, both builds and the dependency audit passed. The split scenarios increase the suite to 1217 tests in 66 files while preserving the previous assertions. Negative probes also confirm that the duplication and complexity gates reject violating code.

Local ignored Corepack shims address a conflicting global pnpm without bypassing the version pin or changing global tooling. Existing user changes to `docs/security-review.md` and `LocalDoc/` are excluded from this work.

## GitHub verification and merge policy

The workflow tests Node 22.19.0 and 24, audits dependencies, and runs extended CodeQL analysis for JavaScript/TypeScript **and Python**. Python coverage preserves the service script analysis previously supplied by GitHub default setup. Advanced setup replaces default setup rather than running conflicting configurations.

Merge protection is managed through GitHub repository settings: require pull requests, successful quality jobs, an up-to-date branch and resolved conversations; disallow branch deletion and force pushes. Code scanning must also provide CodeQL results without high/critical security alerts or error-level findings. The repository currently has only one collaborator, so a second person's approval is not mandatory; PR and check requirements still apply to administrators. Remote settings and run conclusions must be read back from GitHub, not inferred from workflow files or local checks. The final handoff records the actual push, PR and CI results.

Existing source retains its compact layout; full canonical formatting is enforced for new source and tooling, with diff whitespace checks for existing files. Complexity ceilings accommodate the measured legacy maxima. The browser CommonJS build's ESM recommendation remains intentional because DSH uses a module-loader wrapper. No publishing or deployment is automated.
