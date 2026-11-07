// Feature tree → build123d (algebra mode) Python. The same model as code-CAD,
// one block per feature, so learners can carry it to a real toolchain and
// compare it with the teardowns' code. Selectors become build123d filters;
// `of` (provenance) is approximated by "lies on that feature's tool body".
//
// A tree may come from someone else (a shared link, an imported file), and the
// learner runs the exported file. So nothing from the tree reaches the Python
// as written: expressions are parsed and printed back from the parse (numbers,
// known parameters, operators, the functions expr.ts allows), ids must be ids,
// text goes through JSON.stringify, and comments lose their line breaks. What
// can't be printed safely becomes None and is listed at the top of the file.
import { standardHole } from "./holes"
import type { EdgeSelector, FaceSelector, Feature, PlaneRef, Point, SketchShape } from "./dsl"
import { displayName, Tree } from "./dsl"
import { CONST_NAMES, FUNC_NAMES, namesIn, parse, type ExprNode } from "./expr"

type N = number | string

/** What is being written (for problem messages) and what may be referenced. */
type Ctx = { problems: string[]; params: Set<string>; badParams: Set<string>; where: string; feature: Feature | null }
// Generation is synchronous: one context at a time.
let ctx: Ctx = { problems: [], params: new Set(), badParams: new Set(), where: "", feature: null }

/** One physical line: no line breaks or other control characters (a comment can't end early). */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)

function problem(why: string, field?: string) {
  const msg = oneLine(`${ctx.where}${field ? `的 ${field}` : ""}：${why}`)
  if (!ctx.problems.includes(msg)) ctx.problems.push(msg)
  return "None"
}

/** Where a value sits in the feature being written, e.g. "shapes[0].w". */
function fieldOf(v: unknown, target: unknown, path = ""): string | null {
  if (v === target) return path
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = fieldOf(v[i], target, `${path}[${i}]`)
      if (p !== null) return p
    }
  } else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      const p = fieldOf(x, target, path ? `${path}.${k}` : k)
      if (p !== null) return p
    }
  return null
}

const bad = (raw: N, why: string) => problem(why, (ctx.feature && fieldOf(ctx.feature, raw)) || undefined)

/** A number or an expression, as Python: printed back from its parse, never copied. */
const py = (raw: N): string => {
  if (typeof raw === "number") return Number.isFinite(raw) ? fmt(raw) : bad(raw, "数值不是有限数")
  if (typeof raw !== "string") return bad(raw, "不是数值或表达式")
  let node: ExprNode
  try {
    node = parse(raw)
  } catch (e) {
    // The reason without the expression itself: what can't be parsed is never written out, not even in a comment.
    return bad(raw, `表达式解析不了（${(e as Error).message.split("：")[0]}）`)
  }
  for (const name of names(node)) {
    if (ctx.badParams.has(name)) return bad(raw, `参数名「${clip(name)}」不能用作 Python 变量名`)
    if (!ctx.params.has(name) && !CONST_NAMES.includes(name)) return bad(raw, `没有名为「${clip(name)}」的参数`)
  }
  const out = pyExpr(node)
  return node.k === "name" || node.k === "num" || node.k === "call" ? out : `(${out})`
}

function names(n: ExprNode): string[] {
  if (n.k === "name") return [n.v]
  if (n.k === "neg") return names(n.a)
  if (n.k === "bin") return [...names(n.a), ...names(n.b)]
  if (n.k === "call") return n.args.flatMap(names)
  return []
}

/** Python precedence, high binds tighter: + - 1, * / 2, unary minus 3, ** 4, atoms 5. */
const prec = (n: ExprNode) => (n.k === "bin" ? (n.op === "^" ? 4 : n.op === "*" || n.op === "/" ? 2 : 1) : n.k === "neg" ? 3 : 5)
const wrap = (n: ExprNode, min: number) => (prec(n) < min ? `(${pyExpr(n)})` : pyExpr(n))

function pyExpr(n: ExprNode): string {
  switch (n.k) {
    case "num":
      return String(n.v)
    case "name":
      return n.v
    case "neg":
      return `-${wrap(n.a, 3)}`
    case "call":
      // Only FUNCS parse as calls; the file defines the ones Python lacks.
      return FUNC_NAMES.includes(n.f) ? `${n.f}(${n.args.map(pyExpr).join(", ")})` : "None"
    case "bin":
      // The expression grammar's base of ^ is a unary, so -2^2 is (-2)**2.
      if (n.op === "^") return `${wrap(n.a, 5)}**${wrap(n.b, 3)}`
      if (n.op === "+" || n.op === "-") return `${wrap(n.a, 1)} ${n.op} ${wrap(n.b, 2)}`
      return `${wrap(n.a, 2)}${n.op}${wrap(n.b, 3)}`
  }
}

