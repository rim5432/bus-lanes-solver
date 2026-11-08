export { BusLanesSolver } from "./bus-lanes-solver"
export type * from "./types"
export {
  BusLanesPipelineSolver,
  type BusLanesPipelineOptions,
} from "./bus-lanes-pipeline-solver"
export { exteriorPairSpacingReports } from "./exterior-pair-spacing"
export { busLengthReports, pairLengthReports } from "./route-lengths"
export type { NativeSingleCarrierOptions } from "./route-matched-native-single-carrier"

export {
  SingleLayerConnectivitySolver,
  type SingleLayerConnectivityOptions,
} from "./single-layer-connectivity-solver"

export {
  routeWindowedHopFinisher,
  type HopFinisherWindow,
  type HopFinisherOptions,
} from "./route-hop-finisher"

// Minimal export for the am3352-rebuild route-stage6 ADDR phase
// (2026-11-08): the campaign drivers import the internal negotiator
// directly; publishing it here lets the pinned engine artifact expose
// exactly what the pipeline consumes - nothing else joins the surface.
export { matchNativeCarrierSignals } from "./match-native-carrier-signals"
