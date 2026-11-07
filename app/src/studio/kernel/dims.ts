// Dimensions on the model: for each feature that built, what its numbers are,
// where they come from (dim-source.ts) and where to draw them. The kernel
// records a little geometry per step while building (`StepGeom`); everything
// here is plain arithmetic on it, so it runs after every rebuild for free.
import type { Feature, Tree } from "../dsl"
import { num, type Scope } from "../expr"
import { dimSource, dimText, type DimKind, type DimSource } from "../dim-source"
import { fieldLabel } from "../param-uses"
import { standardHole } from "../holes"

type V3 = [number, number, number]
type V2 = [number, number]
export type Frame = { origin: V3; x: V3; y: V3; normal: V3 }

/** What a step leaves behind for its dimensions. */
export type StepGeom =
  | { op: "sketch"; plane: Frame }
  | { op: "extrude"; plane: Frame; start: V3; dir: V3; box: [V2, V2] }
  | { op: "revolve"; plane: Frame }
  | { op: "edges"; at: V3; out: V3; count: number }
  | { op: "shell"; at: V3; inward: V3; out: V3 }
  | { op: "hole"; plane: Frame; centers: V3[]; r: number }
  | { op: "faces"; at: V3; out: V3 }
  | { op: "pattern"; seed: V3 | null }

export type DimGeom = { type: "line"; a: V3; b: V3; offset: V3 } | { type: "leader"; at: V3; dir: V3 } | { type: "circle"; center: V3; normal: V3; r: number }