/** Counts can be expressions; Python's range() needs an int. */
const pyInt = (v: N) => (typeof v === "number" ? py(v) : `round(${py(v)})`)
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1e6) / 1e6))
const neg = (v: N) => (typeof v === "number" ? py(-v) : `-${py(v)}`)

const ID = /^[A-Za-z][A-Za-z0-9_]*$/
/** A feature id inside a Python name (sk_base, tool_base). */
const ref = (prefix: string, id: string) => (typeof id === "string" && ID.test(id) ? `${prefix}_${id}` : problem(`引用的特征 id「${clip(oneLine(String(id)))}」不合法`))

/** Python keywords and the names the file's own helpers live under: not usable as parameter names. */
const RESERVED = new Set([
  ...FUNC_NAMES,
  ...CONST_NAMES,
  ..."math part parts joined split_plane rib on_face on_feature round_corners onto_band show_object".split(" "),
  ..."False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
])
const safeName = (k: string) => /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/.test(k) && !k.startsWith("__") && !RESERVED.has(k)

const AXIS: Record<string, string> = { X: "Axis.X", Y: "Axis.Y", Z: "Axis.Z" }
const KIND_FACE: Record<string, string> = { plane: "PLANE", cylinder: "CYLINDER", cone: "CONE", sphere: "SPHERE", torus: "TORUS", freeform: "BSPLINE" }
const KIND_EDGE: Record<string, string> = { line: "LINE", circle: "CIRCLE", freeform: "BSPLINE" }
const DIR_VEC: Record<string, string> = { "+X": "(1, 0, 0)", "-X": "(-1, 0, 0)", "+Y": "(0, 1, 0)", "-Y": "(0, -1, 0)", "+Z": "(0, 0, 1)", "-Z": "(0, 0, -1)" }

function plane(ref: { plane: "XY" | "XZ" | "YZ"; offset?: N }, extra?: string) {
  // build123d's XZ plane faces -Y, so a Y coordinate is a negative offset; XY and YZ offset along +Z / +X.
  const parts = [ref.offset !== undefined ? (ref.plane === "XZ" ? neg(ref.offset) : py(ref.offset)) : null, extra].filter(Boolean)
  return parts.length ? `Plane.${ref.plane}.offset(${parts.join(" + ")})` : `Plane.${ref.plane}`
}

function sketchPlane(on: PlaneRef) {
  if (!on.face) {
    if (!on.tilt) return plane(on)
    const a = py(on.tilt.angle)
    return `${plane(on)}.move(Rot(${on.tilt.axis}=${a}))`
  }
  const axis = { XY: "Z", XZ: "Y", YZ: "X" }[on.plane]
  const sign = on.plane === "XZ" ? "-" : ""
  // The face's coordinate along the plane's axis, then the plane through it; an inclined face gets its own plane.
  const face = `${faces(on.face)}[0]`
  return `on_face(${face}, ${plane(on, `${sign}${face}.center().${axis}`)}, ${on.offset !== undefined ? py(on.offset) : "0"})`
}

function shape2d(s: SketchShape): string {
  const at = s.type !== "polyline" && s.type !== "path" && s.center ? `Pos(${py(s.center[0])}, ${py(s.center[1])}) * ` : ""
  switch (s.type) {
    case "rect":
      return s.r !== undefined ? `${at}RectangleRounded(${py(s.w)}, ${py(s.h)}, ${py(s.r)})` : `${at}Rectangle(${py(s.w)}, ${py(s.h)})`
    case "circle":
      return `${at}Circle(${py(s.d)} / 2)`
    case "polygon":
      return `${at}RegularPolygon(${py(s.d)} / 2, ${pyInt(s.sides)}${s.rotate !== undefined ? `, rotation=${py(s.rotate)}` : ""})`
    case "text":
      // Needs Noto Sans SC installed (or font_path=…) for the same outlines as the studio.
      // JSON.stringify escapes quotes, backslashes and line breaks: one line, a valid Python literal.
      return `${at}Text(${JSON.stringify(String(s.text))}, ${py(s.size)}, font="Noto Sans SC"${s.angle !== undefined ? `, rotation=${py(s.angle)}` : ""})`
    case "slot":
      return `${at}SlotOverall(${py(s.length)}, ${py(s.width)}${s.angle !== undefined ? `, rotation=${py(s.angle)}` : ""})`
    case "path":
      return pathCurve(s.points)
    case "polyline": {
      const pts = points(s.points)
      const segs: string[] = []
      const rounded: string[] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i].to
        const next = pts[(i + 1) % pts.length]
        if (i === pts.length - 1 && !next.via && !next.spline && JSON.stringify(a) === JSON.stringify(pts[0].to)) break
        segs.push(segment(a, next))
        if (next.r !== undefined) rounded.push(`(${xy(next.to)}, ${py(next.r)})`)
      }
      const face = `make_face([${segs.join(", ")}])`
      return rounded.length ? `round_corners(${face}, [${rounded.join(", ")}])` : face
    }
  }
}

