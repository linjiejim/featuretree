// Requirement checks (dsl.ts `Check`): the learner's numbers, measured on the
// latest body by the kernel, not taken on the assistant's word.
import { getOC, makeCompound, measureDistanceBetween, measureShapeVolumeProperties, type AnyShape, type Shape3D } from "replicad"
import type { Check, EdgeSelector, FaceSelector } from "../dsl"
import type { Scope } from "../expr"
import { METRIC, type ScrewSize } from "../holes"
import { measure, positionOf } from "./measure"
import { relation, relationText } from "./proximity"
import { compoundOf } from "./topo"
import { disposeInfos, edgeInfos, faceInfos, selectEdges, selectFaces, type EdgeInfo, type FaceInfo } from "./select"

type V3 = [number, number, number]

export type CheckResult = {
  id: string
  said: string
  pass: boolean
  /** The check itself can't be measured (its selector picks nothing or too much): the item is wrong, not the part. */
  invalid?: boolean
  /** 「80 × 50 × 30」 */
  expected: string
  actual: string
  /** Faces / edges measured, to light them up when the row is pointed at. */
  faces: number[]
  edges: number[]
}

const fmt = (x: number) => String(Math.round(x * 100) / 100)
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(...a)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OC = any

/** At most this many faces or edges per item: a selector that wide isn't one requirement. */
const MAX_ITEMS = 50

/**
 * What a check can name besides faces and edges: reference bodies (`import`, and the other parts when
 * editing inside an assembly) by id and by name, and the model's parts by name.
 */
export type CheckBodies = { refs: Map<string, AnyShape>; parts: { name: string; body: Shape3D }[] }

export function runChecks(body: Shape3D, origins: string[], checks: Check[], scope: Scope, bodies: CheckBodies = { refs: new Map(), parts: [] }): CheckResult[] {
  const faces = faceInfos(body, origins)
  const edges = edgeInfos(body, faces)
  try {
    return checks.map((c) => {
      const base = { id: c.id, said: c.said, faces: [] as number[], edges: [] as number[] }
      try {
        return {
          ...base,
          ...(c.kind === "clearance" || c.kind === "interference"
            ? fit(c, body, bodies)
            : c.kind === "gap"
              ? gap(c, faces, edges, scope, bodies)
              : c.kind === "position"
                ? position(c, faces, edges, scope)
                : one(c, body, origins, faces, edges, scope)),
        }
      } catch (e) {
        const first = ((e as Error).message || "没找到要量的东西").split("\n")[0].replace(/。?候选：$/, "")
        return { ...base, pass: false, invalid: true, expected: expectedOf(c), actual: first }
      }
    })
  } finally {
    disposeInfos(faces, edges)
  }
}

function expectedOf(c: Check): string {
  switch (c.kind) {
    case "size":
      return c.expect.map(fmt).join(" × ")
    case "holes":
      return `${c.count} 个${c.thread ? ` ${c.thread}` : c.d !== undefined ? ` ⌀${fmt(c.d)}` : ""}`
    case "pcd":
      return `${c.count} 个在 ⌀${fmt(c.expect)} 上`
    case "angle":
      return `${fmt(c.expect)}°`
    case "volume":
      return [c.min !== undefined && `≥ ${fmt(c.min / 1000)} cm³`, c.max !== undefined && `≤ ${fmt(c.max / 1000)} cm³`].filter(Boolean).join("，")
    case "clearance":
      return `和「${c.ref}」至少隔 ${fmt(c.min)} mm`
    case "interference":
      return `和「${c.ref}」不相交`
    case "position":
      return Array.isArray(c.expect) ? `(${c.expect.map(fmt).join(", ")})` : `${c.axis ?? "?"} = ${fmt(c.expect)}`
    case "gap":
      return [c.max === 0 ? "贴在一起" : c.max !== undefined && `≤ ${fmt(c.max)} mm`, c.min !== undefined && `≥ ${fmt(c.min)} mm`].filter(Boolean).join("，") || "量间隙"
    default:
      return `${fmt(c.expect)} mm`
  }
}

type FitCheck = Extract<Check, { kind: "clearance" | "interference" }>
type Where = Extract<Check, { kind: "gap" }>["a"]

/** A reference body or a part, by name; with a part, the rest of the model is the other side. */
function named(name: string, bodies: CheckBodies): { shape: AnyShape; rest: AnyShape | null } | null {
  const ref = bodies.refs.get(name)
  if (ref) return { shape: ref, rest: null }
  const k = bodies.parts.findIndex((p) => p.name === name)
  if (k < 0) return null
  const others = bodies.parts.filter((_, i) => i !== k).map((p) => p.body)
  // compoundOf, not makeCompound: replicad's would free the parts.
  return { shape: bodies.parts[k].body, rest: others.length ? compoundOf(others) : null }
}

