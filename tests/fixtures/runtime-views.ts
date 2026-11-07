import type { Runtime } from '../../src/app/runtime.ts'
import { overview } from '../../src/app/views/overview.ts'
import { executorLoad } from '../../src/app/views/tickets.ts'
import { policyVersion } from '../../src/policy.ts'

export const viewsOf = (value: Runtime) => ({ store: value.store, sources: value.sources, links: value.links() })
export const overviewOf = (value: Runtime) =>
  overview(
    viewsOf(value),
    value.health,
    policyVersion(value.store.settings()),
    executorLoad(value.store, value.executor.activeCount()),
    value.setupProblem ?? value.feishuProblem
  )