type Pt = { to: N[]; via?: N[]; r?: N; spline?: N[][] }
/** Points in one shape: a corner, an arc through `via`, a rounded corner, or a spline ending at its last point. */
function points(raw: Point[]): Pt[] {
  return raw.map((p) => (Array.isArray(p) ? { to: p } : "spline" in p ? { to: p.spline[p.spline.length - 1], spline: p.spline } : p))
}
const xy = (p: N[]) => `(${py(p[0])}, ${py(p[1])})`
/** The segment from `a` to the next point. */
function segment(a: N[], p: Pt): string {
  if (p.via) return `ThreePointArc(${xy(a)}, ${xy(p.via)}, ${xy(p.to)})`
  if (p.spline) return `Spline(${[a, ...p.spline].map(xy).join(", ")})`
  return `Line(${xy(a)}, ${xy(p.to)})`
}

/** An open path as one curve: straight runs, arcs as ThreePointArc, splines as Spline. */
function pathCurve(raw: Point[]): string {
  const pts = points(raw)
  const segs = pts.slice(1).map((p, i) => segment(pts[i].to, p))
  return segs.length === 1 ? segs[0] : `Curve() + [${segs.join(", ")}]`
}

/** An open path's corner points, for the rib helper (arcs by their end points). */
function pathPointsPy(raw: Point[]): string {
  return `[${points(raw)
    .map((p) => p.to)
    .map((p) => `(${py(p[0])}, ${py(p[1])})`)
    .join(", ")}]`
}

function faces(sel: FaceSelector, base = "part.faces()"): string {
  const main = faceFilter(sel, base)
  return sel.not ? `(${main} - ${faceFilter(sel.not, base)})` : main
}

function faceFilter(sel: Omit<FaceSelector, "not" | "expect">, base: string) {
  let e = base
  if (sel.of) e = `on_feature(${e}, ${ref("tool", sel.of)})`
  if (sel.kind) e += `.filter_by(GeomType.${KIND_FACE[sel.kind]})`
  if (sel.normal) {
    const [s, a] = [sel.normal[0], sel.normal[1]]
    e += `.filter_by(lambda f: f.geom_type == GeomType.PLANE and ${s === "-" ? "-" : ""}f.normal_at().${a} > 0.9999)`
  }
  if (sel.radius !== undefined) e += `.filter_by(lambda f: abs(f.radius - ${py(sel.radius)}) < 1e-3)`
  if (sel.at) e += `.filter_by_position(${AXIS[sel.at.axis]}, ${py(sel.at.value)} - 1e-3, ${py(sel.at.value)} + 1e-3)`
  if (sel.extreme) e += `.group_by(${AXIS[sel.extreme[1]]})[${sel.extreme[0] === "+" ? "-1" : "0"}]`
  if (sel.near) e += `.sort_by_distance(Vector(${sel.near.map(py).join(", ")}))[:1]`
  return e
}

function edges(sel: EdgeSelector): string {
  const main = edgeFilter(sel)
  return sel.not ? `(${main} - ${edgeFilter(sel.not)})` : main
}

function edgeFilter(sel: Omit<EdgeSelector, "not" | "expect">) {
  let e = sel.faces ? `${faces(sel.faces)}.edges()` : "part.edges()"
  if (sel.of) e = `on_feature(${e}, ${ref("tool", sel.of)})`
  if (sel.kind) e += `.filter_by(GeomType.${KIND_EDGE[sel.kind]})`
  if (sel.parallel) e += `.filter_by(${AXIS[sel.parallel]})`
  if (sel.radius !== undefined) e += `.filter_by(lambda e: abs(e.radius - ${py(sel.radius)}) < 1e-3)`
  if (sel.at) e += `.filter_by_position(${AXIS[sel.at.axis]}, ${py(sel.at.value)} - 1e-3, ${py(sel.at.value)} + 1e-3)`
  if (sel.extreme) e += `.group_by(${AXIS[sel.extreme[1]]})[${sel.extreme[0] === "+" ? "-1" : "0"}]`
  if (sel.near) e += `.sort_by_distance(Vector(${sel.near.map(py).join(", ")}))[:1]`
  return e
}

