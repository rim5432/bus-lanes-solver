import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib"
import { nativeGroupCenterlines } from "../lib/native-group-centerlines"
import { packageApproachRegions } from "../lib/package-approach-regions"
import { loadAm3352DiagonalOuterInput } from "../scripts/load-am3352-diagonal-outer"

/** A rotated-pair, outer-carrier DDR byte: the pinned native path was gated
 * to axis-aligned inner-carrier shapes, which excluded this board class. */
test("diagonal outer-carrier byte dispatches into the pinned native path", () => {
  const input = loadAm3352DiagonalOuterInput()
  const before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input, {
    singleCarrier: { routePairsAsLanes: true },
  })
  solver.step()
  expect(solver.failed).toBe(false)
  expect(input).toEqual(before)
  expect(solver.phase).toMatch(/^pinned_/)
})

test("diagonal packages generate fabricated 45/90 pair backbones", () => {
  const input = loadAm3352DiagonalOuterInput()
  const local = { ...input, traces: [] }
  const regions = packageApproachRegions(input, input.minTraceWidth + 0.09 + 0.075)
  const alternatives = nativeGroupCenterlines(local, regions)
  expect(alternatives.length).toBeGreaterThan(0)
  expect(alternatives[0]).not.toBeUndefined()
  const inBox = (p: { x: number; y: number }, b: { minX: number; maxX: number; minY: number; maxY: number }) =>
    p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
  const fields = regions.map((r) => r.copper)
  for (const alternative of alternatives.slice(0, 4)) {
    for (const path of alternative!) {
      const first = path[0],
        last = path[path.length - 1]
      expect(
        fields.some((f) => inBox(first, f)) && fields.some((f) => inBox(last, f)),
      ).toBe(true)
      for (let i = 1; i < path.length; i++) {
        const dx = Math.abs(path[i].x - path[i - 1].x),
          dy = Math.abs(path[i].y - path[i - 1].y)
        const axisAligned = dx < 1e-6 || dy < 1e-6
        const fortyFive = Math.abs(dx - dy) < 1e-6
        expect(axisAligned || fortyFive).toBe(true)
      }
    }
  }
})
