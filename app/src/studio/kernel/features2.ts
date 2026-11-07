// The common features added after tier 1: thin walls (closed outline or open
// path), extrude up to a face or the next face, tapered extrusions, and ribs.
// Plain 2D geometry for open paths lives here too (offset, discretising arcs).
import { draw, makeBox, makeCompound, Plane, type Drawing, type Shape3D } from "replicad"
import type { FaceSelector } from "../dsl"
import type { Scope } from "../expr"
import { InputError } from "./errors"
import { disposeInfos, faceInfos, selectFaces } from "./select"
import { solidsOf } from "./topo"

type V2 = [number, number]
type V3 = [number, number, number]
export type Frame = { origin: V3; x: V3; y: V3; normal: V3 }

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit2 = (a: V2): V2 => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const left = (a: V2): V2 => [-a[1], a[0]]

/** An open path's points, arcs cut into chords within 5 µm. */
export function pathPoints(points: { to: V2; via?: V2; r?: number; spline?: V2[] }[]): V2[] {
  const out: V2[] = [points[0].to]
  /** Corners to round afterwards: index in `out`, radius. */
  const corners: [number, number][] = []
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const a = out[out.length - 1]
    if (p.spline) {
      out.push(...splinePoints([a, ...p.spline]).slice(1))
      continue
    }
    if (!p.via) {
      out.push(p.to)
      if (p.r && i < points.length - 1) corners.push([out.length - 1, p.r])
      continue
    }
    const arc = arcThrough(a, p.via, p.to)
    if (!arc) {
      out.push(p.to)
      continue
    }
    const n = Math.min(256, Math.max(2, Math.ceil(Math.abs(arc.sweep) / (2 * Math.acos(Math.max(-1, 1 - 0.005 / arc.r))))))
    for (let k = 1; k <= n; k++) {
      const t = arc.start + (arc.sweep * k) / n
      out.push([arc.c[0] + arc.r * Math.cos(t), arc.c[1] + arc.r * Math.sin(t)])
    }
  }
  const rounded = corners.length ? roundCorners(out, corners) : out
  return rounded.filter((p, i) => i === 0 || Math.hypot(p[0] - rounded[i - 1][0], p[1] - rounded[i - 1][1]) > 1e-9)
}

/** A smooth curve through the points (Catmull-Rom, the ends held straight), as short segments. */
export function splinePoints(pts: V2[], per = 16): V2[] {
  if (pts.length < 2) return pts
  const at = (i: number): V2 => (i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] : i >= pts.length ? [2 * pts[pts.length - 1][0] - pts[pts.length - 2][0], 2 * pts[pts.length - 1][1] - pts[pts.length - 2][1]] : pts[i])
  const out: V2[] = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    for (let k = 1; k <= per; k++) {
      const t = k / per
      const t2 = t * t
      const t3 = t2 * t
      const c = (a: number, b: number, c2: number, d: number) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3)
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  return out
}

/** Replace each listed corner by an arc of radius r tangent to its two segments. */
function roundCorners(pts: V2[], corners: [number, number][]): V2[] {
  const at = new Map(corners)
  const out: V2[] = []
  pts.forEach((a, i) => {
    const r = at.get(i)
    if (!r || i === 0 || i === pts.length - 1) return void out.push(a)
    const unit = (v: V2): V2 => {
      const l = Math.hypot(v[0], v[1]) || 1
      return [v[0] / l, v[1] / l]
    }
    const d1 = unit([pts[i - 1][0] - a[0], pts[i - 1][1] - a[1]])
    const d2 = unit([pts[i + 1][0] - a[0], pts[i + 1][1] - a[1]])
    const alpha = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])))
    if (alpha < 1e-6 || Math.PI - alpha < 1e-6) return void out.push(a)
    const t = r / Math.tan(alpha / 2)
    const bis = unit([d1[0] + d2[0], d1[1] + d2[1]])
    const h = r / Math.sin(alpha / 2)
    const c: V2 = [a[0] + bis[0] * h, a[1] + bis[1] * h]
    const s: V2 = [a[0] + d1[0] * t, a[1] + d1[1] * t]
    const e: V2 = [a[0] + d2[0] * t, a[1] + d2[1] * t]
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0])
    let sweep = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    const n = Math.max(4, Math.ceil(Math.abs(sweep) / 0.1))
    for (let k = 0; k <= n; k++) out.push([c[0] + r * Math.cos(a0 + (sweep * k) / n), c[1] + r * Math.sin(a0 + (sweep * k) / n)])
  })
  return out
}