const namesOf = (bodies: CheckBodies) => [...new Set([...bodies.refs.keys(), ...bodies.parts.map((p) => p.name)])]

/** The model against a reference body or one of its parts: the gap between them, and whether they overlap. */
function fit(c: FitCheck, body: Shape3D, bodies: CheckBodies): Omit<CheckResult, "id" | "said"> {
  const expected = expectedOf(c)
  const hit = named(c.ref, bodies)
  if (!hit) {
    const names = namesOf(bodies)
    throw new Error(`没有参考体或零件「${c.ref}」${names.length ? `：现在有 ${names.join("、")}` : "：要先用 import 导入，ref 写那个特征的 id"}`)
  }
  if (hit.rest === null && bodies.parts.some((p) => p.name === c.ref)) throw new Error(`只有「${c.ref}」一个零件，没有别的可以比`)
  try {
    return fitOf(c, expected, (hit.rest ?? body) as Shape3D, hit.shape)
  } finally {
    hit.rest?.delete()
  }
}

function fitOf(c: FitCheck, expected: string, other: Shape3D, ref: AnyShape): Omit<CheckResult, "id" | "said"> {
  const gap = measureDistanceBetween(other, ref)
  // Apart: no overlap, no boolean needed (they can take seconds on a board with many parts).
  const overlap = gap > 1e-6 ? 0 : overlapVolume(other, ref)
  const where = overlap > 1e-6 ? `相交 ${fmt(overlap)} mm³` : gap > 1e-6 ? `最小间隙 ${fmt(gap)} mm` : "贴在一起"
  if (c.kind === "interference") return { pass: overlap <= 1e-6, expected, actual: where, faces: [], edges: [] }
  return { pass: overlap <= 1e-6 && gap >= c.min - (c.tol ?? 0.01), expected, actual: where, faces: [], edges: [] }
}

/** The shape one side of a `gap` stands for (made shapes go into `owned`) and the faces / edges to light up. */
function whereShape(w: Where, faces: FaceInfo[], edges: EdgeInfo[], scope: Scope, bodies: CheckBodies, owned: AnyShape[]): { shape: AnyShape; solid: boolean; faces: number[]; edges: number[] } {
  if (w.part) {
    const ref = bodies.refs.get(w.part)
    if (ref) return { shape: ref, solid: true, faces: [], edges: [] }
    const p = bodies.parts.find((x) => x.name === w.part)
    if (!p) {
      const names = namesOf(bodies)
      throw new Error(`没有零件或参考体「${w.part}」${names.length ? `：现在有 ${names.join("、")}` : ""}`)
    }
    return { shape: p.body, solid: true, faces: [], edges: [] }
  }
  if (w.feature) {
    const mine = faces.filter((f) => f.origin === w.feature)
    if (!mine.length) throw new Error(`特征「${w.feature}」现在没有面（被后面的特征盖掉了，或者 id 写错了）`)
    const shape = makeCompound(mine.map((f) => f.face.clone())) as unknown as AnyShape
    owned.push(shape)
    return { shape, solid: false, faces: mine.map((f) => f.face.hashCode), edges: [] }
  }
  if (w.face) {
    const got = selectFaces(w.face, faces, scope)
    if (got.length !== 1) throw new Error(`选择器要正好选中一个面，现在选中了 ${got.length} 个`)
    return { shape: got[0].face, solid: false, faces: [got[0].face.hashCode], edges: [] }
  }
  if (w.edge) {
    const got = selectEdges(w.edge, edges, faces, scope)
    if (got.length !== 1) throw new Error(`选择器要正好选中一条边，现在选中了 ${got.length} 条`)
    return { shape: got[0].edge, solid: false, faces: [], edges: [got[0].edge.hashCode] }
  }
  throw new Error("a、b 各写 face、edge、feature、part 之一")
}

/** The shortest distance between two places (0 when solids overlap, with the overlap reported). */
function gap(c: Extract<Check, { kind: "gap" }>, faces: FaceInfo[], edges: EdgeInfo[], scope: Scope, bodies: CheckBodies): Omit<CheckResult, "id" | "said"> {
  if (c.min === undefined && c.max === undefined) throw new Error("gap 至少写 min 或 max 之一（max: 0 = 必须贴上）")
  const owned: AnyShape[] = []
  try {
    const a = whereShape(c.a, faces, edges, scope, bodies, owned)
    const b = whereShape(c.b, faces, edges, scope, bodies, owned)
    const r = relation(a.shape, b.shape, a.solid && b.solid)
    const tol = c.tol ?? 0.01
    const d = r.overlap > 1e-6 ? 0 : r.d
    const pass = (c.max === undefined || d <= c.max + tol) && (c.min === undefined || (r.overlap <= 1e-6 && d >= c.min - tol))
    return { pass, expected: expectedOf(c), actual: relationText(r), faces: [...a.faces, ...b.faces], edges: [...a.edges, ...b.edges] }
  } finally {
    owned.forEach((s) => s.delete())
  }
}

