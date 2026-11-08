import { writeFileSync } from "node:fs"
import {
  getCopperLayerNames,
  validateOriginalEndpointConnectivity,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { NativeCarrierRouter } from "./native-carrier-router"
import { cleanNativeCarrierSignal } from "./native-carrier-tuning"
import { length } from "./geometry"
import { isUnroutedComponentPad } from "./is-unrouted-component-pad"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { joinedSignalGeometryIsValid } from "./joined-signal-geometry"
import { generatedTraceTerminalViasAreClear } from "./terminal-via-clearance"
import { effectiveCarrierLayers } from "./effective-carrier-layers"
import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { initialSignalDogbones } from "./initial-signal-dogbones"
import { planNativePairedCarriers } from "./plan-native-paired-carriers"
import {
  matchNativeCarrierSignals,
  type NativeCarrierProgress,
} from "./match-native-carrier-signals"
import { nativeGroupCenterlines } from "./native-group-centerlines"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import type { NativeSingleCarrierOptions } from "./route-matched-native-single-carrier"
import type { SimpleRouteJson, Trace } from "./types"

/** Fresh, disjoint timing groups pinned to individual carriers (inner or
 * outer copper layers). Different groups may share a carrier or connect
 * package pairs in any relative orientation, axis-aligned or diagonal.
 * Existing fanouts and overlapping timing groups retain their original path. */
export function pinnedNativeBusesEligible(input: SimpleRouteJson) {
  if (
    input.outline?.length ||
    input.traces?.length ||
    !input.connections.length ||
    !input.buses?.length ||
    input.allowedLayers?.some(
      (l) => !getCopperLayerNames(input.layerCount).includes(l),
    )
  )
    return false
  const names = input.buses.flatMap((b) => b.connectionNames)
  if (
    names.length !== input.connections.length ||
    new Set(names).size !== names.length ||
    input.connections.some(
      (c) =>
        !names.includes(c.name) ||
        c.pointsToConnect.length !== 2 ||
        c.pointsToConnect.some(
          (p) => p.layer !== "top" || !isUnroutedComponentPad(input, c, p),
        ) ||
        (c.width ?? c.nominalTraceWidth ?? input.minTraceWidth) <
          input.minTraceWidth,
    )
  )
    return false
  const regions = packageApproachRegions(input, 0)
  return (
    input.buses.every((bus) => {
      const members = input.connections.filter((c) =>
        bus.connectionNames.includes(c.name),
      )
      if (
        !members.length ||
        (bus.traceWidth !== undefined && bus.traceWidth < input.minTraceWidth)
      )
        return false
      const layer = effectiveCarrierLayers(input, members[0])
      if (
        layer.length !== 1 ||
        !getCopperLayerNames(input.layerCount).includes(layer[0]) ||
        members.some(
          (c) => effectiveCarrierLayers(input, c).join() !== layer.join(),
        )
      )
        return false
      const pairs = (input.differentialPairs ?? []).filter((p) =>
        p.connectionNames.some((n) => bus.connectionNames.includes(n)),
      )
      if (
        pairs.length > 1 ||
        pairs.some(
          (p) =>
            !p.connectionNames.every((n) => bus.connectionNames.includes(n)),
        )
      )
        return false
      const a = regions.find((r) =>
          pointInBox(members[0].pointsToConnect[0], r.pads),
        ),
        b = regions.find((r) =>
          pointInBox(members[0].pointsToConnect[1], r.pads),
        )
      return (
        !!a &&
        !!b &&
        a !== b &&
        members.every(
          (c) =>
            pointInBox(c.pointsToConnect[0], a.pads) &&
            pointInBox(c.pointsToConnect[1], b.pads),
        )
      )
    }) &&
    (input.differentialPairs ?? []).every((p) =>
      p.connectionNames.every((n) => names.includes(n)),
    )
  )
}

/** Reserve every local escape before allocating coupled trunks. Reservations
 * protect later groups, but only complete, matched routes become fixed copper.
 * No component, input layer restriction or timing requirement is changed. */
export function* routePinnedNativeBuses(
  input: SimpleRouteJson,
  options: NativeSingleCarrierOptions = {},
  progress?: (s: NativeCarrierProgress) => void,
): Generator<void, Trace[] | null> {
  const targets = new Map(
    input.connections.map((c) => [c.name, effectiveCarrierLayers(input, c)[0]]),
  )
  // Reserve every local escape before any carrier work, retrying the
  // alternative assignment orientations like the grouped native path: a
  // fixed-copper neighborhood can block one orientation's collective site
  // assignment while another admits it. The bare collective matcher is also
  // weaker than the pipeline's own escape phase: on the AM3352 real-tree
  // cohort at the ruled 0.1 trace-to-pad clearance the strict matcher throws
  // in all four turns while initialSignalDogbones (the same wrapper the
  // escape phase uses - per-connection retries plus native-pad fallback)
  // still assigns. Its fallback needs the native pad layer, so a bus pinned
  // to a single carrier layer keeps that rung closed. Third rung: when the
  // wrapper still cannot place the whole cohort, connections with no legal
  // local site at any orientation (the wrapper's own per-connection probe)
  // ride reservation-less and the rest retry the ladder jointly. A rider
  // loses no route: reservations only protect escape sites across groups,
  // while every matched route - a rider's included - is authored by the
  // cohort router itself, whose via placement writes escapes straight from
  // pad pockets the interstitial matcher cannot see. Measured on that
  // cohort: two nets hold zero interstitial sites at 0.1 clearance while
  // their pad pockets still carry hundreds of all-layer via-legal cells,
  // and the remaining nets assign jointly in 0.1 s.
  const dogboneOptions = {
    targetLayers: targets,
    viaDiameter: input.minViaPadDiameter ?? 0.3,
    viaHoleDiameter: input.minViaHoleDiameter ?? 0.15,
    traceWidth: input.minTraceWidth,
    clearance:
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    holeToHoleClearance: input.minViaHoleEdgeToViaHoleEdgeClearance,
    boardEdgeClearance: input.minBoardEdgeClearance,
    allowBlindAndBuriedVias: false,
  }
  const assignable = (scoped: SimpleRouteJson, attempt: number) => {
    try {
      return initialSignalDogbones(scoped, dogboneOptions, attempt)
        .traces as Trace[]
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/No collision-free local dogbone assignment|Local dogbones collide/.test(
          error.message,
        )
      )
        throw error
      return undefined
    }
  }
  let reservations: Trace[] | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    reservations = assignable(input, attempt)
    if (reservations) break
    yield
  }
  if (!reservations) {
    const hasLocalSite = (connection: (typeof input.connections)[number]) => {
      const local = {
        ...input,
        connections: [connection],
        buses: [],
        differentialPairs: [],
      }
      for (let turn = 0; turn < 4; turn++) {
        try {
          routeAlternateSignalDogbones(local, dogboneOptions, turn)
          return true
        } catch {}
      }
      return false
    }
    const sited = input.connections.filter(hasLocalSite)
    if (sited.length < input.connections.length) {
      // A cohort with no sited member at all rides wholly reservation-less
      // (measured on the composed AM3352 board: a two-leg tee whose pads
      // hold zero interstitial sites under the landed escapes). Reservations
      // protect cross-group sites; a fully riding cohort has nothing to
      // protect interstitially, and the matcher authors every escape.
      if (sited.length) {
        for (let attempt = 0; attempt < 4; attempt++) {
          reservations = assignable({ ...input, connections: sited }, attempt)
          if (reservations) break
          yield
        }
      } else {
        reservations = []
      }
    }
  }
  if (!reservations) return null
  const completed: Trace[] = []
  const packageRegions = packageApproachRegions(
    input,
    input.minTraceWidth +
      Math.max(
        0,
        ...(input.differentialPairs ?? []).map((p) => p.traceGap ?? 0.1),
      ) /
        2 +
      (input.minTraceToPadEdgeClearance ?? 0.075),
  )
  const groups = input.buses!.map((bus) => {
    const connections = input.connections.filter((c) =>
      bus.connectionNames.includes(c.name),
    )
    const pairs = (input.differentialPairs ?? []).filter((p) =>
      p.connectionNames.every((n) => bus.connectionNames.includes(n)),
    )
    const regions = packageRegions.filter((r) =>
      connections.some((c) =>
        c.pointsToConnect.some((p) => pointInBox(p, r.pads)),
      ),
    )
    const margin = 20 * (input.minViaPadDiameter ?? 0.3)
    const routingBounds = {
      minX: Math.max(
        input.bounds.minX,
        Math.min(...regions.map((r) => r.copper.minX)) - margin,
      ),
      maxX: Math.min(
        input.bounds.maxX,
        Math.max(...regions.map((r) => r.copper.maxX)) + margin,
      ),
      minY: Math.max(
        input.bounds.minY,
        Math.min(...regions.map((r) => r.copper.minY)) - margin,
      ),
      maxY: Math.min(
        input.bounds.maxY,
        Math.max(...regions.map((r) => r.copper.maxY)) + margin,
      ),
    }
    const config = {
      ...options,
      routingBounds: options.routingBounds ?? routingBounds,
      gridStep: options.gridStep ?? input.minTraceWidth / 2,
      // The DRC validation resolves every fixed trace's connection_name
      // against these connections. On a composed board the supplied copper
      // (AM3352 byte0's landed traces, named by their source nets) is owned
      // by connections outside this room; without them the validator flags
      // every foreign trace "unknown-trace-connection" and rejects the
      // cleanest geometry (measured: zero-collision topologies dying at
      // acceptance on that code alone).
      fixedConnections: options.fixedConnections ?? input.connections,
      balanceApproaches: options.balanceApproaches ?? false,
      insetHandoffs: true,
      protectPairedTerminalVias: true,
      packageRegions,
      maxExpansionsPerRoute: options.maxExpansionsPerRoute ?? 300000,
      maxApproachPasses: options.maxApproachPasses ?? 50,
      maxTuningCandidates: options.maxTuningCandidates ?? 8192,
      maxPasses: options.maxPasses ?? 24,
      maxLocalPasses: options.maxLocalPasses ?? 16,
    }
    return { bus, connections, pairs, config }
  })
  const pairedByBus = new Map<string, Trace[]>()
  const fixedExcept = (excluded: Set<string>) => {
    const done = new Set(completed.map((t) => t.connection_name))
    return [
      // Supplied copper is immutable context for every search here, not just
      // the reservation matcher: on a composed board (AM3352 ADDR around the
      // landed byte0 copper) dropping input.traces from the carrier matching
      // let all 24 lanes overlap the fixed carrier by up to 0.2 mm - 18k
      // segment conflicts the final DRC never saw because routedSrj was
      // also built from completed traces alone. fixedCopper treats
      // input.traces as exact foreign-owned sausages; the reservation ladder
      // already sees them (it runs on input directly).
      ...(input.traces ?? []),
      ...completed.filter((t) => !excluded.has(t.connection_name!)),
      ...reservations.filter(
        (t) =>
          !done.has(t.connection_name) && !excluded.has(t.connection_name!),
      ),
    ]
  }
  const localFor = (
    group: (typeof groups)[number],
    fixed: Trace[],
  ): SimpleRouteJson => ({
    ...input,
    allowedLayers: [targets.get(group.connections[0].name)!],
    connections: group.connections,
    buses: [group.bus],
    differentialPairs: group.pairs,
    traces: fixed,
  })
  // Every coupled backbone is reserved before ordinary lanes can close a later
  // package exit. A per-bus timing bank must not strand another bus's strobe.
  for (const group of groups.filter(
    (g) => g.pairs.length && !options.routePairsAsLanes,
  )) {
    const pairNames = new Set(group.pairs.flatMap((p) => p.connectionNames))
    const local = localFor(group, fixedExcept(pairNames))
    const centers = nativeGroupCenterlines(local, packageRegions)
    let paired: Trace[] | null = null
    for (const [attempt, centerlines] of centers.entries()) {
      progress?.({
        stage: "pinned_bus_pair",
        pass: attempt,
        collisions: 0,
        unfinished: group.pairs.flatMap((p) => p.connectionNames),
        traces: completed,
        groupName: group.bus.name ?? group.bus.busId,
        completedConnections: completed.length,
      })
      // A geometrically impossible centerline (handoff outside a package
      // copper field, reversed offset) fails only its own attempt; the next
      // corridor alternative still gets its try.
      try {
        paired = yield* planNativePairedCarriers(local, {
          ...group.config,
          centerlines,
        })
      } catch {
        paired = null
      }
      if (
        paired?.some((trace) => !joinedSignalGeometryIsValid({ input, trace }))
      )
        paired = null
      if (paired) break
    }
    if (!paired) return null
    pairedByBus.set(group.bus.busId, paired)
    completed.push(...paired)
  }
  // Negotiate every ordinary lane sharing a carrier together. Freezing one
  // byte's timing bank before its neighbors can trap a later data/command bus.
  // Negotiate unanchored command cohorts before data escapes become fixed.
  const carriers = [...new Set(targets.values())].sort(
    (a, b) =>
      Number(
        groups.some(
          (g) => targets.get(g.connections[0].name) === b && !g.pairs.length,
        ),
      ) -
      Number(
        groups.some(
          (g) => targets.get(g.connections[0].name) === a && !g.pairs.length,
        ),
      ),
  )
  for (const carrier of carriers) {
    const cohort = groups.filter(
      (g) => targets.get(g.connections[0].name) === carrier,
    )
    const names = new Set(cohort.flatMap((g) => g.bus.connectionNames))
    const fixed = fixedExcept(names)
    const paired = cohort.flatMap((g) => pairedByBus.get(g.bus.busId) ?? [])
    const local: SimpleRouteJson = {
      ...input,
      allowedLayers: [carrier],
      connections: input.connections.filter((c) => names.has(c.name)),
      buses: cohort.map((g) => g.bus),
      differentialPairs: cohort.flatMap((g) => g.pairs),
      traces: fixed,
    }
    progress?.({
      stage: "pinned_carrier_matching",
      pass: 0,
      collisions: 0,
      unfinished: local.connections
        .filter((c) => !paired.some((t) => t.connection_name === c.name))
        .map((c) => c.name),
      traces: completed,
      groupName: carrier,
      completedConnections: completed.length,
    })
    const unanchored = cohort.filter((g) => !g.pairs.length)
    const step =
      options.gridStep ?? input.minTraceWidth / (unanchored.length ? 3 : 2)
    const boxes = cohort.map((g) => g.config.routingBounds)
    const bounds = {
      minX: Math.min(...boxes.map((b) => b.minX)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxY: Math.max(...boxes.map((b) => b.maxY)),
    }
    const config = {
      ...cohort[0].config,
      adaptiveRepair: true,
      gridStep: step,
      fineGridStep: options.fineGridStep ?? input.minTraceWidth / 3,
      routingBounds: bounds,
      maxExpansionsPerRoute:
        options.maxExpansionsPerRoute ?? (unanchored.length ? 1500000 : 500000),
    }
    const report = (state: NativeCarrierProgress) =>
      progress?.({
        ...state,
        groupName: carrier,
        completedConnections: completed.length,
        traces: [
          ...fixed.filter((t) => completed.includes(t)),
          ...state.traces,
        ],
      })
    const seed: Trace[] = []
    const busTargetLengths: Record<string, number> = {}
    const clearTopologyFirst =
      unanchored.length > 0 &&
      cohort.every(
        (group) => !group.pairs.length || group.connections.length === 2,
      )
    if (clearTopologyFirst) {
      // Command buses have no strobe length anchor. Establish a physically
      // clear topology before choosing their timing targets; independently
      // tuned shortest paths otherwise fill each other's only package exits.
      // These provisional paths remain internal. Original timing constraints
      // are restored for matching and checked again at full-board acceptance.
      const clear = yield* matchNativeCarrierSignals(
        { ...local, buses: [], differentialPairs: [] },
        paired,
        config,
        (state) => report({ ...state, stage: `pinned_clear_${state.stage}` }),
      )
      if (!clear) {
        console.error("PDBG clear-null")
        return null
      }
      const pairedNames = new Set(paired.map((trace) => trace.connection_name))
      seed.push(
        ...clear.filter((trace) => !pairedNames.has(trace.connection_name)),
      )
      for (const group of unanchored) {
        busTargetLengths[group.bus.busId] = Math.max(
          group.bus.minLength ?? 0,
          Math.ceil(
            Math.max(
              ...seed
                .filter((trace) =>
                  group.bus.connectionNames.includes(trace.connection_name!),
                )
                .map((trace) => length(trace.route)),
            ),
          ),
        )
                console.error(
          `PDBG seed-lengths ${group.bus.busId} target=${busTargetLengths[group.bus.busId]} max=${group.bus.maxLength ?? "-"} ${seed
            .filter((trace: (typeof seed)[number]) =>
              group.bus.connectionNames.includes(trace.connection_name!),
            )
            .map((trace: (typeof seed)[number]) => `${trace.connection_name}:${Math.round(length(trace.route) * 1e6)}`)
            .sort()
            .join(" ")}`,
        )
        // side effect guarded to opt-in (was unconditional - a debug dump to
        // TEMP on every solve; not route semantics)
        if (process.env.PDBG_DUMP_SEEDS)
          try {
            writeFileSync(
              `${process.env.TEMP ?? "/tmp"}/pinned-seed-${group.bus.busId}.json`,
              JSON.stringify(seed),
            )
          } catch {}
      }
    } else if (unanchored.length) {
      const cells =
        (Math.ceil((bounds.maxX - bounds.minX) / step) + 1) *
        (Math.ceil((bounds.maxY - bounds.minY) / step) + 1)
      const searchInput = { ...local, traces: [...fixed, ...paired] }
      const router = new NativeCarrierRouter(
        searchInput,
        step,
        [new Float32Array(cells), new Float32Array(cells)],
        bounds,
      )
      for (const group of unanchored) {
        const lengths: number[] = []
        for (const c of group.connections) {
          const raw = yield* router.route(c, {
            maxExpansions: config.maxExpansionsPerRoute,
            viaBudget: config.viaBudget,
          })
          if (!raw) return null
          const clean = cleanNativeCarrierSignal(
            searchInput,
            c,
            raw.trace,
            [],
            true,
          )
          if (!clean) return null
          seed.push(clean)
          lengths.push(length(clean.route))
        }
        busTargetLengths[group.bus.busId] = Math.max(
          group.bus.minLength ?? 0,
          Math.ceil(Math.max(...lengths) * 1.5),
        )
      }
    }
    const result = yield* matchNativeCarrierSignals(
      local,
      paired,
      {
        ...config,
        preserveExistingRoutes:
          options.preserveExistingRoutes ?? clearTopologyFirst,
        busTargetLengths,
        deferSearchLengthBound:
          options.deferSearchLengthBound ?? !!unanchored.length,
      },
      report,
      seed,
    )
    if (!result) return null
    for (let i = completed.length - 1; i >= 0; i--)
      if (names.has(completed[i].connection_name!)) completed.splice(i, 1)
    completed.push(...result)
  }
  if (
    completed.length !== input.connections.length ||
    input.connections.some(
      (c) => completed.filter((t) => t.connection_name === c.name).length !== 1,
    ) ||
    !completed.every(
      (trace) =>
        joinedSignalGeometryIsValid({ input, trace }) &&
        generatedTraceTerminalViasAreClear(input, trace),
    ) ||
    busLengthReports(input, completed).some(
      (b) =>
        !b.aboveMinimumLength ||
        !b.withinLengthLimit ||
        (b.toleranceMm !== null && !b.matched),
    ) ||
    pairLengthReports(input, completed).some((p) => !p.matched) ||
    exteriorPairSpacingReports(input, completed).some(
      (p) => !p.applicable || !p.matched,
    )
  )
    return null
  // The final DRC resolves every composed trace's connection_name - the
  // supplied copper's owners arrive through fixedConnections exactly like the
  // matcher's acceptance DRC (measured: byte0's source-net-named traces die
  // as "unknown-trace-connection" without them, after a clean match). The
  // endpoint validator only checks this room's own connections and tolerates
  // extra fixed copper, so it keeps the bare input.
  const validationInput = {
    ...input,
    connections: [
      ...input.connections,
      ...(options.fixedConnections ?? []).filter(
        (c) => !input.connections.some((o) => o.name === c.name),
      ),
    ],
  }
  if (
    !validateOriginalEndpointConnectivity({
      inputSrj: input,
      routedSrj: { ...input, traces: [...(input.traces ?? []), ...completed] },
    } as never).valid
  )
    return null
  const drc = validateRoutedCopperDrc({
    inputSrj: validationInput,
    routedSrj: { ...input, traces: [...(input.traces ?? []), ...completed] },
    clearance:
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    allowBlindAndBuriedVias: false,
  } as never)
  return drc.valid ? completed : null
}