/** The circle through three points, as a start angle and a signed sweep from a to c via b. */
function arcThrough(a: V2, b: V2, c: V2) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const sq = (p: V2) => p[0] * p[0] + p[1] * p[1]
  const cx = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d
  const cy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d
  const ang = (p: V2) => Math.atan2(p[1] - cy, p[0] - cx)
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const start = ang(a)
  const ccw = norm(ang(c) - start)
  // Counter-clockwise if b lies on the ccw way from a to c, else clockwise.
  const sweep = norm(ang(b) - start) < ccw ? ccw : ccw - 2 * Math.PI
  return { c: [cx, cy] as V2, r: Math.hypot(a[0] - cx, a[1] - cy), start, sweep }
}

/** The polyline moved `d` to its left (negative: right), corners mitred. */
function offsetPolyline(pts: V2[], d: number): V2[] {
  if (Math.abs(d) < 1e-12) return pts.map((p) => [...p] as V2)
  const normals = pts.slice(1).map((p, i) => left(unit2([p[0] - pts[i][0], p[1] - pts[i][1]])))
  return pts.map((p, i) => {
    if (i === 0) return [p[0] + normals[0][0] * d, p[1] + normals[0][1] * d]
    if (i === pts.length - 1) return [p[0] + normals[i - 1][0] * d, p[1] + normals[i - 1][1] * d]
    const m = unit2([normals[i - 1][0] + normals[i][0], normals[i - 1][1] + normals[i][1]])
    const k = d / Math.max(0.2, m[0] * normals[i][0] + m[1] * normals[i][1])
    return [p[0] + m[0] * k, p[1] + m[1] * k]
  })
}

/** Which way an open path bends overall: +1 left, -1 right, 0 straight. */
function turning(pts: V2[]) {
  let s = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const a: V2 = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]
    const b: V2 = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]
    s += a[0] * b[1] - a[1] * b[0]
  }
  return Math.abs(s) < 1e-9 ? 0 : Math.sign(s)
}

function polygon(pts: V2[]): Drawing {
  let pen = draw(pts[0])
  for (const p of pts.slice(1)) pen = pen.lineTo(p)
  return pen.close()
}

/**
 * A thin wall as a region: a closed outline grown into a band (`inside` =
 * inwards), or an open path widened with flat ends (`inside` = the side it
 * bends towards).
 */
export function thinProfile(region: Drawing | null, paths: V2[][], t: number, side: "center" | "inside" | "outside"): Drawing {
  if (!(t > 0)) throw new InputError("壁厚必须大于 0")
  if (paths.length) {
    if (paths.length > 1 || region) throw new InputError("薄壁拉伸的草图只能有一条开放的线，或者只有封闭的图形")
    const pts = paths[0]
    const turn = turning(pts) || 1
    const [l, r] = side === "center" ? [t / 2, t / 2] : (side === "inside") === turn > 0 ? [t, 0] : [0, t]
    return polygon([...offsetPolyline(pts, l), ...offsetPolyline(pts, -r).reverse()])
  }
  if (!region) throw new InputError("草图里没有图形")
  const out = side === "inside" ? region.clone() : region.offset(side === "outside" ? t : t / 2)
  const inn = side === "outside" ? region.clone() : region.offset(-(side === "inside" ? t : t / 2))
  try {
    return out.cut(inn)
  } catch {
    throw new InputError("轮廓偏移后自相交了：壁厚太大，或者轮廓上有太窄的地方")
  }
}

/** Each solid's lowest point along `dir` (by its box corners). */
function lowAlong(s: Shape3D, dir: V3): number {
  const [a, b] = s.boundingBox.bounds as [V3, V3]
  let lo = Infinity
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) lo = Math.min(lo, dot([x, y, z], dir))
  return lo
}

/**
 * Up to the next face: extrude far, take off (add) or keep (cut) the body, and
 * keep only the pieces that start on the sketch plane. Returns the tool and how
 * far it actually went.
 */
export function untilNext(long: Shape3D, body: Shape3D, start: V3, dir: V3, mode: "add" | "cut" | "intersect"): { tool: Shape3D; length: number } {
  const pieces = mode === "add" ? long.cut(body) : long.intersect(body)
  const s0 = dot(start, dir)
  const solids = solidsOf(pieces)
  const kept = solids.filter((s) => Math.abs(lowAlong(s, dir) - s0) < 1e-4)
  if (!kept.length) {
    solids.forEach((s) => s.delete())
    throw new InputError(mode === "add" ? "沿拉伸方向没有碰到实体：成形到下一面要有面挡着" : "草图平面上没有材料可切：成形到下一面要从实体表面开始")
  }
  const length = Math.max(...kept.map((s) => -lowAlong(s, mul(dir, -1)))) - s0
  return { tool: kept.length === 1 ? kept[0] : (makeCompound(kept) as unknown as Shape3D), length }
}

