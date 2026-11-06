import { length } from "./geometry"
import { NativeCarrierRouter } from "./native-carrier-router"
import {
  cleanNativeCarrierSignal,
  tuneNativeCarrierSignal,
} from "./native-carrier-tuning"
import { fixedRouteLength } from "./route-lengths"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import type { Connection, SimpleRouteJson, Trace } from "./types"

export interface HopFinisherWindow {
  minimum: number
  maximum: number
}

export interface HopFinisherOptions {
  /** Carrier layers to try, in order. The default tries the interlayer hop
   * shape first (bottom carrier) and the unconfined same-surface shape
   * second, matching the carriers measured on the accepted byte-lane copper. */
  carriers?: string[]
  /** Search grid step. Default input.minTraceWidth / 2 - the pinned native
   * path convention (route-pinned-native-buses.ts gridStep default). */
  step?: number
  /** Per-route expansion cap. Default 1_500_000 - the unanchored pinned-path
   * convention (route-pinned-native-buses.ts maxExpansionsPerRoute). */
  maxExpansions?: number
  /** Search bounds. Default input.bounds; drivers pass the package band so
   * the grid stays proportional to the routing problem, not the board. */
  routingBounds?: SimpleRouteJson["bounds"]
  /** Bounded retries per carrier. A candidate whose tuning fails becomes soft
   * copper and the search runs once more around it. Default 2. */
  attemptsPerCarrier?: number
}

/** Tune a same-surface (0-via) candidate to the window on its single layer.
 * tuneNativeCarrierSignal only tunes the via-separated carrier leg
 * (native-carrier-tuning.ts slices at exactly two via indices), so the
 * same-surface shape needs its own whole-route pass. */
function tuneSameSurfaceSignal(
  native: SimpleRouteJson,
  connection: Connection,
  raw: Trace,
  window: HopFinisherWindow,
  soft: Trace[],
  bankCost?: (trace: Trace) => number,
): Trace | null {
  const trace = cleanNativeCarrierSignal(native, connection, raw, soft, false)
  if (!trace) return null
  const carrier = native.allowedLayers![0]
  const c = {
    ...connection,
    pointsToConnect: connection.pointsToConnect.map((p, i) => ({
      ...p,
      ...trace.route[i ? trace.route.length - 1 : 0],
      layer: carrier,
    })),
  }
  const tuningInput: SimpleRouteJson = {
    ...native,
    connections: [c],
    buses: [
      {
        busId: "hop_finisher_target",
        connectionNames: [c.name],
        minLength: window.minimum,
        maxLength: window.maximum,
      },
    ],
    differentialPairs: [],
  }
  try {
    const matched = tuneSmoothLengths(
      tuningInput,
      [trace],
      new Map([[c.name, window.minimum]]),
      {
        candidateScore: bankCost,
        alignPeriods: true,
        packMeanders: true,
      },
    )[0]
    return length(matched.route) <= window.maximum + 1e-8 &&
      length(matched.route) >= window.minimum - 1e-8
      ? matched
      : null
  } catch {
    return null
  }
}

/** Route one signal across the outer planes under a length window, as the
 * per-net failure fallback of a sequential chain.
 *
 * Measured basis (AM3352 ADDR_CTRL_CK outer-only chain, bus-lanes 0.0.45):
 * the engine's lane path solves single windowed nets in 1.16-4.25 s but the
 * chain stalls at depth 10/24 with no_planar_route, and the ordering matrix
 * shows the boundary failures are budget-class - "a fixed-copper negotiation
 * limit, not a geometry proof". The lane path is per-net single-layer
 * (negotiate-lanes.ts pins one chosenLayer per net and emits an all-wire
 * route), while this board's accepted byte-lane copper proves the solutions
 * are hop-shaped (14 through-vias over 11 nets, top escapes over a bottom
 * carrier). This finisher composes the engine's own hop machinery - the
 * NativeCarrierRouter two-plane search (the same search that produced the
 * accepted byte copper) plus the native window tuning - so a stalled chain
 * net gets a hop-shaped, window-exact route over the same fixed copper the
 * lane path refused. No new search algorithm: every piece is reused. */
export function* routeWindowedHopFinisher(
  input: SimpleRouteJson,
  connection: Connection,
  window: HopFinisherWindow,
  options: HopFinisherOptions = {},
): Generator<Trace | undefined, Trace | null> {
  const carriers = options.carriers ?? ["bottom", "top"]
  const step = options.step ?? input.minTraceWidth / 2
  const bounds = options.routingBounds ?? input.bounds
  const cells =
    (Math.ceil((bounds.maxX - bounds.minX) / step) + 1) *
    (Math.ceil((bounds.maxY - bounds.minY) / step) + 1)
  const cap = Math.max(
    window.maximum - fixedRouteLength(input, connection.name),
    0,
  )
  for (const carrier of carriers) {
    const native: SimpleRouteJson = { ...input, allowedLayers: [carrier] }
    const router = new NativeCarrierRouter(
      native,
      step,
      [new Float32Array(cells), new Float32Array(cells)],
      bounds,
    )
    const soft: Trace[] = []
    for (
      let attempt = 0;
      attempt < Math.max(1, options.attemptsPerCarrier ?? 2);
      attempt++
    ) {
      const search = router.route(connection, {
        maxLength: cap,
        maxExpansions: options.maxExpansions ?? 1_500_000,
        softTraces: soft,
      })
      let state = search.next()
      try {
        while (!state.done) {
          yield undefined
          state = search.next()
        }
      } finally {
        if (!state.done) search.return(null)
      }
      const raw = state.value
      if (!raw) break
      const vias = raw.trace.route.filter(
        (p) => p.route_type === "via",
      ).length
      const tuned =
        vias === 2
          ? tuneNativeCarrierSignal(
              native,
              connection,
              raw.trace,
              window.minimum,
              window.maximum,
              soft,
              raw.bankCost,
            )
          : vias === 0
            ? tuneSameSurfaceSignal(
                native,
                connection,
                raw.trace,
                window,
                soft,
                raw.bankCost,
              )
            : null
      if (tuned) {
        yield tuned
        return tuned
      }
      soft.push(raw.trace)
    }
  }
  return null
}
