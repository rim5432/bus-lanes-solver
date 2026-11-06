import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib"
import { loadAm3352ComposedTwoBusInput } from "../scripts/load-am3352-diagonal-outer"

/** The composed byte shape carries two DQS pairs on one pad layer, which
 * starves the surface-seed route (its site negotiation is same-surface and
 * cannot resolve the mirror-pinout crossings) — the shape must steer into
 * the lane-negotiated shared-layer route instead. The shared-layer route
 * yields once per bounded pair-search step; a for-of drain regression would
 * consume the whole pair-corridor planning inside the first step() and trip
 * the test timeout. */
test(
  "multi-pair same-layer shapes steer into shared-layer lanes",
  () => {
    const input = loadAm3352ComposedTwoBusInput()
    const solver = new BusLanesPipelineSolver(input)
    let steps = 0
    let stepsInShared = 0
    let reached = false
    while (!solver.solved && !solver.failed && steps < 3000) {
      solver.step()
      steps++
      if (solver.phase === "route_shared_layers") {
        reached = true
        stepsInShared++
      }
    }
    expect(solver.sharedPackagesRouteName).toBe("shared_layer_buses")
    expect(reached).toBe(true)
    expect(stepsInShared).toBeGreaterThan(200)
  },
  20000,
)