/** Where a face or edge sits: a plane's centre, a cylinder's or circle's centre, a line's midpoint. */
function position(c: Extract<Check, { kind: "position" }>, faces: FaceInfo[], edges: EdgeInfo[], scope: Scope): Omit<CheckResult, "id" | "said"> {
  const tol = c.tol ?? 0.01
  let p: V3
  let lit: { faces: number[]; edges: number[] }
  if (c.at.face) {
    const got = selectFaces(c.at.face, faces, scope)
    if (got.length !== 1) throw new Error(`选择器要正好选中一个面，现在选中了 ${got.length} 个`)
    p = positionOf("face", got[0])
    lit = { faces: [got[0].face.hashCode], edges: [] }
  } else if (c.at.edge) {
    const got = selectEdges(c.at.edge, edges, faces, scope)
    if (got.length !== 1) throw new Error(`选择器要正好选中一条边，现在选中了 ${got.length} 条`)
    p = positionOf("edge", got[0])
    lit = { faces: [], edges: [got[0].edge.hashCode] }
  } else throw new Error("at 写 face 或 edge")
  const AX = { X: 0, Y: 1, Z: 2 } as const
  if (Array.isArray(c.expect)) {
    if (c.axis) throw new Error("写了 axis 时，expect 是一个数")
    const want = c.expect
    return { pass: want.every((w, i) => Math.abs(w - p[i]) <= tol), expected: expectedOf(c), actual: `(${p.map(fmt).join(", ")})`, ...lit }
  }
  if (!c.axis) throw new Error("expect 是一个数时要写 axis（X、Y 或 Z）")
  const v = p[AX[c.axis]]
  return { pass: Math.abs(v - c.expect) <= tol, expected: expectedOf(c), actual: `${c.axis} = ${fmt(v)}`, ...lit }
}

function overlapVolume(body: Shape3D, ref: AnyShape): number {
  if (!("intersect" in ref)) return 0
  const common = body.intersect(ref as Shape3D)
  try {
    return measureShapeVolumeProperties(common).volume
  } finally {
    common.delete()
  }
}