export type Dim = {
  /** Stable within a tree: feature id + field path. */
  id: string
  feature: string
  /** The field in the feature this number lives in. */
  path: (string | number)[]
  kind: DimKind
  value: number
  source: DimSource
  /** In words: the parameter's note, else the field's name (「矩形宽」). */
  label: string
  /** What the label on the model says. */
  text: string
  geom: DimGeom
  /** Higher first when only a few fit: parameter, factor, number. */
  priority: number
  /** False for callouts that aren't one number (a standard hole). */
  editable: boolean
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1))
const AXIS: Record<string, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }
const DIRS: Record<string, V3> = { "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1] }
const PRIORITY: Record<DimSource["type"], number> = { param: 3, factor: 2, literal: 1, derived: 0 }

type Ctx = { tree: Tree; scope: Scope; off: number; geoms: Map<string, StepGeom> }

/** All dimensions of the features that built, in tree order. `off` = how far dimension lines stand off the part. */
export function dimensionsOf(tree: Tree, scope: Scope, geoms: Map<string, StepGeom>, off: number): Dim[] {
  const ctx: Ctx = { tree, scope, off, geoms }
  // Holes copied by a circular pattern: their position is drawn as the pitch circle instead.
  const pitched = new Set(tree.features.flatMap((f) => (f.op === "circular_pattern" ? f.features : [])))
  return tree.features.flatMap((f) => {
    const g = geoms.get(f.id)
    if (!g) return []
    try {
      return featureDims(f, g, ctx, pitched)
    } catch {
      return []
    }
  })
}

function featureDims(f: Feature, g: StepGeom, ctx: Ctx, pitched: Set<string>): Dim[] {
  const out: Dim[] = []
  const n = (v: number | string) => num(v, ctx.scope)
  const push = (path: (string | number)[], kind: DimKind, raw: number | string, geom: DimGeom, o: { value?: number; count?: number; words?: string; editable?: boolean; source?: DimSource; label?: string } = {}) => {
    const value = o.value ?? n(raw)
    const source = o.source ?? dimSource(raw, ctx.scope)
    const bound = source.type === "param" || source.type === "factor" ? ctx.tree.paramNotes?.[source.name] : undefined
    const text = dimText(kind, value, source, o.count)
    out.push({
      id: `${f.id}:${path.join(".")}`,
      feature: f.id,
      path,
      kind,
      value,
      source,
      label: bound ?? o.label ?? fieldLabel(f, path),
      text: o.words && source.type !== "param" ? `${o.words}${text}` : text,
      geom,
      priority: PRIORITY[source.type],
      editable: o.editable ?? true,
    })
  }
  const line = (a: V3, b: V3, offset: V3): DimGeom => ({ type: "line", a, b, offset })
  const leader = (at: V3, dir: V3): DimGeom => ({ type: "leader", at, dir: unit(dir) })
  const off = ctx.off

  if (f.op === "sketch" && g.op === "sketch") {
    const P = at(g.plane)
    const { x, y } = g.plane
    planeOffset(f.on, g.plane, ["on", "offset"], push, line, n, off)
    // The same number on the same axis is drawn once (a profile has many points at x = R).
    const seen = new Set<string>()
    const coord = (path: (string | number)[], raw: number | string, axis: "x" | "y", p: V2) => {
      const v = n(raw)
      if (Math.abs(v) < 1e-9) return
      const key = `${axis}:${typeof raw === "string" ? raw.trim() : v}`
      if (seen.has(key)) return
      seen.add(key)
      const label = `${path.includes("center") ? "中心" : path[0] === "at" ? "孔位" : "轮廓点"} ${axis}`
      if (axis === "x") push(path, "linear", raw, line(P(0, p[1]), P(p[0], p[1]), mul(y, 0.4 * off * Math.sign(p[1] || 1))), { label })
      else push(path, "linear", raw, line(P(p[0], 0), P(p[0], p[1]), mul(x, 0.4 * off * Math.sign(p[0] || 1))), { label })
    }
    f.shapes.forEach((s, i) => {
      const base = ["shapes", i]
      const c: V2 = "center" in s && s.center ? [n(s.center[0]), n(s.center[1])] : [0, 0]
      const center = () => {
        if (!("center" in s) || !s.center) return
        coord([...base, "center", 0], s.center[0], "x", [c[0], 0])
        coord([...base, "center", 1], s.center[1], "y", c)
      }
      switch (s.type) {
        case "rect": {
          const w = n(s.w)
          const h = n(s.h)
          const [x0, x1, y0, y1] = [c[0] - w / 2, c[0] + w / 2, c[1] - h / 2, c[1] + h / 2]
          push([...base, "w"], "linear", s.w, line(P(x0, y0), P(x1, y0), mul(y, -off)))
          push([...base, "h"], "linear", s.h, line(P(x1, y0), P(x1, y1), mul(x, off)))
          if (s.r !== undefined) {
            const r = n(s.r)
            push([...base, "r"], "radius", s.r, leader(P(x1 - r * (1 - Math.SQRT1_2), y1 - r * (1 - Math.SQRT1_2)), add(x, y)))
          }
          center()
          break
        }
        case "circle":
        case "polygon": {
          const r = n(s.d) / 2
          push([...base, "d"], "diameter", s.d, leader(P(c[0] + r * Math.SQRT1_2, c[1] + r * Math.SQRT1_2), add(x, y)), {
            words: s.type === "polygon" ? `${n(s.sides)} 边 ` : undefined,
          })
          center()
          break
        }
        case "slot": {
          const len = n(s.length)
          const a = s.angle !== undefined ? (n(s.angle) * Math.PI) / 180 : 0
          const u: V2 = [Math.cos(a), Math.sin(a)]
          const v: V2 = [-u[1], u[0]]
          const wid = n(s.width)
          const end = (k: number, side: number): V2 => [c[0] + (u[0] * len * k) / 2 + (v[0] * wid * side) / 2, c[1] + (u[1] * len * k) / 2 + (v[1] * wid * side) / 2]
          const dir3 = (d: V2): V3 => add(mul(x, d[0]), mul(y, d[1]))
          push([...base, "length"], "linear", s.length, line(P(...end(-1, -1)), P(...end(1, -1)), mul(dir3(v), -off)), { words: "长 " })
          push([...base, "width"], "linear", s.width, line(P(...end(1, -1)), P(...end(1, 1)), mul(dir3(u), off)), { words: "宽 " })
          center()
          break
        }
        case "text":
          push([...base, "size"], "callout", s.size, leader(P(c[0], c[1]), y), { words: "字号 " })
          center()
          break
        case "polyline":
          s.points.forEach((pt, j) => {
            // A spline's points have no single coordinate to label: its end point carries no dimension.
            if (!Array.isArray(pt) && "spline" in pt) return
            const xy = Array.isArray(pt) ? pt : pt.to
            const path = Array.isArray(pt) ? [...base, "points", j] : [...base, "points", j, "to"]
            const p: V2 = [n(xy[0]), n(xy[1])]
            coord([...path, 0], xy[0], "x", p)
            coord([...path, 1], xy[1], "y", p)
          })
          break
      }
    })
    return out
  }

  if (f.op === "extrude" && g.op === "extrude") {
    const { x, y } = g.plane
    const [lo, hi] = g.box
    const a = add(g.start, add(mul(x, hi[0]), mul(y, lo[1])))
    if (f.distance !== undefined) push(["distance"], "linear", f.distance, line(a, add(a, mul(g.dir, n(f.distance))), mul(unit(sub(x, y)), off)))
    const corner = add(g.start, add(mul(x, lo[0]), mul(y, hi[1])))
    if (f.thin) push(["thin", "t"], "callout", f.thin.t, leader(corner, sub(y, x)), { words: "壁厚 " })
    if (f.draft !== undefined) push(["draft"], "angle", f.draft, leader(add(corner, mul(g.dir, 0.5 * off)), sub(y, x)), { words: "拔模 " })
    return out
  }

  if (f.op === "rib" && g.op === "faces") {
    push(["t"], "callout", f.t, leader(g.at, g.out), { words: "筋厚 " })
    return out
  }

  if (f.op === "revolve" && g.op === "revolve") {
    if (f.angle !== undefined && n(f.angle) < 360 - 1e-9) push(["angle"], "angle", f.angle, leader(g.plane.origin, g.plane.normal))
    return out
  }

  if ((f.op === "fillet" || f.op === "chamfer") && g.op === "edges") {
    const raw = f.op === "fillet" ? f.r : f.d
    push([f.op === "fillet" ? "r" : "d"], f.op === "fillet" ? "radius" : "chamfer", raw, leader(g.at, g.out), { count: g.count })
    return out
  }

  if (f.op === "shell" && g.op === "shell") {
    push(["t"], "linear", f.t, line(g.at, add(g.at, mul(g.inward, n(f.t))), mul(g.out, 0.6 * off)), { words: "壁厚 " })
    return out
  }

  if (f.op === "hole" && g.op === "hole") {
    const { x, y } = g.plane
    const c0 = g.centers[0]
    const rim = add(c0, mul(unit(add(x, y)), g.r))
    const count = g.centers.length
    if (f.standard) {
      const std = standardHole(f.standard)
      push(["standard"], "callout", 0, leader(rim, add(x, y)), { value: std.d, source: { type: "literal" }, editable: false })
      out[out.length - 1].text = `${count > 1 ? `${count}×` : ""}${std.label.replace(/（.*）/, "")}`
    } else if (f.d !== undefined) {
      push(["d"], "diameter", f.d, leader(rim, add(x, y)), { count })
      if (f.depth !== undefined) out[out.length - 1].text += ` ↧${n(f.depth)}`
    }
    planeOffset(f.on, g.plane, ["on", "offset"], push, line, n, off)
    if (!pitched.has(f.id) && f.at[0]) {
      const [u, v] = f.at[0]
      const P = at(g.plane)
      const p: V2 = [n(u), n(v)]
      if (Math.abs(p[0]) > 1e-9) push(["at", 0, 0], "linear", u, line(P(0, p[1]), P(p[0], p[1]), mul(y, 0.4 * off * Math.sign(p[1] || 1))))
      if (Math.abs(p[1]) > 1e-9) push(["at", 0, 1], "linear", v, line(P(p[0], 0), P(p[0], p[1]), mul(x, 0.4 * off * Math.sign(p[0] || 1))))
    }
    return out
  }

  if (f.op === "circular_pattern" && g.op === "pattern") {
    const axis = AXIS[f.axis]
    const seedHole = f.features.map((id) => ctx.tree.features.find((x) => x.id === id)).find((x) => x?.op === "hole")
    const hg = seedHole ? ctx.geoms.get(seedHole.id) : undefined
    const seed = hg?.op === "hole" ? hg.centers[0] : g.seed
    if (seed) {
      const foot = mul(axis, dot(seed, axis))
      const r = Math.hypot(...sub(seed, foot))
      if (r > 1e-9 && seedHole?.op === "hole" && hg?.op === "hole") {
        // The pitch circle: whichever coordinate of the seed hole carries the radius.
        const [u, v] = seedHole.at[0]
        const [pu, pv] = [n(u), n(v)]
        const k = Math.abs(pu) >= Math.abs(pv) ? 0 : 1
        const raw = k === 0 ? u : v
        const src = dimSource(raw, ctx.scope)
        const value = 2 * r
        const source: DimSource =
          src.type === "factor" && Math.abs(Math.abs(2 * src.k) - 1) < 1e-9
            ? { type: "param", name: src.name }
            : src.type === "param"
              ? { type: "factor", name: src.name, k: 2, expr: `2×${src.name}` }
              : src
        // Editable through its parameter only: the field holds a radius, the label a diameter.
        push(["pcd"], "diameter", 0, { type: "circle", center: foot, normal: axis, r }, { value, source, editable: source.type === "param" || source.type === "factor" })
        const last = out[out.length - 1]
        last.label = source.type === "param" ? (ctx.tree.paramNotes?.[source.name] ?? "节圆直径") : "节圆直径"
      }
      push(["count"], "count", f.count, leader(foot, axis), { words: "", count: 1 })
      const cnt = out[out.length - 1]
      cnt.text = `${n(f.count)}× 均布${cnt.source.type === "param" ? `（${(cnt.source as { name: string }).name}）` : ""}`
    }
    return out
  }

  if (f.op === "linear_pattern" && g.op === "pattern" && g.seed) {
    const step = mul(DIRS[f.dir], n(f.spacing))
    const side = Math.abs(DIRS[f.dir][2]) > 0.9 ? ([1, 0, 0] as V3) : ([0, 0, 1] as V3)
    push(["spacing"], "linear", f.spacing, line(g.seed, add(g.seed, step), mul(side, 0.6 * off)), { words: `${n(f.count)}× 间距 ` })
    return out
  }

  if (f.op === "draft" && g.op === "faces") {
    push(["angle"], "angle", f.angle, leader(g.at, g.out), { words: "拔模 " })
    return out
  }
  return out
}

const at =
  (p: Frame) =>
  (u: number, v: number): V3 =>
    add(p.origin, add(mul(p.x, u), mul(p.y, v)))

/** A datum plane moved along its normal: drawn from the datum to the sketch plane. */
function planeOffset(
  on: { offset?: number | string; face?: unknown } | undefined,
  plane: Frame,
  path: (string | number)[],
  push: (path: (string | number)[], kind: DimKind, raw: number | string, geom: DimGeom, o?: { words?: string }) => void,
  line: (a: V3, b: V3, offset: V3) => DimGeom,
  n: (v: number | string) => number,
  off: number,
) {
  if (!on || on.offset === undefined || on.face) return
  const d = n(on.offset)
  if (Math.abs(d) < 1e-9) return
  push(path, "linear", on.offset, line(sub(plane.origin, mul(plane.normal, d)), plane.origin, mul(plane.x, -off)), { words: "偏移 " })
}
