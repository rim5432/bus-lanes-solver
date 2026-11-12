import {
  finishGeneratedSurfaceCarriers,
  type CompletedGeneratedSurfaceCarriers,
} from "./finish-generated-surface-carriers"
import { negotiateSignalSites } from "./negotiate-signal-sites"
import { runBoundedRouting } from "./run-bounded-routing"
import type { SimpleRouteJson, SolverOptions } from "./types"

const EXPANDED_GRID_PROBE_STEPS = 3000

interface GeneratedSignalSitesRequest {
  input: SimpleRouteJson
  options: SolverOptions
  maxSteps: number
}

/** Keep new pad approaches and carrier layers negotiable when adjacent via
 * allocation falls back to the native surface. Supplied copper remains fixed. */
export function* routeGeneratedSignalSites(
  request: GeneratedSignalSitesRequest,
): Generator<void, CompletedGeneratedSurfaceCarriers | null> {
  // Try additional grid-centered sites together before freezing a local
  // assignment. Keep this probe bounded before the ordinary site search.
  if (request.maxSteps > 2 * EXPANDED_GRID_PROBE_STEPS) {
    const expandedGridRoute = yield* runBoundedRouting(
      completeGeneratedSignalSites(request, { expandAllGridSites: true }),
      EXPANDED_GRID_PROBE_STEPS,
    )
    if (expandedGridRoute) return expandedGridRoute
  }
  return yield* completeGeneratedSignalSites(request)
}

function* completeGeneratedSignalSites(
  { input, options, maxSteps }: GeneratedSignalSitesRequest,
  { expandAllGridSites = false } = {},
): Generator<void, CompletedGeneratedSurfaceCarriers | null> {
  const routed = yield* runBoundedRouting(
    negotiateGeneratedSignalSites(input, expandAllGridSites),
    maxSteps,
  )
  if (!routed) return null
  return yield* finishGeneratedSurfaceCarriers({
    input,
    carriers: routed.traces,
    escapes: routed.escapes,
    options,
    maxSteps,
  })
}

function* negotiateGeneratedSignalSites(
  input: SimpleRouteJson,
  expandAllGridSites: boolean,
): ReturnType<typeof negotiateSignalSites> {
  // Preserve the ordinary fallback when the grid-only probe cannot complete.
  for (const allowPadEdgeSites of [false, true]) {
    if (expandAllGridSites && allowPadEdgeSites) break
    const expandEmptyDomainsOnly = !expandAllGridSites && !allowPadEdgeSites
    const routed = yield* negotiateSignalSites(
      { native: input, pending: input, escapes: [], retained: [], traces: [] },
      new Set(input.connections.map((connection) => connection.name)),
      false,
      true,
      {
        checkEscapeCompatibility: true,
        allowExpandedSites: true,
        expandEmptyDomainsOnly,
        allowPadEdgeSites,
        maxCandidateSearchNodes: Number(process.env.BLS_SITES_NODES ?? 12000),
        onBlockedConnection:
          process.env.BLS_DEBUG === "1"
            ? (name: string) => console.error("[sites] blocked", name)
            : undefined,
      },
    )
    if (routed) return routed
  }
  return null
}