function one(c: Exclude<Check, FitCheck | { kind: "gap" | "position" }>, body: Shape3D, origins: string[], faces: FaceInfo[], edges: ReturnType<typeof edgeInfos>, scope: Scope): Omit<CheckResult, "id" | "said"> {
  const tol = c.tol ?? (c.kind === "angle" ? 0.05 : 0.01)
  const expected = expectedOf(c)
  const pickFaces = (sel: FaceSelector) => {
    const got = selectFaces(sel, faces, scope)
    if (!got.length) throw new Error("没找到要量的东西")
    if (got.length > MAX_ITEMS) throw new Error("量的范围太大，缩小选择器")
    return got
  }
  switch (c.kind) {
    case "size": {
      const [a, b] = body.boundingBox.bounds as [V3, V3]
      const size = sub(b, a)
      const want = c.axes === "any" ? [...c.expect].sort((x, y) => x - y) : c.expect
      const got = c.axes === "any" ? [...size].sort((x, y) => x - y) : size
      return { pass: want.every((w, i) => Math.abs(w - got[i]) <= tol), expected, actual: size.map(fmt).join(" × "), faces: [], edges: [] }
    }
    case "thickness": {
      const sel = pickFaces(c.faces)
      let best = Infinity
      for (const a of sel) {
        if (a.kind !== "plane" || !a.normal) continue
        for (const b of faces) {
          if (b === a || b.kind !== "plane" || !b.normal || dot(a.normal, b.normal) > -0.999) continue
          const gap = Math.abs(dot(sub(b.center, a.center), a.normal))
          // Facing planes that overlap across the wall: their shortest distance is the plane gap.
          if (gap > 1e-6 && gap < best && Math.abs(faceDistance(a, b) - gap) < 1e-6) best = gap
        }
      }
      if (!Number.isFinite(best)) throw new Error("选中的面对面没有平行的另一侧")
      return { pass: Math.abs(best - c.expect) <= tol, expected, actual: `${fmt(best)} mm`, faces: sel.map((f) => f.face.hashCode), edges: [] }
    }
    case "holes":
    case "pcd": {
      const sel = pickFaces(c.faces).filter((f) => f.kind === "cylinder")
      const holes = axesOf(sel)
      const hashes = sel.map((f) => f.face.hashCode)
      if (c.kind === "holes") {
        const d = c.thread ? METRIC[c.thread as ScrewSize]?.tap : c.d
        if (c.thread && d === undefined) throw new Error(`不认识的螺纹规格「${c.thread}」`)
        const ds = holes.map((h) => 2 * h.r)
        const sizeOk = d === undefined || ds.every((x) => Math.abs(x - d) <= tol)
        const actual = `${holes.length} 个${ds.length ? ` ⌀${[...new Set(ds.map(fmt))].join("/")}` : ""}`
        return { pass: holes.length === c.count && sizeOk, expected, actual, faces: hashes, edges: [] }
      }
      const axis: V3 = c.axis === "X" ? [1, 0, 0] : c.axis === "Y" ? [0, 1, 0] : [0, 0, 1]
      const radii = holes.map((h) => len(cross(h.p, axis)))
      const pcds = [...new Set(radii.map((r) => fmt(2 * r)))]
      const pass = holes.length === c.count && radii.every((r) => Math.abs(2 * r - c.expect) <= tol)
      return { pass, expected, actual: `${holes.length} 个在 ⌀${pcds.join("/")} 上`, faces: hashes, edges: [] }
    }
    case "distance":
    case "angle": {
      const targets = [c.a, c.b].map((p) => {
        const isFace = c.kind === "angle" || !!(p as { face?: FaceSelector }).face
        if (isFace) {
          const sel = c.kind === "angle" ? (p as FaceSelector) : (p as { face: FaceSelector }).face
          const got = pickFaces(sel)
          if (got.length !== 1) throw new Error(`选择器要正好选中一个面，现在选中了 ${got.length} 个`)
          return { kind: "face" as const, hash: got[0].face.hashCode, point: got[0].center }
        }
        const got = selectEdges((p as { edge?: EdgeSelector }).edge ?? {}, edges, faces, scope)
        if (got.length !== 1) throw new Error(`选择器要正好选中一条边，现在选中了 ${got.length} 条`)
        return { kind: "edge" as const, hash: got[0].edge.hashCode, point: got[0].mid }
      })
      const m = measure(body, origins, targets)
      if (!m) throw new Error("没找到要量的东西")
      const pick = (names: string[]) => m.between.find((b) => names.includes(b.name))
      const row =
        c.kind === "angle"
          ? (pick(["两面夹角", "轴线与平面夹角", "轴线夹角"]) ?? (pick(["平行面间距"]) ? { name: "", value: "0°" } : undefined))
          : pick(["平行面间距", "圆心到平面", "轴线间距", "圆心距", "边到平面", "平行，间距"]) ?? pick(["最短距离"])
      if (!row) throw new Error("这两处之间量不出这个量")
      const v = parseFloat(row.value)
      return {
        pass: Math.abs(v - c.expect) <= tol,
        expected,
        actual: c.kind === "angle" ? `${fmt(v)}°` : `${fmt(v)} mm`,
        faces: targets.filter((t) => t.kind === "face").map((t) => t.hash),
        edges: targets.filter((t) => t.kind === "edge").map((t) => t.hash),
      }
    }
    case "volume": {
      const v = measureShapeVolumeProperties(body).volume
      const slack = 0.005 * v
      const pass = (c.min === undefined || v >= c.min - slack) && (c.max === undefined || v <= c.max + slack)
      return { pass, expected, actual: `${fmt(v / 1000)} cm³`, faces: [], edges: [] }
    }
  }
}

/** Cylinder faces grouped by axis line: one hole each (a counterbore's two radii count once, by the smaller). */
function axesOf(cyls: FaceInfo[]): { p: V3; d: V3; r: number }[] {
  const out: { p: V3; d: V3; r: number }[] = []
  for (const f of cyls) {
    const ax = cylinderAxis(f)
    if (!ax) continue
    const same = out.find((h) => Math.abs(Math.abs(dot(h.d, ax.d)) - 1) < 1e-6 && len(cross(sub(ax.p, h.p), h.d)) < 1e-4)
    if (same) same.r = Math.min(same.r, ax.r)
    else out.push(ax)
  }
  return out
}

export function cylinderAxis(f: FaceInfo): { p: V3; d: V3; r: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ad: any = (f.face as any)._geomAdaptor()
  try {
    const c = ad.Cylinder()
    const ax = c.Axis()
    const loc = ax.Location()
    const dir = ax.Direction()
    return { p: [loc.X(), loc.Y(), loc.Z()], d: [dir.X(), dir.Y(), dir.Z()], r: c.Radius() }
  } catch {
    return null
  } finally {
    ad.delete?.()
  }
}

function faceDistance(a: FaceInfo, b: FaceInfo): number {
  const oc: OC = getOC()
  const dss = new oc.BRepExtrema_DistShapeShape()
  try {
    dss.LoadS1(a.face.wrapped)
    dss.LoadS2(b.face.wrapped)
    dss.Perform()
    return dss.IsDone() ? dss.Value() : Infinity
  } finally {
    dss.delete()
  }
}