/** The one face `sel` picks on `body`: its centre and normal (planes only). */
export function planeFace(body: Shape3D, origins: string[], sel: FaceSelector, scope: Scope, what: string): { center: V3; normal: V3 } {
  const faces = faceInfos(body, origins)
  try {
    const got = selectFaces(sel, faces, scope)
    if (got.length !== 1) throw new InputError(`${what}要正好选中一个面，现在选中了 ${got.length} 个`)
    if (got[0].kind !== "plane" || !got[0].normal) throw new InputError(`${what}要是平面`)
    return { center: got[0].center, normal: got[0].normal }
  } finally {
    disposeInfos(faces)
  }
}

/** A tapered tool: the straight extrusion's side walls drafted about the sketch plane; a ruled loft to an inset outline if that fails. */
export function tapered(straight: () => Shape3D, loft: () => Shape3D, start: V3, x: V3, dir: V3, angle: number): Shape3D {
  if (!(Math.abs(angle) < 45)) throw new InputError("拔模角要在 -45°–45° 之间（常用 1–3°）")
  const tool = straight()
  const neutral = new Plane(start, x, dir)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tool.draft(angle, (f: any) => f.not((g: any) => g.parallelTo(neutral)), neutral)
  } catch {
    return loft()
  } finally {
    neutral.delete()
    tool.delete()
  }
}

/**
 * A rib from an open path on its plane: the region between the path (extended
 * far at both ends) and the body, on one side, `t` thick across the plane.
 * The side is the one the body closes in; when both do, the side nearer the
 * body's centre (or the other one with `flip`).
 */
export function ribTool(body: Shape3D, path: V2[], plane: Frame, t: number, far: number, flip: boolean): Shape3D {
  if (!(t > 0)) throw new InputError("筋厚必须大于 0")
  if (path.length < 2) throw new InputError("筋的线至少要两个点")
  const d0 = unit2([path[1][0] - path[0][0], path[1][1] - path[0][1]])
  const n = path.length - 1
  const d1 = unit2([path[n][0] - path[n - 1][0], path[n][1] - path[n - 1][1]])
  const ext: V2[] = [[path[0][0] - d0[0] * far, path[0][1] - d0[1] * far], ...path.slice(1, -1), [path[n][0] + d1[0] * far, path[n][1] + d1[1] * far]]
  const along = unit2([ext[ext.length - 1][0] - ext[0][0], ext[ext.length - 1][1] - ext[0][1]])
  const [lo, hi] = body.boundingBox.bounds as [V3, V3]
  const box = makeBox(lo, hi) as unknown as Shape3D
  const eps = 1e-3
  const inside = (s: Shape3D) => {
    const [a, b] = s.boundingBox.bounds as [V3, V3]
    return [0, 1, 2].every((k) => a[k] > lo[k] + eps && b[k] < hi[k] - eps)
  }
  const at3 = (p: V2) => add(plane.origin, add(mul(plane.x, p[0]), mul(plane.y, p[1])))
  const center = mul(add(lo, hi), 0.5)
  const sides = [1, -1].map((s) => {
    const nrm = left(along).map((v) => v * s) as V2
    const poly = [...ext, [ext[ext.length - 1][0] + nrm[0] * far, ext[ext.length - 1][1] + nrm[1] * far] as V2, [ext[0][0] + nrm[0] * far, ext[0][1] + nrm[1] * far] as V2]
    const pl = new Plane(sub(plane.origin, mul(plane.normal, t / 2)), plane.x, plane.normal)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slab = (polygon(poly).sketchOnPlane(pl) as any).extrude(t) as Shape3D
    pl.delete()
    const region = slab.intersect(box).cut(body)
    const kept = solidsOf(region).filter(inside)
    // How near this side's cavity is to the body's middle: its box centre, projected on the plane.
    const mid = at3([(path[0][0] + path[n][0]) / 2 + nrm[0], (path[0][1] + path[n][1]) / 2 + nrm[1]])
    return { kept, near: Math.hypot(...sub(mid, center)) }
  })
  box.delete()
  const usable = sides.filter((x) => x.kept.length)
  if (!usable.length) throw new InputError("筋碰不到实体：线的两侧都没有被实体围住的地方")
  const pick = usable.length === 1 ? usable[0] : [...usable].sort((a, b) => (a.near - b.near) * (flip ? -1 : 1))[0]
  const parts = pick.kept
  return parts.length === 1 ? parts[0] : (makeCompound(parts) as unknown as Shape3D)
}

export const cross3 = cross
