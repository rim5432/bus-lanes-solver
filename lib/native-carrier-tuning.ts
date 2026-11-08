import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import { length } from "./geometry"
import { VectorScene, fixedCopper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Trace } from "./types"

/** Keep negotiated detours while removing raster corners. Other movable
 * signals constrain shortcuts; their existing collisions remain provisional. */
export function cleanNativeCarrierSignal(
  native: SimpleRouteJson,
  connection: Connection,
  trace: Trace,
  soft: Trace[],
  carrierToo: boolean,
): Trace | null {
  const viaIndices = trace.route.flatMap((p, i) =>
    p.route_type === "via" ? [i] : [],
  )
  if (viaIndices.length > 2) {
    // 4-via ladder shapes (AM3352 hop campaign): clean every planar run on
    // its own layer; carrierToo keeps its meaning (all runs vs surfaces
    // only). One via alone is still a degenerate shape we refuse.
    const width =
      connection.width ?? connection.nominalTraceWidth ?? native.minTraceWidth
    const runs: Trace["route"][] = []
    let start = 0
    for (const v of viaIndices) {
      runs.push(trace.route.slice(start, v))
      start = v + 1
    }
    runs.push(trace.route.slice(start))
    const cleaned: Trace["route"][] = []
    for (const run of runs) {
      const layer = run[0]?.route_type === "wire" ? run[0].layer : "top"
      const isCarrier = layer === native.allowedLayers![0]
      if (run.length < 2 || (carrierToo === false && isCarrier)) {
        cleaned.push(run)
        continue
      }
      const c = {
        ...connection,
        pointsToConnect: [
          { ...connection.pointsToConnect[0], ...run[0], layer },
          { ...connection.pointsToConnect[1], ...run.at(-1)!, layer },
        ],
      }
      const input = {
        ...native,
        connections: [c],
        buses: [],
        differentialPairs: [],
      }
      const hard = fixedCopper(input),
        softCopper = fixedCopper({ ...input, obstacles: [], traces: soft })
      try {
        const path = reduceOrdinaryTurns(
          run,
          new VectorScene(input, c, width, [...hard, ...softCopper]),
        )
        cleaned.push(
          chamferOrdinaryCorners(
            input,
            [
              {
                ...trace,
                route: path.map((p) => ({
                  ...p,
                  route_type: "wire" as const,
                  layer,
                  width,
                })),
                curvedSegments: undefined,
              },
            ],
            hard,
            0.125,
          )[0].route,
        )
      } catch {
        return null
      }
    }
    const route: Trace["route"] = []
    for (let i = 0; i < cleaned.length; i++) {
      route.push(...cleaned[i])
      if (i < viaIndices.length) route.push(trace.route[viaIndices[i]])
    }
    return { ...trace, route, curvedSegments: undefined }
  }
  if (viaIndices.length !== 2) {
    // A same-surface route has no via-separated carrier leg; clean its one
    // planar run directly instead of demanding the interlayer shape.
    if (viaIndices.length) return null
    const route = trace.route
    if (route.length < 2) return null
    const c = {
      ...connection,
      pointsToConnect: [
        { ...connection.pointsToConnect[0], ...route[0], layer: "top" },
        { ...connection.pointsToConnect[1], ...route.at(-1)!, layer: "top" },
      ],
    }
    const input = {
      ...native,
      connections: [c],
      buses: [],
      differentialPairs: [],
    }
    const hard = fixedCopper(input),
      softCopper = fixedCopper({ ...input, obstacles: [], traces: soft })
    const width =
      connection.width ?? connection.nominalTraceWidth ?? native.minTraceWidth
    try {
      const path = reduceOrdinaryTurns(
        route,
        new VectorScene(input, c, width, [...hard, ...softCopper]),
      )
      return {
        ...trace,
        route: chamferOrdinaryCorners(
          input,
          [
            {
              ...trace,
              route: path.map((p) => ({
                ...p,
                route_type: "wire" as const,
                layer: "top",
                width,
              })),
              curvedSegments: undefined,
            },
          ],
          hard,
          0.125,
        )[0].route,
        curvedSegments: undefined,
      }
    } catch {
      return null
    }
  }
  const [a, b] = viaIndices
  const runs = [
    trace.route.slice(0, a),
    trace.route.slice(a + 1, b),
    trace.route.slice(b + 1),
  ]
  for (const side of carrierToo ? [0, 1, 2] : [0, 2]) {
    const route = runs[side]
    if (route.length < 2) return null
    const layer = side === 1 ? native.allowedLayers![0] : "top"
    const c = {
      ...connection,
      pointsToConnect: [
        { ...connection.pointsToConnect[0], ...route[0], layer },
        { ...connection.pointsToConnect[1], ...route.at(-1)!, layer },
      ],
    }
    const input = {
      ...native,
      connections: [c],
      buses: [],
      differentialPairs: [],
    }
    const hard = fixedCopper(input),
      softCopper = fixedCopper({ ...input, obstacles: [], traces: soft })
    const width =
      connection.width ?? connection.nominalTraceWidth ?? native.minTraceWidth
    const path = reduceOrdinaryTurns(
      route,
      new VectorScene(input, c, width, [...hard, ...softCopper]),
    )
    try {
      runs[side] = chamferOrdinaryCorners(
        input,
        [
          {
            ...trace,
            route: path.map((p) => ({
              ...p,
              route_type: "wire" as const,
              layer,
              width,
            })),
            curvedSegments: undefined,
          },
        ],
        hard,
        0.125,
      )[0].route
    } catch {
      return null
    }
  }
  return {
    ...trace,
    route: [...runs[0], trace.route[a], ...runs[1], trace.route[b], ...runs[2]],
    curvedSegments: undefined,
  }
}

