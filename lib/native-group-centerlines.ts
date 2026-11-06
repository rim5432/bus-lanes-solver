import { offsetPath } from "./coupled-pair-routing"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { fixedCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson } from "./types"

/** Straight coupled corridors in board-world millimetres (+X right, +Y up).
 * Package pairs may be axis-aligned or diagonal; diagonal corridors are
 * generated in the rotated forward/normal frame the projections already use.
 * Points use the board frame; forward/normal are unit directions. Fixed
 * copper is never moved.
 */
export function nativeGroupCenterlines(
  input: SimpleRouteJson,
  packageRegions?: ReturnType<typeof packageApproachRegions>,
) {
  const pair = input.differentialPairs![0]
  const connections = pair.connectionNames.map(
    (name) => input.connections.find((c) => c.name === name)!,
  )
  const width = input.minTraceWidth
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const halfPitch = (width + (pair.traceGap ?? clearance)) / 2
  const regions =
    packageRegions ??
    packageApproachRegions(
      input,
      width + (pair.traceGap ?? clearance) / 2 + clearance,
    )
  const source = regions.find((r) =>
    pointInBox(connections[0].pointsToConnect[0], r.pads),
  )!
  const target = regions.find((r) =>
    pointInBox(connections[0].pointsToConnect[1], r.pads),
  )!
  const center = (box: SimpleRouteJson["bounds"]) => ({
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  })
  const a = center(source.pads),
    b = center(target.pads)
  const distance = Math.hypot(b.x - a.x, b.y - a.y)
  const forward = { x: (b.x - a.x) / distance, y: (b.y - a.y) / distance }
  const diagonal = Math.abs(forward.x) > 1e-8 && Math.abs(forward.y) > 1e-8
  const normal = { x: -forward.y, y: forward.x }
  const project = (point: Point, direction: Point) =>
    point.x * direction.x + point.y * direction.y
  const span = (box: SimpleRouteJson["bounds"], direction: Point) =>
    [box.minX, box.maxX].flatMap((x) =>
      [box.minY, box.maxY].map((y) => project({ x, y }, direction)),
    )
  const step = width
  const out =
    Math.floor(
      (Math.max(...span(source.copper, forward)) - 0.3 * step) / step,
    ) * step
  const incoming =
    Math.ceil((Math.min(...span(target.copper, forward)) + 0.3 * step) / step) *
    step
  const lower =
    Math.max(
      Math.min(...span(source.copper, normal)),
      Math.min(...span(target.copper, normal)),
    ) +
    3 * width
  const upper =
    Math.min(
      Math.max(...span(source.copper, normal)),
      Math.max(...span(target.copper, normal)),
    ) -
    3 * width
  const point = (u: number, v: number) => ({
    x: normal.x * u + forward.x * v,
    y: normal.y * u + forward.y * v,
  })
  const fixed = fixedCopper(input)
  const scenes = connections.map(
    (c) =>
      new VectorScene(
        input,
        {
          ...c,
          pointsToConnect: c.pointsToConnect.map((p) => ({
            ...p,
            layer: input.allowedLayers![0],
          })),
        },
        width,
        fixed,
      ),
  )
  const preferred =
    connections
      .flatMap((c) => c.pointsToConnect)
      .reduce((sum, p) => sum + project(p, normal), 0) / 4
  const candidates: number[] = []
  for (let u = Math.ceil(lower / step) * step; u < upper; u += step) {
    u = Number(u.toFixed(6))
    if (
      scenes.every((scene, rail) =>
        scene.visible(
          point(u + (rail ? halfPitch : -halfPitch), out),
          point(u + (rail ? halfPitch : -halfPitch), incoming),
        ),
      )
    )
      candidates.push(u)
  }
  candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred))
  const sourceLateral =
    connections.reduce(
      (sum, c) => sum + project(c.pointsToConnect[0], normal),
      0,
    ) / 2
  const targetLateral =
    connections.reduce(
      (sum, c) => sum + project(c.pointsToConnect[1], normal),
      0,
    ) / 2
  const selected: Point[][][] = []
  const add = (path: Point[]) => {
    if (
      scenes.every((scene, rail) =>
        scene.pathVisible(offsetPath(path, (rail ? 1 : -1) * halfPitch)),
      )
    )
      selected.push([path])
  }
  // Rotated package pairs get fabricated 45/90-degree backbones straight in
  // the board frame: a dominant-axis descent between the two copper fields
  // with one 45-degree jog absorbing the cross-axis offset. Straight
  // frame-diagonal centerlines are not representable by the lane refinement
  // solver and would violate fabricated-angle rules anyway, so none are
  // emitted. Vertically-dominant pairs are generated; horizontally-dominant
  // pairs keep the free-topology fallback.
  if (diagonal) {
    const dy = b.y - a.y
    if (dy !== 0 && Math.abs(dy) >= Math.abs(b.x - a.x)) {
      const src = source.copper
      const dst = target.copper
      const downward = Math.sign(dy)
      const y0 =
        downward < 0
          ? Math.ceil((src.minY + 0.3 * step) / step) * step
          : Math.floor((src.maxY - 0.3 * step) / step) * step
      const y3 =
        downward < 0
          ? Math.floor((dst.maxY - 0.3 * step) / step) * step
          : Math.ceil((dst.minY + 0.3 * step) / step) * step
      const targetX =
        connections.reduce((s, c) => s + c.pointsToConnect[1].x, 0) / 2
      const sourceX =
        connections.reduce((s, c) => s + c.pointsToConnect[0].x, 0) / 2
      const gridFit = (v: number) => Math.round(v / step) * step
      const x3 = Math.min(
        Math.max(
          gridFit(targetX),
          Math.ceil((dst.minX + halfPitch + 0.6 * step) / step) * step,
        ),
        Math.floor((dst.maxX - halfPitch - 0.6 * step) / step) * step,
      )
      const descent = Math.abs(y0 - y3)
      const columns: number[] = []
      for (
        let x = Math.ceil((src.minX + halfPitch + 0.6 * step) / step) * step;
        x <= src.maxX - halfPitch - 0.6 * step;
        x += step
      )
        columns.push(Number(x.toFixed(6)))
      columns.sort((c1, c2) => Math.abs(c1 - sourceX) - Math.abs(c2 - sourceX))
      for (const x0 of columns.slice(0, 12)) {
        const jogX = Math.abs(x3 - x0)
        if (jogX > descent - 2 * step) continue
        const splits = [
          Math.floor((descent - jogX) / 2 / step) * step,
          step,
          descent - jogX - step,
        ].filter(
          (v, i, arr) =>
            v >= step && arr.findIndex((o) => Math.abs(o - v) < 1e-9) === i,
        )
        for (const v1 of splits) {
          const ym = y0 + downward * v1
          add([
            { x: x0, y: y0 },
            { x: x0, y: ym },
            { x: x3, y: ym + downward * jogX },
            { x: x3, y: y3 },
          ])
        }
      }
    }
    return selected.length ? selected : [undefined]
  }
  const stem = 8 * width
  for (const u of candidates.filter((_, i) => i % 4 === 0).slice(0, 12)) {
    add([point(u, out), point(u, incoming)])
    // Keep a paired handoff near its native pin column when earlier groups
    // obstruct a long cross-package approach to the centered backbone.
    const sourceU = Math.round(sourceLateral / step) * step
    const sourceShift = Math.abs(sourceU - u)
    if (sourceShift > step && incoming - out > sourceShift + 2 * stem)
      add([
        point(sourceU, out),
        point(sourceU, out + stem),
        point(u, out + stem + sourceShift),
        point(u, incoming),
      ])
    const targetU = Math.round(targetLateral / step) * step
    const targetShift = Math.abs(targetU - u)
    if (targetShift > step && incoming - out > targetShift + 2 * stem)
      add([
        point(u, out),
        point(u, incoming - stem - targetShift),
        point(targetU, incoming - stem),
        point(targetU, incoming),
      ])
  }
  return [undefined, ...selected]
}
