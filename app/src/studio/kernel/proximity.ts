// How two shapes sit relative to each other: the shortest distance between
// them (and where), and how much two solids overlap. Used by the step
// diagnostics, `measure` between features or parts, and the `gap` check.
import { getOC, measureShapeVolumeProperties, type AnyShape, type Shape3D } from "replicad"

type V3 = [number, number, number]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OC = any

/** Below this a distance is contact. */
export const TOUCH = 1e-3

/** Shortest distance between two shapes and the two closest points (null: OpenCascade found none). */
export function closest(a: AnyShape, b: AnyShape): { d: number; segment: [V3, V3] } | null {
  const oc: OC = getOC()
  const dss = new oc.BRepExtrema_DistShapeShape()
  try {
    dss.LoadS1(a.wrapped)
    dss.LoadS2(b.wrapped)
    dss.Perform()
    if (!dss.IsDone() || dss.NbSolution() < 1) return null
    const pa = dss.PointOnShape1(1)
    const pb = dss.PointOnShape2(1)
    const segment: [V3, V3] = [
      [pa.X(), pa.Y(), pa.Z()],
      [pb.X(), pb.Y(), pb.Z()],
    ]
    pa.delete()
    pb.delete()
    return { d: dss.Value(), segment }
  } finally {
    dss.delete()
  }
}

/** Volume two solids share (0 when either isn't a solid or they only touch). */
export function overlapVolume(a: AnyShape, b: AnyShape): number {
  if (!("intersect" in a) || !("intersect" in b)) return 0
  const common = (a as Shape3D).intersect(b as Shape3D)
  try {
    return measureShapeVolumeProperties(common).volume
  } finally {
    common.delete()
  }
}

/** Distance, and the overlap when they touch and both are solids (a boolean only then: they can be slow). */
export function relation(a: AnyShape, b: AnyShape, solids: boolean): { d: number; overlap: number; segment: [V3, V3] | null } {
  const c = closest(a, b)
  const d = c?.d ?? 0
  const overlap = solids && d <= TOUCH ? overlapVolume(a, b) : 0
  return { d, overlap, segment: c?.segment ?? null }
}

/** 「接触」「相交 12.4 mm³」「0.52 mm」 */
export function relationText(r: { d: number; overlap: number }) {
  if (r.overlap > 1e-6) return `相交 ${fmt(r.overlap)} mm³`
  if (r.d <= TOUCH) return "接触（距离 0）"
  return `${fmt(r.d)} mm`
}

const fmt = (x: number) => String(Math.round(x * 100) / 100)