/** Match actual whole-signal copper. TOP escapes stay owned and immutable
 * during this correction; every added timing bank is on the inner carrier. */
export function tuneNativeCarrierSignal(
  native: SimpleRouteJson,
  connection: Connection,
  raw: Trace,
  minimum: number,
  maximum: number,
  soft: Trace[],
  bankCost?: (trace: Trace) => number,
  maxCandidates = 65536,
  preserveExistingBanks = false,
): Trace | null {
  const trace = preserveExistingBanks
    ? raw
    : cleanNativeCarrierSignal(native, connection, raw, soft, false)
  if (!trace) {
    // PDBG instrument (2026-11-09 review): clean failure was one of the
    // silent tune-fail returns - distinguish it from via-shape refusal.
    console.error(
      `PDBG tune-clean-null ${connection.name} rawVias=${raw.route.filter((p) => p.route_type === "via").length} rawLen=${length(raw.route).toFixed(3)}`,
    )
    return null
  }

  const viaIdx = trace.route.flatMap((p, i) =>
    p.route_type === "via" ? [i] : [],
  )
  if (viaIdx.length < 2) {
    // PDBG instrument (2026-11-09 review): 0/1-via shapes are refused before
    // any tuning; without this line they read as a generic tune-fail.
    console.error(
      `PDBG tune-via-short ${connection.name} vias=${viaIdx.length} len=${length(trace.route).toFixed(3)}`,
    )
    return null
  }
  let a = -1,
    b = -1
  if (viaIdx.length === 2) {
    ;[a, b] = viaIdx
  } else {
    // 4-via ladder: tune the longest interior run; every other run stays
    // fixed copper under the same connection name, so the bus target keeps
    // its whole-signal meaning (tuned leg + same-name fixed traces).
    let best = -1
    for (let k = 1; k < viaIdx.length; k++) {
      const span = viaIdx[k] - viaIdx[k - 1] - 1
      if (span > best) {
        best = span
        a = viaIdx[k - 1]
        b = viaIdx[k]
      }
    }
  }
  const route = trace.route.slice(a + 1, b),
    prefix = trace.route.slice(0, a + 1),
    suffix = trace.route.slice(b)
  // PDBG range-target probe (2026-11-09 review): env-gated, prints the
  // whole-signal window and the fixed prefix+suffix length for every tune
  // call. The tuner's target is the whole-signal minimum and the fixed
  // escape copper is counted by fixedRouteLength, so this line is the
  // authoritative test of the "leg window is offset by p+s" hypothesis.
  if (process.env.PDBG_TUNE_WINDOW)
    console.error(
      `PDBG tune-probe ${connection.name} win=[${minimum.toFixed(3)},${maximum.toFixed(3)}] fixedPrefixSuffix=${(length(prefix) + length(suffix)).toFixed(3)} rawWhole=${length(trace.route).toFixed(3)} leg=${length(route).toFixed(3)}`,
    )
  const escapes: Trace[] = [
    {
      ...trace,
      pcb_trace_id: `generated_escape_${connection.name}_0`,
      route: trace.route.slice(0, a + 2),
    },
    {
      ...trace,
      pcb_trace_id: `generated_escape_${connection.name}_1`,
      route: trace.route
        .slice(b - 1)
        .toReversed()
        .map((p) =>
          p.route_type === "via"
            ? { ...p, from_layer: p.to_layer, to_layer: p.from_layer }
            : p,
        ),
    },
  ]
  const carrier = native.allowedLayers![0]
  // The tuned leg may be a mid-ladder top excursion on 4-via shapes; its
  // layer comes from the route itself (the carrier leg on stock shapes).
  const subjectLayer =
    route[0]?.route_type === "wire" ? route[0].layer : carrier
  const c = {
    ...connection,
    pointsToConnect: connection.pointsToConnect.map((p, i) => ({
      ...p,
      ...route[i ? route.length - 1 : 0],
      layer: subjectLayer,
    })),
  }
  const input: SimpleRouteJson = {
    ...native,
    connections: [c],
    traces: [...(native.traces ?? []), ...escapes],
    buses: [
      {
        busId: "native_target",
        connectionNames: [c.name],
        minLength: minimum,
        maxLength: maximum,
      },
    ],
    differentialPairs: [],
  }
  const hard = fixedCopper(input),
    softCopper = fixedCopper({ ...input, obstacles: [], traces: soft })
  // A grown timing window can need only a small second bank. Preserve the
  // existing sampled curves; shortening them as ordinary raster corners loses
  // their shape and prevents a previously feasible lane from being repaired.
  const width =
    connection.width ?? connection.nominalTraceWidth ?? native.minTraceWidth
  const path = preserveExistingBanks
    ? route
    : reduceOrdinaryTurns(
        route,
        new VectorScene(input, c, width, [
          ...hard,
          ...softCopper,
        ]),
      )
  try {
    const clean = chamferOrdinaryCorners(
      input,
      [
        {
          ...trace,
          curvedSegments: preserveExistingBanks
            ? trace.curvedSegments
                ?.filter((i) => i > a + 1 && i < b)
                .map((i) => i - a - 1)
            : undefined,
          route: path.map((p) => ({
            ...p,
            route_type: "wire" as const,
            layer: subjectLayer,
            width,
          })),
        },
      ],
      hard,
      0.125,
    )[0]
    const matched = tuneSmoothLengths(
      input,
      [clean],
      new Map([[c.name, minimum]]),
      {
        candidateScore: bankCost,
        alignPeriods: true,
        packMeanders: true,
        maxCandidates,
      },
    )[0]
    const full = {
      ...matched,
      route: [...prefix, ...matched.route, ...suffix],
      curvedSegments: matched.curvedSegments?.map((i) => i + prefix.length),
    }
    const whole = length(full.route)
    if (whole > maximum + 1e-8 || whole < minimum - 1e-8)
      console.error(
        `PDBG tune-null ${connection.name} whole=${whole.toFixed(3)} win=[${minimum.toFixed(3)},${maximum.toFixed(3)}] fixedPrefixSuffix=${(length(prefix) + length(suffix)).toFixed(3)}`,
      )
    return whole <= maximum + 1e-8 && whole >= minimum - 1e-8 ? full : null
  } catch (e) {
    console.error(`PDBG tune-throw ${connection.name} ${String(e).slice(0, 120)}`)
    return null
  }
}