function combine(id: string, mode: "add" | "cut" | "intersect" | undefined) {
  if (mode === "intersect") return `part = part & ${ref("tool", id)}`
  return mode === "cut" ? `part = part - ${ref("tool", id)}` : `part = ${ref("tool", id)} if part is None else part + ${ref("tool", id)}`
}

function feature(f: Feature, tree: Tree): string[] {
  const head = [`# ${oneLine(`${displayName(tree, f)}（${f.id}）${f.intent ? `：${f.intent}` : ""}`)}`]
  switch (f.op) {
    case "sketch": {
      const regions = f.shapes.filter((s) => s.type !== "path")
      const paths = f.shapes.filter((s) => s.type === "path")
      const out = [...head]
      // A sketch an `onto` extrusion uses keeps its plane: resolved now, while the face it sits on still exists.
      const keepPlane = tree.features.some((x) => x.op === "extrude" && x.onto && x.sketch === f.id)
      if (keepPlane) out.push(`${ref("plane", f.id)} = ${sketchPlane(f.on)}`)
      const pl = keepPlane ? ref("plane", f.id) : sketchPlane(f.on)
      if (regions.length) {
        const [first, ...rest] = regions
        const body = rest.reduce((acc, s) => `${acc} ${"cut" in s && s.cut ? "-" : "+"} ${shape2d(s)}`, shape2d(first))
        out.push(`${ref("sk", f.id)} = ${pl} * (${body})`)
      }
      // An open path: a curve for thin walls (trace), its points for ribs.
      if (paths[0]?.type === "path") out.push(`${ref("path", f.id)} = ${sketchPlane(f.on)} * (${shape2d(paths[0])})`, `${ref("plane", f.id)} = ${sketchPlane(f.on)}`, `${ref("pts", f.id)} = ${pathPointsPy(paths[0].points)}`)
      return out
    }
    case "extrude": {
      const src = tree.features.find((x) => x.id === f.sketch)
      const open = src?.op === "sketch" && src.shapes.every((s) => s.type === "path")
      let sk = ref("sk", f.sketch)
      const out = [...head]
      if (f.thin) {
        const t = py(f.thin.t)
        const side = f.thin.side ?? "center"
        if (open) {
          out.push(`# 薄壁：沿开放的线长出厚 ${t} 的壁${side === "center" ? "" : "（build123d 的 trace 是两侧各一半，偏向一侧时位置会差半个壁厚）"}`)
          out.push(`${ref("thin", f.id)} = trace(${ref("path", f.sketch)}, line_width=${t})`)
        } else {
          const [a, b] = side === "center" ? [`${t} / 2`, `${t} / 2`] : side === "inside" ? ["0", t] : [t, "0"]
          out.push(`${ref("thin", f.id)} = offset(${sk}, amount=${a}, kind=Kind.INTERSECTION) - offset(${sk}, amount=-${b}, kind=Kind.INTERSECTION)`)
        }
        sk = ref("thin", f.id)
      }
      const taper = f.draft !== undefined ? `, taper=${py(f.draft)}` : ""
      if (f.through) return [...out, `${ref("tool", f.id)} = extrude(${sk}, amount=1000, both=True)`, combine(f.id, "cut")]
      if (f.until === "next") return [...out, `${ref("tool", f.id)} = extrude(${sk}, until=Until.NEXT, target=part${f.direction === "reverse" ? `, dir=-${sk}.faces()[0].normal_at()` : ""})`, combine(f.id, f.mode)]
      if (f.until) {
        const off = f.until.offset !== undefined ? `.offset(-(${py(f.until.offset)}))` : ""
        return [
          ...out,
          "# 成形到面：拉得足够长，再用那个面所在的平面切掉多出来的部分",
          `${ref("limit", f.id)} = Plane(${faces(f.until.face)}[0])${off}`,
          `${ref("tool", f.id)} = split(extrude(${sk}, amount=1000${f.direction === "reverse" ? `, dir=-${sk}.faces()[0].normal_at()` : ""}), bisect_by=${ref("limit", f.id)}, keep=Keep.BOTTOM)`,
          combine(f.id, f.mode),
        ]
      }
      const d = py(f.distance ?? 0)
      if (f.onto)
        return [
          ...out,
          "# 沿面等深：草图投影到面上，和面下（切除）或面上（加料）这一层求交",
          `${ref("tool", f.id)} = extrude(${sk}, amount=1000, both=True) & onto_band(${faces(f.onto)}[0], ${d}, cut=${f.mode === "cut" ? "True" : "False"}, plane=${ref("plane", f.sketch)})`,
          combine(f.id, f.mode),
        ]
      const opts = f.direction === "both" ? `amount=${d} / 2, both=True` : f.direction === "reverse" ? `amount=${d}, dir=-${sk}.faces()[0].normal_at()` : `amount=${d}`
      return [...out, `${ref("tool", f.id)} = extrude(${sk}, ${opts}${taper})`, combine(f.id, f.mode)]
    }
    case "split": {
      const [back, front] = f.parts
      return [
        ...head,
        `split_plane = ${sketchPlane(f.by)}`,
        `parts = {${JSON.stringify(back)}: split(part, bisect_by=split_plane, keep=Keep.BOTTOM), ${JSON.stringify(front)}: split(part, bisect_by=split_plane, keep=Keep.TOP)}`,
        "part = Compound(list(parts.values()))",
      ]
    }
    case "rib":
      return [...head, `${ref("tool", f.id)} = rib(part, ${ref("plane", f.sketch)}, ${ref("pts", f.sketch)}, ${py(f.t)}${f.flip ? ", flip=True" : ""})`, combine(f.id, "add")]
    case "component":
      return [...head, `# 装配里的零件 ${f.file}：装配不能导出成 build123d 代码，请分别导出每个零件`]
    case "import": {
      const v = ref("tool", f.id)
      const out = [...head, `${v} = import_step(${JSON.stringify(f.file)})  # 相对零件文件所在的文件夹`]
      for (const r of f.rotate ?? []) out.push(`${v} = ${v}.rotate(Axis.${r.axis}, ${py(r.angle)})`)
      if (f.at) out.push(`${v} = ${v}.translate((${f.at.map(py).join(", ")}))`)
      const mode = f.mode ?? "reference"
      if (mode === "reference") return [...out, `# 参考体：只用来对齐和核对间隙，不并入零件`]
      return [...out, combine(f.id, mode)]
    }
    case "revolve": {
      const turn = f.symmetric ? `-(${py(f.angle ?? 360)}) / 2` : f.start !== undefined ? py(f.start) : null
      const rot = turn ? [`${ref("tool", f.id)} = ${ref("tool", f.id)}.rotate(${AXIS[f.axis]}, ${turn})  # 起始角`] : []
      return [...head, `${ref("tool", f.id)} = revolve(${ref("sk", f.sketch)},axis=${AXIS[f.axis]}${f.angle !== undefined ? `, revolution_arc=${py(f.angle)}` : ""})`, ...rot, combine(f.id, f.mode)]
    }
    case "fillet":
      return [...head, `part = fillet(${edges(f.edges)}, radius=${py(f.r)})`]
    case "chamfer":
      return [...head, `part = chamfer(${edges(f.edges)}, length=${py(f.d)})`]
    case "shell":
      return [...head, `part = offset(part, amount=-${py(f.t)}, openings=${faces(f.open)})`]
    case "hole": {
      const n = { XY: "Vector(0, 0, 1)", XZ: "Vector(0, -1, 0)", YZ: "Vector(1, 0, 0)" }[f.on.plane]
      const out = f.reverse ? `-${n}` : n
      const depth = f.depth !== undefined ? py(f.depth) : "1000"
      // A standard hole is written out as the numbers the table gives.
      let std: ReturnType<typeof standardHole> | null = null
      try {
        std = f.standard ? standardHole(f.standard) : null
      } catch {
        /* the kernel reports it */
      }
      const r = `${std ? std.d : py(f.d ?? 0)} / 2`
      const cbore = f.cbore ? { d: py(f.cbore.d), depth: py(f.cbore.depth) } : std?.cbore && { d: String(std.cbore.d), depth: String(std.cbore.depth) }
      const csink = f.csink ? { d: py(f.csink.d), angle: f.csink.angle !== undefined ? py(f.csink.angle) : "90" } : std?.csink && { d: String(std.csink.d), angle: "90" }
      let tool = `Cylinder(${r}, ${depth}, align=(Align.CENTER, Align.CENTER, Align.MAX))`
      if (cbore) tool += ` + Cylinder(${cbore.d} / 2, ${cbore.depth}, align=(Align.CENTER, Align.CENTER, Align.MAX))`
      if (csink) {
        const R = `${csink.d} / 2`
        const a = csink.angle
        tool += ` + Cone(${r}, ${R}, (${R} - ${r}) / tan(${a} / 2), align=(Align.CENTER, Align.CENTER, Align.MAX))`
      }
      const at = f.at.map(([x, y]) => `(${py(x)}, ${py(y)})`).join(", ")
      return [
        ...head,
        ...(std ? [`# ${std.label}${std.thread ? "：只钻底孔，装饰螺纹不导出" : ""}`] : []),
        `hole_plane = ${sketchPlane(f.on)}`,
        `${ref("tool", f.id)} = Compound([Plane(origin=hole_plane.from_local_coords(xy), z_dir=${out}) * (${tool}) for xy in [${at}]])`,
        combine(f.id, "cut"),
      ]
    }
    case "linear_pattern": {
      const v = `Vector${DIR_VEC[f.dir]} * ${py(f.spacing)}`
      const v2 = f.dir2 && f.count2 !== undefined && f.spacing2 !== undefined ? `Vector${DIR_VEC[f.dir2]} * ${py(f.spacing2)}` : null
      const rng = v2 ? `for i in range(${pyInt(f.count)}) for j in range(${pyInt(f.count2!)}) if i or j` : `for i in range(1, ${pyInt(f.count)})`
      const move = v2 ? `Pos(${v} * i + ${v2} * j)` : `Pos(${v} * i)`
      return [...head, ...f.features.map((id) => `for copy in [${move} * ${ref("tool", id)} ${rng}]:\n    part = part ${modeOf(tree, id) === "cut" ? "-" : "+"} copy`)]
    }
    case "circular_pattern": {
      const total = f.angle !== undefined ? py(f.angle) : "360"
      const c = pyInt(f.count)
      const step = f.angle === undefined || Number(f.angle) >= 360 ? `360 / ${c}` : `${total} / (${c} - 1)`
      const rot = { X: "Rot(X=a)", Y: "Rot(Y=a)", Z: "Rot(Z=a)" }[f.axis]
      return [...head, ...f.features.map((id) => `for a in [${step} * i for i in range(1, ${c})]:\n    part = part ${modeOf(tree, id) === "cut" ? "-" : "+"} ${rot} * ${ref("tool", id)}`)]
    }
    case "sweep": {
      const pts = points(f.path.points)
      const pl = sketchPlane(f.path.on)
      const straight = pts.every((p) => !p.via && !p.spline)
      const wire =
        straight && f.path.corner !== undefined
          ? `FilletPolyline(${pts.map((p) => xy(p.to)).join(", ")}, radius=${py(f.path.corner)})`
          : `Wire([${pts
              .slice(1)
              .map((p, i) => segment(pts[i].to, p))
              .join(", ")}])`
      const prof = f.profile.type === "circle" ? `Circle(${py(f.profile.d)} / 2)` : `Rectangle(${py(f.profile.w)}, ${py(f.profile.h)})`
      return [
        ...head,
        `${ref("path", f.id)} = ${pl} * ${wire}`,
        `t0 = ${ref("path", f.id)} % 0`,
        `${ref("prof", f.id)} = Plane(origin=${ref("path", f.id)} @ 0, x_dir=t0.cross(${pl}.z_dir), z_dir=-t0) * ${prof}`,
        `${ref("tool", f.id)} = sweep(${ref("prof", f.id)}, path=${ref("path", f.id)})`,
        combine(f.id, f.mode),
      ]
    }
    case "loft":
      return [...head, `${ref("tool", f.id)} = loft([${f.sketches.map((id) => ref("sk", id)).join(", ")}], ruled=${f.ruled ? "True" : "False"})`, combine(f.id, f.mode)]
    case "draft":
      return [...head, `part = draft(${faces(f.faces)}, ${f.neutral.face ? `Plane(${faces(f.neutral.face)}[0])` : plane(f.neutral)}, ${py(f.angle)})`]
    case "mirror": {
      const about = plane({ plane: f.plane, offset: f.offset })
      if (!f.features?.length) return [...head, `part = part + mirror(part, about=${about})`]
      return [...head, ...f.features.map((id) => `part = part ${modeOf(tree, id) === "cut" ? "-" : "+"} mirror(${ref("tool", id)}, about=${about})`)]
    }
  }
}

function modeOf(tree: Tree, id: string) {
  const f = tree.features.find((x) => x.id === id)
  return f && "mode" in f ? f.mode : f?.op === "hole" ? "cut" : "add"
}

/** Parameters in dependency order, as Python assignments. */
function params(tree: Tree) {
  const out: string[] = []
  const done = new Set<string>()
  const visit = (k: string) => {
    if (done.has(k) || !Object.hasOwn(tree.params, k)) return
    done.add(k)
    const v = tree.params[k]
    if (typeof v === "string") {
      try {
        namesIn(v).forEach(visit)
      } catch {
        /* py() reports it */
      }
    }
    ctx.where = `参数「${clip(oneLine(k))}」`
    ctx.feature = null
    if (ctx.badParams.has(k)) return void problem("名字不能用作 Python 变量名，没有导出")
    const note = tree.paramNotes?.[k]
    out.push(`${k} = ${py(v)}${note ? `  # ${oneLine(note).trim()}` : ""}`)
  }
  Object.keys(tree.params).forEach(visit)
  return out
}

/** The code plus what could not be written safely (field by field); those spots read None. */
export function buildCode(raw: Tree, opts: { title?: string; body?: boolean } = {}): { code: string; problems: string[] } {
  const parsed = Tree.safeParse(raw)
  if (!parsed.success) return { code: "# 特征树格式不对，没有生成代码", problems: ["特征树格式不对"] }
  const tree = parsed.data
  const names = Object.keys(tree.params)
  ctx = { problems: [], params: new Set(names.filter(safeName)), badParams: new Set(names.filter((k) => !safeName(k))), where: "", feature: null }
  const head = params(tree)
  const body: string[] = []
  // After a split, body features act on the parts dict (see onParts).
  let partNames: string[] = []
  // Material added under a new part name starts a part of its own (kernel: newPart); the first one names the body.
  let mainName: string | undefined
  let hasBody = false
  for (const f of tree.features) {
    ctx.where = `特征「${clip(oneLine(displayName(tree, f)))}」（${f.id}）`
    ctx.feature = f
    const out = feature(f, tree)
    const adds = ((f.op === "extrude" || f.op === "revolve" || f.op === "sweep" || f.op === "loft") && (f.mode ?? "add") === "add") || (f.op === "import" && f.mode === "add")
    const main = mainName ?? "主体"
    if (adds && f.part && hasBody && !partNames.includes(f.part) && !(partNames.length === 0 && f.part === main)) {
      const pre = partNames.length ? [] : [`parts = {${JSON.stringify(main)}: part}`]
      if (!partNames.length) partNames = [main]
      partNames.push(f.part)
      const tool = out[out.length - 1].match(/^part = (tool_\w+) if part is None/)?.[1]
      body.push(...pre, ...out.slice(0, -1), `# 新零件「${oneLine(f.part)}」：不和别的零件合并`, tool ? `parts[${JSON.stringify(f.part)}] = ${tool}` : "# （这一步没有生成工具体）", "part = Compound(list(parts.values()))", "")
      continue
    }
    if (adds && !hasBody && f.part) mainName = f.part
    if (adds) hasBody = true
    if (f.op === "split") partNames = partNames.filter((n) => n !== f.of).concat(f.parts)
    body.push(...(partNames.length && f.op !== "split" && f.op !== "sketch" ? onParts(out, f, partNames) : out), "")
  }
  const { problems } = ctx
  ctx = { problems: [], params: new Set(), badParams: new Set(), where: "", feature: null }
  const warn = problems.length ? [`# 有 ${problems.length} 处没能导出，代码里写成了 None，运行前要先改好：`, ...problems.map((p) => `#   ${p}`), ""] : []
  if (opts.body) return { code: [...warn, "# 参数", ...head, "", "part = None", "", ...body].join("\n").trimEnd(), problems }
  return { code: [...prelude(opts.title ?? "FeatureTree 工作台导出"), ...warn, "# 参数", ...head, "", "part = None", "", ...body, "show_object(part) if 'show_object' in globals() else None", ""].join("\n"), problems }
}

/** `body: true` = just parameters and features (for reading); otherwise a runnable file. */

/**
 * A feature's lines rewritten for a split body: `part` names one entry of
 * `parts`; a cut goes through every part; an addition joins the part it
 * touches; anything else runs on each part. Then `part` is the compound again.
 */
function onParts(lines: string[], f: Feature, names: string[]): string[] {
  const on = (name: string) => lines.map((l) => l.replace(/\bpart\b/g, `parts[${JSON.stringify(name)}]`))
  const whole = "part = Compound(list(parts.values()))"
  if (f.part) return [...on(f.part), whole]
  const last = lines[lines.length - 1]
  const cut = last.match(/^part = part - (tool_\w+)$/)
  if (cut) return [...lines.slice(0, -1), `parts = {k: v - ${cut[1]} for k, v in parts.items()}`, whole]
  const add = last.match(/^part = (tool_\w+) if part is None else part \+ \1$/)
  if (add)
    return [...lines.slice(0, -1), "# 加料接在它碰到的那个零件上", `joined = next(k for k, v in parts.items() if v.distance_to(${add[1]}) < 1e-6)`, `parts[joined] = parts[joined] + ${add[1]}`, whole]
  return [...names.flatMap(on), whole]
}

export function toBuild123d(tree: Tree, opts: { title?: string; body?: boolean } = {}): string {
  return buildCode(tree, opts).code
}

function prelude(title: string): string[] {
  // A docstring: one line, and nothing that could close it.
  const safeTitle = oneLine(title).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return [
    `"""${safeTitle}

由 FeatureTree AI 建模工作台的特征树生成（build123d 代数写法）。
Z 轴朝上，单位毫米。选择器按语义转成 build123d 的过滤；「来自某特征」按「落在该特征的工具体表面上」近似。
"""`,
    "import math",
    "from build123d import *",
    "",
    "",
    "def sin(d): return math.sin(math.radians(d))",
    "def cos(d): return math.cos(math.radians(d))",
    "def tan(d): return math.tan(math.radians(d))",
    "def atan(x): return math.degrees(math.atan(x))",
    "sqrt, pi, floor, ceil = math.sqrt, math.pi, math.floor, math.ceil",
    "",
    "",
    "def on_face(face, flat, offset=0):",
    '    """Sketch plane on a face: `flat` when the face is parallel to the datum; an inclined face gets its own (origin at its centre, x level, y up the slope)."""',
    "    n = face.normal_at()",
    "    if abs(n.dot(flat.z_dir)) > 0.9999:",
    "        return flat",
    "    x = Vector(0, 0, 1).cross(n) if abs(n.Z) < 0.999 else Vector(1, 0, 0)",
    "    return Plane(origin=face.center() + n * offset, x_dir=x.normalized(), z_dir=n)",
    "",
    "",
    "def rib(part, plane, pts, t, flip=False):",
    '    """筋：线的两端延长到很远，取被实体围住的那一侧，在草图平面两侧各 t/2。"""',
    "    far = 10 * part.bounding_box().diagonal",
    "    p = [Vector(*q) for q in pts]",
    "    a = p[0] - (p[1] - p[0]).normalized() * far",
    "    b = p[-1] + (p[-1] - p[-2]).normalized() * far",
    "    side = Vector(-(b - a).Y, (b - a).X).normalized() * far",
    "    bb = part.bounding_box()",
    "    box = Pos(bb.center()) * Box(bb.size.X, bb.size.Y, bb.size.Z)",
    "    inside = lambda s: all(lo > lo0 + 1e-3 and hi < hi0 - 1e-3 for lo, hi, lo0, hi0 in zip(s.bounding_box().min, s.bounding_box().max, bb.min, bb.max))",
    "    for s in ([-1, 1] if flip else [1, -1]):",
    "        outline = make_face(Polyline(a, *p[1:-1], b, b + side * s, a + side * s, close=True))",
    "        slab = extrude(plane * outline, amount=t / 2, both=True)",
    "        kept = [x for x in ((slab & box) - part).solids() if inside(x)]",
    "        if kept:",
    "            return Compound(kept)",
    '    raise ValueError("筋碰不到实体")',
    "",
    "",
    "def round_corners(face, corners):",
    '    """Round an outline\'s corners at these points: [((x, y), r), …]."""',
    "    for (x, y), r in corners:",
    "        face = fillet(face.vertices().sort_by_distance(Vector(x, y, 0))[0], radius=r)",
    "    return face",
    "",
    "",
    "def onto_band(face, depth, cut, plane, big=1000):",
    '    """The layer `depth` thick under (cut) or over (add) a planar or cylindrical face; on a cylinder, the side the sketch plane is on (both when it passes through the axis)."""',
    "    if face.geom_type == GeomType.PLANE:",
    "        n = face.normal_at()",
    "        return extrude(Plane(origin=face.center(), z_dir=n) * Rectangle(2 * big, 2 * big), amount=depth, dir=-n if cut else n)",
    "    axis, r = face.axis_of_rotation, face.radius",
    "    p = face.position_at(0.5, 0.5)",
    "    radial = (p - axis.position) - axis.direction * (p - axis.position).dot(axis.direction)",
    "    convex = face.normal_at(p).dot(radial) > 0",
    "    inner, outer = (r - depth, r) if cut == convex else (r, r + depth)",
    "    base = Plane(origin=axis.position - axis.direction * big, z_dir=axis.direction)",
    "    up = (Align.CENTER, Align.CENTER, Align.MIN)",
    "    band = base * (Cylinder(outer, 2 * big, align=up) - Cylinder(inner, 2 * big, align=up))",
    "    side = (plane.origin - axis.position).dot(plane.z_dir)",
    "    if abs(side) < 1e-6:",
    "        return band",
    "    return band & (Plane(origin=axis.position, z_dir=plane.z_dir * (1 if side > 0 else -1)) * Box(4 * big, 4 * big, 2 * big, align=up))",
    "",
    "",
    "def on_feature(items, tool):",
    '    """Faces / edges lying on a feature\'s tool body: an approximation of "made by that feature"."""',
    "    skin = tool.faces()",
    "    return ShapeList(i for i in items if min(f.distance_to(i.center()) for f in skin) < 1e-3)",
    "",
    "",
  ]
}
