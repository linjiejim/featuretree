// The feature-tree interpreter. Rebuilds a Tree feature by feature with
// replicad (OpenCascade), caches every step by tree prefix so an edit only
// recomputes what follows it, and records for every face which feature first
// made it (face provenance) and whether this step made it new / modified it.
//
// Runs unchanged in a Web Worker (the studio) and in Node (evals, tests).
import {
  Blueprints,
  cast,
  draw,
  Drawing,
  drawCircle,
  drawPolysides,
  drawRectangle,
  drawRoundedRectangle,
  exportSTEP,
  getOC,
  makeCompound,
  makeCylinder,
  makePlane,
  measureArea,
  measureShapeVolumeProperties,
  Plane,
  sketchCircle,
  sketchRectangle,
  type Blueprint,
  type CompoundBlueprint,
  type AnyShape,
  type Shape3D,
} from "replicad"
import type { PickInfo } from "../annotations"
import { displayName, EMPTY_TREE, OP_NAMES, type EdgeSelector, type Feature, type FeatureOp, type FaceSelector, type PlaneRef, type Point, type SketchShape, type Tree } from "../dsl"
import { num, resolveParams, type Scope } from "../expr"
import { MAX_COUNT } from "../limits"
import { referencesOf } from "../apply"
import { describeError, explain, InputError } from "./errors"
import { normalizeText, textDrawing } from "./fonts"
import { measure, type MeasureResult, type MeasureSpec, type MeasureTarget } from "./measure"
import { closest, relation, TOUCH } from "./proximity"
import { compoundOf, countOf, edgesOf, facesOf, solidsOf } from "./topo"
import { dimensionsOf, type Dim, type Frame, type StepGeom } from "./dims"
import { cylinderAxis, runChecks, type CheckBodies, type CheckResult } from "./check"
import { pathPoints, planeFace, ribTool, tapered, thinProfile, untilNext } from "./features2"
import { stepAscii, zipStore } from "../zip"
import { makeDrawing, type DrawingData } from "./drawing"
import { standardHole } from "../holes"
import { classifyFaces, faceSignatures, meshEdges, meshShape, type EdgeMesh, type FaceSig, type FaceStatus, type Mesh } from "./mesh"
import {
  axisDir,
  DIRS,
  describeEdge,
  describeFace,
  disposeInfos,
  edgeInfos,
  faceInfos,
  groupEdgeSelector,
  groupFaceSelector,
  selectEdges,
  selectFaces,
  uniqueEdgeSelector,
  uniqueFaceSelector,
  type EdgeInfo,
  type FaceInfo,
} from "./select"

type V3 = [number, number, number]
type PlaneName = "XY" | "XZ" | "YZ"
type Tool = { tool: Shape3D; mode: "add" | "cut" | "intersect" }

const PLANES: Record<PlaneName, { normal: V3; x: V3; y: V3; axis: 0 | 1 | 2; label: string }> = {
  XY: { normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], axis: 2, label: "上视基准面" },
  XZ: { normal: [0, -1, 0], x: [1, 0, 0], y: [0, 0, 1], axis: 1, label: "前视基准面" },
  YZ: { normal: [1, 0, 0], x: [0, 1, 0], y: [0, 0, 1], axis: 0, label: "右视基准面" },
}
const AXIS: Record<string, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const r2 = (x: number) => Math.round(x * 100) / 100
const fmt = (x: number) => String(r2(x))

/**
 * Where a sketch lies: the datum plane it was named after, and its actual frame
 * (sketch x → `x`, y → `y`, extrusion along `normal`). `flipped`: sketched on a
 * face that looks the other way from its datum plane (the back, the bottom…).
 * `custom`: an inclined face or a tilted datum, not an axis-aligned plane.
 */
type ResolvedPlane = { name: PlaneName; origin: V3; x: V3; y: V3; normal: V3; label: string; flipped?: boolean; custom?: boolean }

const unit = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1))

/** `v` turned `deg` degrees about the unit vector `k` (right-hand rule). */
function rotate(v: V3, k: V3, deg: number): V3 {
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)))
}

/** Put a drawing (or blueprint) on a resolved plane, optionally moved to `origin`. */
function sketchOn<T>(d: { sketchOnPlane(p: Plane): T }, p: ResolvedPlane, origin: V3 = p.origin): T {
  const pl = new Plane(origin, p.x, p.normal)
  try {
    return d.sketchOnPlane(pl)
  } finally {
    pl.delete()
  }
}

export type FeatureResult = {
  id: string
  op: FeatureOp
  name: string
  state: "ok" | "error" | "skipped" | "suppressed"
  summary?: string
  message?: string
  hint?: string
  warnings?: string[]
  /** How many edges / faces a selector picked. */
  selected?: number
  /** Faces this step created and modified. */
  faces?: { new: number; modified: number }
  ms: number
}

export type BodyStats = {
  bbox: [V3, V3]
  size: V3
  volume: number
  centerOfMass: V3
  faces: number
  edges: number
  solids: number
}

export type BuildReport = {
  params: Record<string, number>
  paramError?: string
  features: FeatureResult[]
  /** Index of the last feature that built. -1 = nothing built. */
  lastOk: number
  body: BodyStats | null
  /** The learner's requirements (`tree.checks`) measured on the latest body. */
  checks?: CheckResult[]
  /** After a split: each part's name, volume and size. */
  parts?: { name: string; volume: number; size: V3 }[]
  /** Reference bodies brought in with `import`. */
  refs?: { id: string; name: string; size: V3 }[]
  ms: number
}

export type DisplayData = {
  index: number
  mesh: { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array } | null
  /** One per B-rep face, in mesh order. `hash` identifies the face for picking; `part` indexes `parts`. */
  groups: { start: number; count: number; status: FaceStatus; origin: string; hash: number; part?: number }[]
  edges: Float32Array | null
  /** One per edge: a run of points in `edges` (segment pairs). */
  edgeGroups: { start: number; count: number; hash: number; part?: number }[]
  /** After a split: the parts, with where each moves at full explode. */
  parts?: { name: string; explode: V3; center: V3; hidden?: boolean }[]
  /** Reference bodies (`import`, desktop app): drawn see-through, not part of the model. */
  refs?: { id: string; name: string; mesh: { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array }; edges: Float32Array | null }[]
  /** Outline of the sketch, when the shown step is a sketch. */
  sketch: Float32Array | null
  /** Cosmetic threads: a ring at the nominal diameter at each end of a tapped hole. */
  threads: { center: V3; axis: V3; r: number }[]
  bbox: [V3, V3] | null
}

type Step = {
  key: string
  feature: Feature
  result: FeatureResult
  body: Shape3D | null
  ownsBody: boolean
  origins: string[]
  status: FaceStatus[]
  sigs: FaceSig[]
  mesh: Mesh | null
  edges: EdgeMesh | null
  /** `drawing`: the closed regions (null when only open paths); `paths`: open paths as points. */
  sketch?: { drawing: Drawing | null; paths: [number, number][][]; plane: ResolvedPlane; lines: Float32Array }
  tools?: Tool[]
  /** Tapped holes this step drilled: drill radius and the thread's nominal diameter. */
  threads?: Thread[]
  /** Where this step's dimensions go (kernel/dims.ts). */
  geom?: StepGeom
  /** After a split: the parts (`body` is their compound), and each part's face origins. */
  parts?: Part[]
  partOrigins?: string[][]
  /** The name the first feature gave the body (`part` on the first addition), before there are parts. */
  mainName?: string
  /** Reference bodies so far (`import` with mode reference): carried along, never merged. */
  refs?: Ref[]
}

/** A reference body: shown and measured against, not part of the model. `owned`: made by this step. */
type Ref = { id: string; name: string; shape: AnyShape; mesh: Mesh; edges: EdgeMesh; owned: boolean }

/**
 * A component of an assembly as the host read it: a STEP file's bytes, or a part (or sub-assembly) file's
 * tree, already merged with its shared parameters, with what it imports and its own components.
 */
export type ComponentSource = {
  file: string
  error?: string
  bytes?: Uint8Array | null
  tree?: Tree
  assets?: { name: string; bytes: Uint8Array | null; error?: string }[]
  components?: ComponentSource[]
}

/** A built component: its parts' final shapes (unnamed: a single-body part), and how many features failed. */
type Built = { parts: { name: string | null; shape: Shape3D }[]; failed: number }

/** Built components by content, shared by every kernel in the thread (switching parts doesn't rebuild them). */
const BUILT = new Map<string, Built>()
const MAX_BUILT = 16

/** A placement in an assembly, numbers already worked out. */
export type Placement = { rotate: { axis: "X" | "Y" | "Z"; angle: number }[]; at: V3 }

/** Editing a part inside an assembly: where it sits, and the other components with where they sit. */
export type ContextSource = { self: Placement; assembly: string; others: { name: string; source: ComponentSource; place: Placement }[] }

/** A file `import` reads, as the host handed it over: parsed once per content. */
type Asset = { hash: string; shape: AnyShape | null; error?: string }

type Thread = { r: number; major: number }

/**
 * A named part after a split. `explode`: where it moves at full explode (each
 * split moves the normal side along the normal). `owned`: made by this step
 * (else carried over, and freed by the step that made it).
 */
/** `auto`: made by adding material under a new name (or the body that was there): explodes away from the middle. */
type Part = { name: string; body: Shape3D; explode: V3; owned: boolean; auto?: boolean; hidden?: boolean }

/** New faces smaller than this (mm²) are reported as slivers. */
const SLIVER_AREA = 0.01

/** Features that change the body; after a split they run on each part (see `onParts`). */
const BODY_OPS = new Set<FeatureOp>(["extrude", "revolve", "fillet", "chamfer", "shell", "hole", "linear_pattern", "circular_pattern", "mirror", "sweep", "loft", "draft", "rib"])

export class Kernel {
  private steps: Step[] = []
  private paramsKey = ""
  private scope: Scope = {}
  private tree: Tree = EMPTY_TREE
  /** Files the tree imports, by the name written in the feature. Empty on the site (no files to read). */
  private assets = new Map<string, Asset>()
  private assetsGiven = false
  /** Parsed files by content, so switching parts doesn't parse them again. */
  private parsed = new Map<string, AnyShape>()
  /** Editing a part inside an assembly: the other parts, placed in this part's frame, drawn see-through (read-only). */
  private context: Ref[] = []
  private contextKey = ""
  /** An assembly's components as the host read them, by the file name written in the feature, and their content keys. */
  private components = new Map<string, { source: ComponentSource; key: string }>()
  private componentsGiven = false

  /** The host hands over what an assembly's `component` features read. Call before `rebuild`. */
  setComponents(list: ComponentSource[]) {
    this.componentsGiven = true
    this.components = new Map(list.map((c) => [c.file, { source: c, key: componentKey(c) }]))
  }

  /**
   * Editing a part inside an assembly: build the other components (cached) and place them in this part's
   * frame as see-through, read-only reference bodies. Null leaves the assembly.
   */
  setContext(ctx: ContextSource | null) {
    const key = ctx ? JSON.stringify([ctx.self, ctx.others.map((o) => [o.name, componentKey(o.source), o.place])]) : ""
    if (key === this.contextKey) return
    this.context.forEach((r) => r.shape.delete())
    this.context = []
    this.contextKey = key
    if (!ctx) return
    for (const o of ctx.others) {
      let built: Built
      try {
        built = buildComponent(o.source)
      } catch {
        continue
      }
      for (const p of built.parts) {
        const shape = unplace(place(p.shape.clone(), o.place), ctx.self)
        const name = p.name && built.parts.length > 1 ? `${o.name}/${p.name}` : o.name
        this.context.push({ id: name, name, shape, mesh: meshShape(shape), edges: meshEdges(shape), owned: true })
      }
    }
  }


  /**
   * The host (the desktop app) hands over the files `import` features read: the bytes, or why it
   * couldn't read them. Call before `rebuild`; a changed file rebuilds from its import on.
   */
  setAssets(list: { name: string; bytes: Uint8Array | null; error?: string }[]) {
    this.assetsGiven = true
    const next = new Map<string, Asset>()
    for (const a of list) {
      if (!a.bytes) {
        next.set(a.name, { hash: `missing:${a.error ?? ""}`, shape: null, error: a.error ?? "读不到这个文件" })
        continue
      }
      const hash = contentHash(a.bytes)
      let shape = this.parsed.get(hash) ?? null
      let error: string | undefined
      if (!shape) {
        try {
          shape = readStep(a.bytes)
          this.parsed.set(hash, shape)
        } catch (e) {
          error = (e as Error).message
        }
      }
      next.set(a.name, { hash, shape, error })
    }
    // Keep a few parsed files beyond the ones in use (another open part may need them back).
    const used = new Set([...next.values()].map((a) => a.hash))
    for (const [hash, shape] of [...this.parsed]) {
      if (used.has(hash) || this.parsed.size <= used.size + 4) continue
      shape.delete()
      this.parsed.delete(hash)
    }
    this.assets = next
  }

  rebuild(tree: Tree): BuildReport {
    const t0 = performance.now()
    this.tree = tree
    const paramsKey = JSON.stringify(tree.params)
    let paramError: string | undefined
    try {
      this.scope = resolveParams(tree.params)
    } catch (e) {
      paramError = (e as Error).message
      this.scope = {}
    }
    if (paramsKey !== this.paramsKey) {
      this.disposeFrom(0)
      this.paramsKey = paramsKey
    }

    // Suppressing a feature suppresses what is built on it, as in SolidWorks.
    const off = new Map<string, string | null>()
    for (const f of tree.features) {
      if (f.suppressed) off.set(f.id, null)
      else {
        const parent = referencesOf(f).find((r) => off.has(r))
        if (parent) off.set(f.id, parent)
      }
    }

    let key = paramsKey
    let failed = paramError !== undefined
    for (let i = 0; i < tree.features.length; i++) {
      const f = tree.features[i]
      key +=
        "\n" +
        JSON.stringify(f) +
        (off.has(f.id) ? "\noff" : "") +
        (f.op === "import" ? `\n${this.assets.get(f.file)?.hash ?? "-"}` : "") +
        (f.op === "component" ? `\n${this.components.get(f.file)?.key ?? "-"}` : "")
      const cached = this.steps[i]
      if (cached && cached.key === key) {
        if (cached.result.state === "error" || cached.result.state === "skipped") failed = true
        continue
      }
      this.disposeFrom(i)
      const prev = this.lastBuilt(i)
      // A suppressed feature passes the body through untouched; what depends on it fails on its own.
      const step = off.has(f.id)
        ? this.base(f, key, prev, tree, { state: "suppressed", summary: off.get(f.id) ? `已压缩（它用到的「${displayName(tree, tree.features.find((x) => x.id === off.get(f.id))!)}」被压缩了）` : "已压缩" })
        : failed
          ? this.skip(f, key, prev, tree)
          : this.run(f, key, prev, tree)
      if (step.result.state === "error" || step.result.state === "skipped") failed = true
      this.steps.push(step)
    }
    this.disposeFrom(tree.features.length)

    const features = this.steps.map((s) => s.result)
    let lastOk = -1
    features.forEach((r, i) => {
      if (r.state === "ok") lastOk = i
    })
    const last = this.lastBuilt(this.steps.length)
    return {
      params: this.scope,
      paramError,
      features,
      lastOk,
      body: last?.body ? stats(last.body) : null,
      checks: tree.checks?.length && last?.body ? runChecks(last.body, last.origins, tree.checks, this.scope, this.checkBodies(last)) : undefined,
      refs: last?.refs?.length || this.context.length ? [...(last?.refs ?? []), ...this.context].map((r) => ({ id: r.id, name: r.name, size: sizeOf(r.shape) })) : undefined,
      parts: last?.parts && last.parts.length > 1 ? last.parts.map((p) => ({ name: p.name, volume: r2(measureShapeVolumeProperties(p.body).volume), size: stats(p.body).size })) : undefined,
      ms: performance.now() - t0,
    }
  }

  /** What checks can name: reference bodies (and the assembly context) by id and name, parts by name. */
  private checkBodies(step: Step): CheckBodies {
    const refs = new Map<string, AnyShape>()
    for (const r of [...(step.refs ?? []), ...this.context]) {
      refs.set(r.id, r.shape)
      refs.set(r.name, r.shape)
    }
    return { refs, parts: step.parts ?? [] }
  }

  /** Mesh + per-face status of one step (default: the last that built). */
  display(index?: number): DisplayData {
    const i = index ?? this.steps.findLastIndex((s) => s.result.state === "ok")
    const step = this.steps[i]
    const empty: DisplayData = { index: i, mesh: null, groups: [], edges: null, edgeGroups: [], sketch: null, bbox: null, threads: [] }
    if (!step) return empty
    const body = step.result.state === "ok" ? step : this.lastBuilt(i)
    const out: DisplayData = { ...empty, sketch: step.sketch ? step.sketch.lines.slice() : null }
    if (body?.body && body.mesh) {
      const faces = facesOf(body.body)
      const indexByHash = new Map(faces.map((f, k) => [f.hashCode, k]))
      faces.forEach((f) => f.delete())
      const isThisStep = body === step && step.ownsBody
      out.mesh = { vertices: body.mesh.vertices.slice(), normals: body.mesh.normals.slice(), triangles: body.mesh.triangles.slice() }
      out.groups = body.mesh.faceGroups.map((g) => {
        const k = indexByHash.get(g.faceId) ?? -1
        return {
          start: g.start,
          count: g.count,
          status: isThisStep && k >= 0 ? body.status[k] : "kept",
          origin: k >= 0 ? body.origins[k] : "?",
          hash: g.faceId,
        }
      })
      out.edges = body.edges ? body.edges.lines.slice() : null
      out.edgeGroups = body.edges ? body.edges.edgeGroups.map((g) => ({ start: g.start, count: g.count, hash: g.edgeId })) : []
      const bb = body.body.boundingBox.bounds as [V3, V3]
      out.bbox = [[...bb[0]], [...bb[1]]] as [V3, V3]
      out.threads = this.threadRings(this.steps.indexOf(body), body)
      if (body.parts && (body.parts.length > 1 || body.parts.some((p) => p.hidden))) {
        // Which part each face and edge belongs to, for colouring, hiding and exploding parts.
        const faceToPart = new Map<number, number>()
        const edgeToPart = new Map<number, number>()
        const auto = autoExplode(body.parts)
        out.parts = body.parts.map((p, k) => {
          const fs = facesOf(p.body)
          const es = edgesOf(p.body)
          fs.forEach((f) => faceToPart.set(f.hashCode, k))
          es.forEach((e) => edgeToPart.set(e.hashCode, k))
          fs.forEach((f) => f.delete())
          es.forEach((e) => e.delete())
          const [a, b] = p.body.boundingBox.bounds as [V3, V3]
          return { name: p.name, explode: p.auto ? add(p.explode, auto[k]) : p.explode, center: mul(add(a, b), 0.5), hidden: p.hidden }
        })
        out.groups = out.groups.map((g) => ({ ...g, part: faceToPart.get(g.hash) }))
        out.edgeGroups = out.edgeGroups.map((g) => ({ ...g, part: edgeToPart.get(g.hash) }))
      }
    }
    // The assembly around a part being edited in context draws like reference bodies.
    const refs = [...((body ?? step)?.refs ?? []), ...this.context]
    if (refs.length) {
      out.refs = refs.map((r) => ({
        id: r.id,
        name: r.name,
        mesh: { vertices: r.mesh.vertices.slice(), normals: r.mesh.normals.slice(), triangles: r.mesh.triangles.slice() },
        edges: r.edges.lines.slice(),
      }))
      // Only a reference so far: frame the view on it.
      if (!out.bbox) {
        const boxes = refs.map((r) => r.shape.boundingBox.bounds as [V3, V3])
        out.bbox = [[0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[0][k]))) as V3, [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b[1][k]))) as V3]
      }
    }
    return out
  }

  /** Rings for the tapped holes in `step`'s body, the ones patterns and mirrors copied included. */
  private threadRings(upto: number, step: Step): DisplayData["threads"] {
    const tapped = new Map<string, Thread[]>()
    for (const s of this.steps.slice(0, upto + 1)) {
      if (s.result.state !== "ok") continue
      if (s.threads) tapped.set(s.feature.id, s.threads)
      const f = s.feature
      if (f.op === "linear_pattern" || f.op === "circular_pattern" || f.op === "mirror") {
        const copied = (f.features ?? [...tapped.keys()]).flatMap((id) => tapped.get(id) ?? [])
        if (copied.length) tapped.set(f.id, copied)
      }
    }
    if (!tapped.size || !step.body || !step.mesh) return []
    const out: DisplayData["threads"] = []
    const faces = faceInfos(step.body, step.origins)
    try {
      const groups = new Map(step.mesh.faceGroups.map((g) => [g.faceId, g]))
      for (const f of faces) {
        const t = f.kind === "cylinder" && f.radius !== undefined ? tapped.get(f.origin)?.find((x) => Math.abs(x.r - f.radius!) < 1e-4) : undefined
        const g = t && groups.get(f.face.hashCode)
        if (!t || !g) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ad: any = (f.face as any)._geomAdaptor()
        try {
          const ax = ad.Cylinder().Axis()
          const lp = ax.Location()
          const dp = ax.Direction()
          const p: V3 = [lp.X(), lp.Y(), lp.Z()]
          const a: V3 = [dp.X(), dp.Y(), dp.Z()]
          // The hole's extent along its axis, from the face's own triangles.
          const v = step.mesh.vertices
          const tri = step.mesh.triangles
          let lo = Infinity
          let hi = -Infinity
          for (let k = g.start; k < g.start + g.count; k++) {
            const q: V3 = [v[tri[k] * 3], v[tri[k] * 3 + 1], v[tri[k] * 3 + 2]]
            const s = dot([q[0] - p[0], q[1] - p[1], q[2] - p[2]], a)
            lo = Math.min(lo, s)
            hi = Math.max(hi, s)
          }
          for (const s of [lo, hi]) out.push({ center: add(p, mul(a, s)), axis: a, r: t.major / 2 })
        } finally {
          ad.delete?.()
        }
      }
    } finally {
      disposeInfos(faces)
    }
    return out
  }

  /** Text the model (or a curious learner) can read: faces, edges, or the body. */
  inspect(what: "body" | "faces" | "edges", index?: number, selector?: unknown): string {
    const step = this.lastBuilt(index === undefined ? this.steps.length : index + 1)
    // Reference bodies (`import`): where they are, and — with `of` naming one — their own faces and edges.
    const refs = step?.refs ?? []
    const ref = refs.find((r) => r.id === (selector as { of?: unknown } | undefined)?.of)
    if (ref && what !== "body") {
      const shape = ref.shape as Shape3D
      const faces = faceInfos(shape, new Array(countOf(shape, "face")).fill(ref.id))
      try {
        if (what === "faces") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const list = selectFaces(selector as any, faces, this.scope)
          return list.slice(0, 40).map(describeFace).join("\n") + (list.length > 40 ? `\n…共 ${list.length} 个面` : "")
        }
        const edges = edgeInfos(shape, faces)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const list = selectEdges(selector as any, edges, faces, this.scope)
          return list.slice(0, 40).map(describeEdge).join("\n") + (list.length > 40 ? `\n…共 ${list.length} 条边` : "")
        } finally {
          disposeInfos([], edges)
        }
      } catch (e) {
        return describeError(e).message
      } finally {
        disposeInfos(faces)
      }
    }
    const refLines = refs.map((r) => {
      const [a, b] = r.shape.boundingBox.bounds as [V3, V3]
      const size = sizeOf(r.shape)
      return `参考体 ${r.id}（${r.name}）：包围盒 X ${fmt(a[0])}…${fmt(b[0])}，Y ${fmt(a[1])}…${fmt(b[1])}，Z ${fmt(a[2])}…${fmt(b[2])}，尺寸 ${size.map(fmt).join(" × ")} mm。它自己的面和边：inspect faces / edges 加 of: "${r.id}"`
    })
    if (!step?.body) return what === "body" && refLines.length ? ["还没有实体。", ...refLines].join("\n") : "还没有实体。"
    if (what === "body") {
      const s = stats(step.body)
      return [
        `包围盒 X ${fmt(s.bbox[0][0])}…${fmt(s.bbox[1][0])}，Y ${fmt(s.bbox[0][1])}…${fmt(s.bbox[1][1])}，Z ${fmt(s.bbox[0][2])}…${fmt(s.bbox[1][2])}`,
        `尺寸 ${s.size.map(fmt).join(" × ")} mm，体积 ${fmt(s.volume / 1000)} cm³，质心 (${s.centerOfMass.map(fmt).join(", ")})`,
        `${s.solids} 个实体，${s.faces} 个面，${s.edges} 条边`,
        ...(step.parts && step.parts.length > 1
          ? [
              `零件：${step.parts
                .map((p) => {
                  const ps = stats(p.body)
                  return `${p.name}（${ps.size.map(fmt).join(" × ")} mm，Z ${fmt(ps.bbox[0][2])}…${fmt(ps.bbox[1][2])}，体积 ${fmt(ps.volume / 1000)} cm³）`
                })
                .join("；")}`,
            ]
          : []),
        ...refLines,
      ].join("\n")
    }
    const faces = faceInfos(step.body, step.origins)
    try {
      if (what === "faces") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = selector ? selectFaces(selector as any, faces, this.scope) : faces
        return list.slice(0, 40).map(describeFace).join("\n") + (list.length > 40 ? `\n…共 ${list.length} 个面` : "")
      }
      const edges = edgeInfos(step.body, faces)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = selector ? selectEdges(selector as any, edges, faces, this.scope) : edges
        return list.slice(0, 40).map(describeEdge).join("\n") + (list.length > 40 ? `\n…共 ${list.length} 条边` : "")
      } finally {
        disposeInfos([], edges)
      }
    } catch (e) {
      return describeError(e).message
    } finally {
      disposeInfos(faces)
    }
  }

  /**
   * What the learner clicked on the latest body (by mesh hash): a description,
   * a selector verified to pick exactly it, and sketch coordinates on a face.
   */
  pick(target: { kind: "face" | "edge"; hash: number; point: V3 }): PickInfo | null {
    const step = this.lastBuilt(this.steps.length)
    if (!step?.body) return null
    const info = this.pickOn(step, target)
    const part = info && this.partOf(step, target.kind, target.hash)
    return info && part ? { ...info, where: `${part} · ${info.where}` } : info
  }

  /** The part a face or edge of a split body belongs to. */
  private partOf(step: Step, kind: "face" | "edge", hash: number): string | null {
    if (!step.parts || step.parts.length < 2) return null
    for (const p of step.parts) {
      const items = kind === "face" ? facesOf(p.body) : edgesOf(p.body)
      const hit = items.some((x) => x.hashCode === hash)
      items.forEach((x) => x.delete())
      if (hit) return p.name
    }
    return null
  }

  private pickOn(step: Step, target: { kind: "face" | "edge"; hash: number; point: V3 }): PickInfo | null {
    if (!step.body) return null
    const faces = faceInfos(step.body, step.origins)
    const name = (id: string) => {
      const f = this.tree.features.find((x) => x.id === id)
      return f ? displayName(this.tree, f) : id
    }
    try {
      if (target.kind === "face") {
        const face = faces.find((f) => f.face.hashCode === target.hash)
        if (!face) return null
        const n = face.normal ? axisDir(face.normal) : null
        const kind = { plane: "平面", cylinder: "圆柱面", cone: "圆锥面", sphere: "球面", torus: "环面", freeform: "自由曲面" }[face.kind]
        const facing = n ? `朝${{ "+Z": "上", "-Z": "下", "+X": "右（+X）", "-X": "左（-X）", "+Y": "后（+Y）", "-Y": "前（-Y）" }[n]}` : null
        const what = [kind, facing && `${facing}${n?.[1] === "Z" ? `（${n}）` : ""}`, face.radius !== undefined && `R${fmt(face.radius)}`].filter(Boolean).join(" · ")
        const origins = face.origin && face.origin !== "?" ? [face.origin] : []
        const plane = n ? ({ Z: "XY", Y: "XZ", X: "YZ" } as const)[n[1] as "X" | "Y" | "Z"] : null
        const uv = (p: V3): [number, number] => (plane === "XY" ? [p[0], p[1]] : plane === "XZ" ? [p[0], p[2]] : [p[1], p[2]])
        return {
          kind: "face",
          hash: target.hash,
          point: target.point,
          what,
          where: origins.length ? `来自「${name(origins[0])}」` : "来源不明",
          origins,
          facts: `面积 ${fmt(measureArea(face.face))} mm²`,
          selector: uniqueFaceSelector(face, faces, this.scope, target.point),
          sketch:
            plane && n
              ? { plane, offset: r2(face.center["XYZ".indexOf(n[1])]), uv: uv(target.point).map(r2) as [number, number] }
              : face.kind === "plane" && face.normal
                ? slopeSketch(face.center, face.normal, target.point)
                : null,
        }
      }
      const edges = edgeInfos(step.body, faces)
      try {
        const edge = edges.find((e) => e.edge.hashCode === target.hash)
        if (!edge) return null
        const d = edge.dir ? axisDir(edge.dir) : null
        const kind = { line: "直线边", circle: "圆弧边", freeform: "曲线边" }[edge.kind]
        const what = [kind, d && `沿 ${d[1]} 方向`, edge.radius !== undefined && `R${fmt(edge.radius)}`].filter(Boolean).join(" · ")
        const origins = [...new Set(edge.faces.map((i) => faces[i]?.origin).filter((o): o is string => !!o && o !== "?"))]
        const where =
          origins.length === 0 ? "来源不明" : origins.length === 1 ? `「${name(origins[0])}」的面相交处` : `在「${name(origins[0])}」和「${name(origins[1])}」的面之间`
        // Tangent line between a fillet and its neighbour: drawn like an edge, but there's no corner there.
        let smooth = false
        if (edge.faces.length === 2) {
          const [na, nb] = edge.faces.map((i) => faces[i].face.normalAt(edge.mid))
          smooth = na.dot(nb) > 0.999
          na.delete()
          nb.delete()
        }
        return {
          kind: "edge",
          hash: target.hash,
          point: target.point,
          what,
          where,
          origins,
          facts: `长 ${fmt(edge.length)} mm`,
          selector: uniqueEdgeSelector(edge, edges, faces, this.scope, target.point),
          smooth,
          sketch: null,
        }
      } finally {
        disposeInfos([], edges)
      }
    } finally {
      disposeInfos(faces)
    }
  }

  /**
   * A selector for exactly these clicked faces / edges of the body that step
   * `before` starts from (what a fillet is applied to), with what it says and
   * picks; null when there's no plain description for this set.
   */
  selectorFor(kind: "face" | "edge", hashes: number[], before: number): { selector: Record<string, unknown>; count: number } | null {
    const step = this.lastBuilt(before)
    if (!step?.body || !hashes.length) return null
    const faces = faceInfos(step.body, step.origins)
    try {
      if (kind === "face") {
        const targets = faces.filter((f) => hashes.includes(f.face.hashCode))
        const sel = targets.length === hashes.length ? groupFaceSelector(targets, faces, this.scope) : null
        return sel ? { selector: sel, count: targets.length } : null
      }
      const edges = edgeInfos(step.body, faces)
      try {
        const targets = edges.filter((e) => hashes.includes(e.edge.hashCode))
        const sel = targets.length === hashes.length ? groupEdgeSelector(targets, edges, faces, this.scope) : null
        return sel ? { selector: sel, count: targets.length } : null
      } finally {
        disposeInfos([], edges)
      }
    } finally {
      disposeInfos(faces)
    }
  }

  /** The edges around a face of the body step `before` starts from (clicking a face in an edge box picks its rim). */
  faceEdges(faceHash: number, before: number): number[] {
    const step = this.lastBuilt(before)
    if (!step?.body) return []
    const faces = faceInfos(step.body, step.origins)
    const edges = edgeInfos(step.body, faces)
    try {
      const face = faces.find((f) => f.face.hashCode === faceHash)
      return face ? edges.filter((e) => e.faces.includes(face.index)).map((e) => e.edge.hashCode) : []
    } finally {
      disposeInfos(faces, edges)
    }
  }

  /** Mesh hashes a selector picks on the latest body now (or on the body step `before` starts from); null when it no longer resolves. */
  locate(kind: "face" | "edge", selector: unknown, before?: number): number[] | null {
    const step = this.lastBuilt(before ?? this.steps.length)
    if (!step?.body) return null
    const faces = faceInfos(step.body, step.origins)
    try {
      if (kind === "face") return selectFaces(selector as FaceSelector, faces, this.scope).map((f) => f.face.hashCode)
      const edges = edgeInfos(step.body, faces)
      try {
        return selectEdges(selector as EdgeSelector, edges, faces, this.scope).map((e) => e.edge.hashCode)
      } finally {
        disposeInfos([], edges)
      }
    } catch {
      return null
    } finally {
      disposeInfos(faces)
    }
  }

  /**
   * An engineering drawing of the latest body (kernel/drawing.ts). Text has
   * thousands of edges and is a note on a drawing anyway: the views are made
   * from the body before the first lettering feature.
   */
  drawing(withIso: boolean): DrawingData | null {
    const usesText = (f: Feature) => {
      const sk = "sketch" in f && typeof f.sketch === "string" ? this.tree.features.find((x) => x.id === f.sketch) : undefined
      return sk?.op === "sketch" && sk.shapes.some((x) => x.type === "text")
    }
    const cut = this.tree.features.findIndex(usesText)
    const until = cut >= 0 ? cut : this.steps.length
    const step = this.lastBuilt(until)
    if (!step?.body) return null
    const before = new Set(this.tree.features.slice(0, until).map((f) => f.id))
    const dims = this.dimensions().filter((d) => before.has(d.feature))
    return makeDrawing(step.body, step.origins, dims, withIso, cut >= 0 ? "文字见模型" : undefined)
  }

  /** Dimensions of every feature that built (kernel/dims.ts). */
  dimensions(): Dim[] {
    const geoms = new Map<string, StepGeom>()
    for (const s of this.steps) if (s.result.state === "ok" && s.geom) geoms.set(s.feature.id, s.geom)
    const last = this.lastBuilt(this.steps.length)
    const bb = last?.body ? (last.body.boundingBox.bounds as [V3, V3]) : null
    const diag = bb ? Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]) : 50
    return dimensionsOf(this.tree, this.scope, geoms, Math.max(3, 0.06 * diag))
  }

  /** Sizes of one or two clicked faces / edges of the latest body, and how they relate. */
  measure(targets: MeasureSpec[]): MeasureResult | null {
    const step = this.lastBuilt(this.steps.length)
    if (!step?.body || !targets.length) return null
    const two = targets.slice(0, 2)
    if (two.every((t) => t.kind === "face" || t.kind === "edge")) return measure(step.body, step.origins, two as MeasureTarget[])
    const owned: AnyShape[] = []
    try {
      const items = two.map((t) => this.targetShape(step, t, owned))
      if (items.length < 2) return { items: [items[0].item], between: [], segment: null }
      const r = relation(items[0].shape, items[1].shape, items[0].solid && items[1].solid)
      const between = [{ name: "最短距离", value: r.d <= TOUCH ? "0（接触）" : `${fmt(r.d)} mm` }]
      if (r.overlap > 1e-6) between.push({ name: "重叠体积", value: `${fmt(r.overlap)} mm³（相交）` })
      return { items: items.map((x) => x.item), between, segment: r.segment }
    } finally {
      owned.forEach((x) => x.delete())
    }
  }

  /** The shape a measure target stands for; shapes made here go into `owned` to be freed. */
  private targetShape(step: Step, t: MeasureSpec, owned: AnyShape[]): { shape: AnyShape; solid: boolean; item: MeasureResult["items"][number] } {
    const body = step.body!
    if (t.kind === "part") {
      const part = step.parts?.find((p) => p.name === t.name)
      if (part) {
        const st = stats(part.body)
        return { shape: part.body, solid: true, item: { kind: "part", hash: -1, what: `零件「${t.name}」`, facts: [`体积 ${fmt(st.volume)} mm³`, `外形 ${st.size.map(fmt).join("×")}`] } }
      }
      const ref = [...(step.refs ?? []), ...this.context].find((r) => r.name === t.name || r.id === t.name)
      if (ref) return { shape: ref.shape, solid: true, item: { kind: "part", hash: -1, what: `参考体「${ref.name}」`, facts: [`外形 ${sizeOf(ref.shape).map(fmt).join("×")}`] } }
      const names = [...(step.parts ?? []).map((p) => p.name), ...(step.refs ?? []).map((r) => r.name), ...this.context.map((r) => r.name)]
      throw new InputError(`没有叫「${t.name}」的零件或参考体${names.length ? `：现在有 ${names.join("、")}` : "（还没有拆件，整个模型只有一个实体）"}`)
    }
    const faces = faceInfos(body, step.origins)
    const edges = t.kind === "edge" ? edgeInfos(body, faces) : []
    try {
      if (t.kind === "feature") {
        const mine = faces.filter((f) => f.origin === t.id)
        const f = this.tree.features.find((x) => x.id === t.id)
        if (!f) throw new InputError(`找不到特征「${t.id}」`)
        if (!mine.length) throw new InputError(`「${displayName(this.tree, f)}」生成的面现在都不在了（被后面的特征盖掉或切掉了）`)
        const shape = makeCompound(mine.map((x) => x.face.clone())) as unknown as AnyShape
        owned.push(shape)
        return { shape, solid: false, item: { kind: "feature", hash: -1, what: `「${displayName(this.tree, f)}」的面`, facts: [`${mine.length} 个面`] } }
      }
      const x = t.kind === "face" ? faces.find((f) => f.face.hashCode === t.hash) : edges.find((e) => e.edge.hashCode === t.hash)
      if (!x) throw new InputError("要量的面或边找不到了")
      const shape = ("face" in x ? x.face : x.edge).clone() as AnyShape
      owned.push(shape)
      const res = measure(body, step.origins, [t])
      return { shape, solid: false, item: res?.items[0] ?? { kind: t.kind, hash: t.hash, what: t.kind === "face" ? "面" : "边", facts: [] } }
    } finally {
      disposeInfos(faces, edges)
    }
  }

  /** STEP or STL of the body; after a split, one STEP with a named solid per part, or a zip of one STL per part. */
  async exportBody(format: "step" | "stl", index?: number): Promise<Blob | null> {
    const step = this.lastBuilt(index === undefined ? this.steps.length : index + 1)
    if (!step?.body) return null
    const parts = step.parts && step.parts.length > 1 ? step.parts : null
    if (!parts) return format === "step" ? step.body.blobSTEP() : (step.body.blobSTL({ binary: true }) as Blob)
    if (format === "step") {
      const blob = exportSTEP(parts.map((p) => ({ shape: p.body, name: p.name })))
      return new Blob([stepAscii(await blob.text())], { type: "application/STEP" })
    }
    const files = await Promise.all(
      parts.map(async (p) => ({ name: `${p.name.replace(/[\\/:*?"<>|]/g, "_")}.stl`, data: new Uint8Array(await (p.body.blobSTL({ binary: true }) as Blob).arrayBuffer()) })),
    )
    return zipStore(files)
  }

  dispose() {
    this.disposeFrom(0)
    for (const shape of this.parsed.values()) shape.delete()
    this.parsed.clear()
    this.context.forEach((r) => r.shape.delete())
    this.context = []
  }

  // ---------------------------------------------------------------- internals

  /** Last step before `i` that produced a body (ok state). */
  lastBuilt(i: number): Step | null {
    for (let k = Math.min(i, this.steps.length) - 1; k >= 0; k--) if (this.steps[k].result.state === "ok") return this.steps[k]
    return null
  }

  private disposeFrom(i: number) {
    for (const s of this.steps.slice(i)) {
      if (s.ownsBody) s.body?.delete()
      s.parts?.forEach((p) => p.owned && p.body.delete())
      s.refs?.forEach((r) => r.owned && r.shape.delete())
      s.tools?.forEach((t) => t.tool.delete())
    }
    this.steps.length = Math.min(this.steps.length, i)
  }

  private base(f: Feature, key: string, prev: Step | null, tree: Tree, result: Partial<FeatureResult>): Step {
    return {
      key,
      feature: f,
      result: { id: f.id, op: f.op, name: displayName(tree, f), state: "ok", ms: 0, ...result },
      body: prev?.body ?? null,
      ownsBody: false,
      origins: prev?.origins ?? [],
      status: (prev?.origins ?? []).map(() => "kept"),
      sigs: prev?.sigs ?? [],
      mesh: prev?.mesh ?? null,
      edges: prev?.edges ?? null,
      parts: prev?.parts?.map((p) => ({ ...p, owned: false })),
      partOrigins: prev?.partOrigins,
      mainName: prev?.mainName,
      refs: prev?.refs?.map((r) => ({ ...r, owned: false })),
    }
  }

  private skip(f: Feature, key: string, prev: Step | null, tree: Tree): Step {
    return this.base(f, key, prev, tree, { state: "skipped", message: "前面的特征失败了，这一步没有重建" })
  }

  private run(f: Feature, key: string, prev: Step | null, tree: Tree): Step {
    const t0 = performance.now()
    const step = this.base(f, key, prev, tree, {})
    const warnings: string[] = []
    try {
      const dup = tree.features.findIndex((x) => x.id === f.id)
      if (tree.features[dup] !== f) throw new InputError(`特征 id「${f.id}」重复了`)
      const part = partOf(f, tree)
      const g = part !== f.part ? ({ ...f, part } as Feature) : f
      const isNew = startsPart(g, prev)
      if (!isNew && g.part && BODY_OPS.has(f.op) && prev?.body && !(prev.parts && prev.parts.length > 1) && g.part !== (prev.mainName ?? "主体"))
        throw new InputError(`没有叫「${g.part}」的零件：现在只有一个实体${prev.mainName ? `「${prev.mainName}」` : ""}。要新建零件，就在加料（拉伸、旋转、扫掠、放样）时写这个名字`)
      const assembly = tree.features.some((x) => x.op === "component")
      if (assembly && f.op !== "component") throw new InputError("装配里只能放零件（component）。要改零件的形状，用 open_part 打开它的文件")
      const out =
        f.op === "split"
          ? this.split(f, prev)
          : f.op === "component"
            ? this.component(f, prev, warnings)
            : isNew
            ? this.newPart(g, prev!, warnings)
            : prev?.parts && prev.parts.length > 1 && (BODY_OPS.has(f.op) || (f.op === "import" && (f.mode ?? "reference") !== "reference"))
              ? this.onParts(g, prev, prev.parts, warnings)
              : this.apply(f, prev, warnings)
      // The first addition may name the body: it is that part until a second one comes.
      if (!prev?.body && g.part && addsMaterial(g)) step.mainName = g.part
      if (out.parts) step.parts = out.parts
      if (out.ref) step.refs = [...(step.refs ?? []), { id: f.id, name: displayName(tree, f), shape: out.ref, mesh: meshShape(out.ref as Shape3D), edges: meshEdges(out.ref as Shape3D), owned: true }]
      Object.assign(step.result, { summary: out.summary, selected: out.selected })
      if (out.sketch) step.sketch = out.sketch
      if (out.tools) step.tools = out.tools
      if (out.threads) step.threads = out.threads
      if (out.geom) step.geom = out.geom
      if (out.body) {
        this.commitBody(step, prev, out.body, f.id)
        // A component's faces are its part file's: its slivers are reported there, not in the assembly.
        const sliver = f.op === "sketch" || f.op === "import" || f.op === "component" ? null : this.slivers(step)
        if (sliver) warnings.push(sliver)
      }
      // Each part's faces are a run of the compound's, in part order.
      if (out.body && step.parts) {
        let at = 0
        step.partOrigins = step.parts.map((p) => {
          const n = countOf(p.body, "face")
          const o = step.origins.slice(at, at + n)
          at += n
          return o
        })
      }
    } catch (e) {
      const ex = explain(f.op, describeError(e))
      Object.assign(step.result, { state: "error", message: ex.message, hint: ex.hint })
    }
    if (warnings.length) step.result.warnings = warnings
    step.result.ms = performance.now() - t0
    return step
  }

  /** Mesh the new body, classify its faces against the previous one, carry provenance forward. */
  private commitBody(step: Step, prev: Step | null, body: Shape3D, id: string) {
    const mesh = meshShape(body)
    const faces = facesOf(body)
    const sigs = faceSignatures(faces, mesh)
    const prevFaces = prev?.body ? facesOf(prev.body) : null
    const cls = classifyFaces(prevFaces, prev?.sigs ?? null, sigs)
    prevFaces?.forEach((pf) => pf.delete())
    faces.forEach((x) => x.delete())
    step.body = body
    step.ownsBody = true
    step.mesh = mesh
    step.edges = meshEdges(body)
    step.sigs = sigs
    step.status = cls.map((c) => c.status)
    step.origins = cls.map((c) => (c.match >= 0 && prev ? prev.origins[c.match] : id))
    step.result.faces = {
      new: step.status.filter((s) => s === "new").length,
      modified: step.status.filter((s) => s === "modified").length,
    }
  }

  /** New faces too small to be meant: two faces nearly coinciding, or a cut grazing a face. */
  private slivers(step: Step): string | null {
    if (!step.body || !step.status.some((s) => s === "new")) return null
    const faces = facesOf(step.body)
    try {
      const areas = faces.map((f) => measureArea(f))
      const total = areas.reduce((a, b) => a + b, 0)
      const tiny = areas.filter((a, i) => step.status[i] === "new" && a < SLIVER_AREA && a < 1e-5 * total)
      if (!tiny.length) return null
      return `生成了 ${tiny.length} 个极小的面（最小 ${Math.min(...tiny).toPrecision(2)} mm²）：多半是两个面几乎重合，或者切除擦着面切过去`
    } finally {
      faces.forEach((f) => f.delete())
    }
  }

  private plane(ref: PlaneRef, prev: Step | null): ResolvedPlane {
    const P = PLANES[ref.plane]
    let coord = ref.offset !== undefined ? num(ref.offset, this.scope) : 0
    let label = ref.offset !== undefined && coord !== 0 ? `${P.label}偏移 ${fmt(coord)}` : P.label
    let flipped = false
    if (ref.face) {
      if (!prev?.body) throw new InputError("还没有实体，草图不能贴在面上")
      const faces = faceInfos(prev.body, prev.origins)
      try {
        const sel = selectFaces(ref.face, faces, this.scope)
        if (sel.some((x) => x.kind !== "plane" || !x.normal)) throw new InputError("选中的面不是平面，草图贴不上去")
        // An inclined face: the sketch lies on it, centred on it, x level, y up the slope.
        if (sel.some((x) => Math.abs(dot(x.normal!, P.normal)) < 0.9999)) {
          if (sel.length > 1) throw new InputError("斜面只能选一个：加 near 或 expect: 1")
          if (ref.tilt) throw new InputError("贴在斜面上时不用 tilt")
          const f = sel[0]
          const fr = faceFrame(f.center, f.normal!)
          return { name: ref.plane, origin: add(fr.origin, mul(fr.normal, coord)), x: fr.x, y: fr.y, normal: fr.normal, label: `斜面（${describeFace(f).split(" 来自")[0]}）`, custom: true }
        }
        const coords = new Set(sel.map((x) => r2(x.center[P.axis])))
        if (coords.size > 1) throw new InputError("选中的面不在同一高度，加 near 或 expect 只选一个")
        coord += sel[0].center[P.axis]
        flipped = dot(sel[0].normal!, P.normal) < 0
        label = `面（${describeFace(sel[0]).split(" 来自")[0]}）`
      } finally {
        disposeInfos(faces)
      }
    }
    // A datum plane flush with the body's far side (the back, the bottom…) is seen from outside that side too.
    if (!ref.face && !ref.tilt && prev?.body) {
      const [lo, hi] = (prev.body.boundingBox.bounds as [V3, V3]).map((b) => b[P.axis])
      const outward = Math.abs(coord - hi) < 1e-3 ? 1 : Math.abs(coord - lo) < 1e-3 ? -1 : 0
      flipped = outward !== 0 && outward !== Math.sign(P.normal[P.axis])
    }
    const origin: V3 = [0, 0, 0]
    origin[P.axis] = coord
    if (ref.tilt) {
      const k = AXIS[ref.tilt.axis]
      const a = num(ref.tilt.angle, this.scope)
      const turn = (v: V3) => rotate(v, k, a)
      return { name: ref.plane, origin: turn(origin), x: turn(P.x), y: turn(P.y), normal: turn(P.normal), label: `${label} · 绕 ${ref.tilt.axis} 转 ${fmt(a)}°`, custom: true }
    }
    return { name: ref.plane, origin, x: P.x, y: P.y, normal: P.normal, label, flipped }
  }

  private sketchOf(id: string): NonNullable<Step["sketch"]> {
    const s = this.steps.find((x) => x.feature.id === id)
    if (!s) throw new InputError(`找不到草图「${id}」（必须在这个特征之前）`)
    if (s.result.state === "suppressed") throw new InputError(`草图「${id}」被压缩了`)
    if (s.feature.op !== "sketch" || !s.sketch) throw new InputError(`「${id}」不是草图`)
    return s.sketch
  }

  private toolsOf(id: string): Tool[] {
    const s = this.steps.find((x) => x.feature.id === id)
    if (!s) throw new InputError(`找不到特征「${id}」（必须在这个特征之前）`)
    if (s.result.state === "suppressed") throw new InputError(`「${id}」被压缩了，不能阵列或镜像`)
    if (!s.tools?.length) throw new InputError(`「${id}」不是加料、切除或孔特征，不能阵列或镜像`)
    return s.tools
  }

  private bigLength(body: Shape3D | null) {
    if (!body) return 1000
    const [a, b] = body.boundingBox.bounds as [V3, V3]
    return 2 * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + 10
  }

  private apply(
    f: Feature,
    prev: Step | null,
    warnings: string[],
  ): ApplyOut {
    const n = (v: number | string) => num(v, this.scope)
    const int = (v: number | string, min: number, what: string) => count(n(v), min, what)
    const body = prev?.body ?? null
    switch (f.op) {
      case "sketch": {
        const plane = this.plane(f.on, prev)
        const { drawing, paths } = sketchDrawing(f.shapes, this.scope, plane.flipped)
        let lines: number[] = []
        if (drawing) {
          const sk = sketchOn(drawing.clone(), plane)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const faceShape: any = (sk as any).faces()
          lines = Array.from(meshEdges(faceShape).lines)
          faceShape.delete?.()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(sk as any).delete?.()
        }
        // Open paths drawn as their segments, on the plane.
        const at = (p: [number, number]) => add(plane.origin, add(mul(plane.x, p[0]), mul(plane.y, p[1])))
        const pathLines = paths.flatMap((pts) => pts.slice(1).flatMap((p, i) => [...at(pts[i]), ...at(p)]))
        return { sketch: { drawing, paths, plane, lines: Float32Array.from([...lines, ...pathLines]) }, geom: { op: "sketch", plane: frameOf(plane) }, summary: `${plane.label} · ${f.shapes.map(shapeName).join("、")}` }
      }
      case "import": {
        const asset = this.assets.get(f.file)
        if (!asset) throw new InputError(this.assetsGiven ? `没有读到「${f.file}」` : "导入 STEP 只能在桌面版 Arbor 里用：网页读不到你电脑上的文件")
        if (!asset.shape) throw new InputError(`「${f.file}」读不了：${asset.error ?? "不是能读的 STEP 文件"}`)
        let shape = asset.shape.clone() as AnyShape
        for (const r of f.rotate ?? []) shape = shape.rotate(n(r.angle), [0, 0, 0], AXIS[r.axis])
        if (f.at) shape = shape.translate(f.at.map(n) as V3)
        const mode = f.mode ?? "reference"
        const summary = `${mode === "reference" ? "参考体" : mode === "add" ? "并入" : "减去"} ${f.file} · ${sizeOf(shape).map(fmt).join(" × ")}`
        if (mode === "reference") return { ref: shape, summary }
        if (!body) {
          if (mode === "add") return { body: shape as Shape3D, summary }
          shape.delete()
          throw new InputError("还没有实体，没有东西可以减")
        }
        const out = mode === "add" ? body.fuse(shape as Shape3D) : body.cut(shape as Shape3D)
        shape.delete()
        return { body: out, summary }
      }
      case "extrude": {
        const sk = this.sketchOf(f.sketch)
        const { plane } = sk
        const mode = f.mode ?? "add"
        const ways = [f.distance !== undefined, !!f.through, !!f.until].filter(Boolean).length
        if (ways !== 1) throw new InputError("拉伸的 distance、until、through 正好写一个")
        const profile = f.thin ? thinProfile(sk.drawing, sk.paths, n(f.thin.t), f.thin.side ?? "center") : regionOf(sk, f.sketch)
        let origin = plane.origin
        let dir = plane.normal
        if (f.direction === "reverse") dir = mul(plane.normal, -1)
        let tool: Shape3D
        let how: string
        if (f.through) {
          if (mode !== "cut") throw new InputError("「贯穿」只用于切除")
          if (f.draft) throw new InputError("贯穿切除不能带拔模角")
          const d = 2 * this.bigLength(body)
          origin = add(plane.origin, mul(plane.normal, -d / 2))
          dir = plane.normal
          tool = mergeOverlaps(sketchOn(profile.clone(), plane, origin).extrude(d, { extrusionDirection: dir }) as Shape3D)
          how = "贯穿"
        } else if (f.until) {
          if (mode === "intersect") throw new InputError("求交不能和成形到（until）一起用")
          if (f.direction === "both") throw new InputError("两侧对称（both）不能和成形到（until）一起用")
          if (f.draft) throw new InputError("成形到不能带拔模角：先成形到，再用拔模特征")
          if (!body || !prev) throw new InputError("还没有实体，没有可以成形到的面")
          if (f.until === "next") {
            const long = mergeOverlaps(sketchOn(profile.clone(), plane, origin).extrude(2 * this.bigLength(body), { extrusionDirection: dir }) as Shape3D)
            const got = untilNext(long, body, origin, dir, mode)
            long.delete()
            tool = got.tool
            how = `成形到下一面（实际 ${fmt(got.length)} mm）`
          } else {
            const target = planeFace(body, prev.origins, f.until.face, this.scope, "成形到的面")
            const offset = f.until.offset !== undefined ? n(f.until.offset) : 0
            if (Math.abs(Math.abs(dot(target.normal, dir)) - 1) < 1e-6) {
              const d = dot(sub(target.center, origin), dir) - offset
              if (!(d > 1e-6)) throw new InputError("这个面在草图的另一侧：换个方向（direction: reverse），或者选别的面")
              tool = mergeOverlaps(sketchOn(profile.clone(), plane, origin).extrude(d, { extrusionDirection: dir }) as Shape3D)
              how = `成形到面（${fmt(d)} mm）`
            } else {
              if (offset) throw new InputError("成形到斜面时不能带 offset")
              const faces = faceInfos(body, prev.origins)
              try {
                const face = selectFaces(f.until.face, faces, this.scope)[0]
                const skt = sketchOn(profile.clone(), plane, origin)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (!("extrudeUntil" in (skt as any))) throw new InputError("成形到斜面只支持一个闭合轮廓")
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tool = (skt as any).extrudeUntil(face.face, { extrusionDirection: dir }) as Shape3D
              } catch (e) {
                if (e instanceof InputError) throw e
                throw new InputError("这个面挡不住整个轮廓：选一个能盖住整个草图的面")
              } finally {
                disposeInfos(faces)
              }
              how = "成形到斜面"
            }
          }
        } else {
          const d = n(f.distance!)
          if (!(d > 0)) throw new InputError("拉伸距离必须大于 0")
          if (f.direction === "both") origin = add(origin, mul(plane.normal, -d / 2))
          if (f.draft !== undefined && n(f.draft) !== 0) {
            const angle = n(f.draft)
            if (f.direction === "both") throw new InputError("两侧对称（both）不能带拔模角")
            const inset = d * Math.tan((angle * Math.PI) / 180)
            tool = tapered(
              () => sketchOn(profile.clone(), plane, origin).extrude(d, { extrusionDirection: dir }) as Shape3D,
              () => {
                const top = sketchOn(profile.offset(-inset), plane, add(origin, mul(dir, d)))
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (sketchOn(profile.clone(), plane, origin) as any).loftWith([top], { ruled: true }) as Shape3D
              },
              origin,
              plane.x,
              dir,
              angle,
            )
          } else tool = mergeOverlaps(sketchOn(profile.clone(), plane, origin).extrude(d, { extrusionDirection: dir }) as Shape3D)
          how = `${f.direction === "both" ? "两侧对称 " : f.direction === "reverse" ? "反向 " : ""}${fmt(d)} mm${f.draft ? ` · 拔模 ${fmt(n(f.draft))}°` : ""}`
        }
        if (f.onto) {
          if (f.through || f.until || f.draft) throw new InputError("onto（沿面等深）只和 distance 一起用，不能带 through、until、draft")
          if (mode === "intersect") throw new InputError("onto 用于切除或加料")
          if (!body || !prev) throw new InputError("还没有实体，没有面可以贴")
          tool.delete()
          const long = mergeOverlaps(sketchOn(profile.clone(), plane, add(plane.origin, mul(plane.normal, -this.bigLength(body)))).extrude(2 * this.bigLength(body), { extrusionDirection: plane.normal }) as Shape3D)
          const band = this.band(body, prev.origins, f.onto, n(f.distance!), mode)
          tool = long.intersect(band.shape)
          long.delete()
          band.shape.delete()
          // Projected straight through, the sketch also lands on the far side of a cylinder: keep the side it faces.
          if (band.axis) {
            const side = dot(sub(plane.origin, band.axis.p), plane.normal)
            if (Math.abs(side) > 1e-6) {
              const near = solidsOf(tool).filter((x) => {
                const [a, b] = x.boundingBox.bounds as [V3, V3]
                return dot(sub(mul(add(a, b), 0.5), band.axis!.p), plane.normal) * side > 0
              })
              if (!near.length) throw new InputError("草图投影不到这个圆柱面上：把草图挪到面的正前方")
              const kept = compoundOf(near)
              tool.delete()
              tool = kept
            }
          }
          if (measureShapeVolumeProperties(tool).volume < 1e-9) throw new InputError("草图投影不到选中的面上：把草图挪到面的正前方")
          how = `沿${band.what}等深 ${fmt(n(f.distance!))} mm`
        }
        const next = applyTool(body, tool, mode, warnings)
        const box = profile.boundingBox.bounds as [[number, number], [number, number]]
        return {
          body: next,
          tools: [{ tool, mode }],
          geom: f.through ? undefined : { op: "extrude", plane: frameOf(plane), start: origin, dir, box: [box[0], box[1]] },
          summary: `${f.thin ? `薄壁 ${fmt(n(f.thin.t))} · ` : ""}${mode === "cut" ? "切除" : mode === "intersect" ? "求交" : "加料"} ${how}`,
        }
      }
      case "revolve": {
        const sk = this.sketchOf(f.sketch)
        const { plane } = sk
        const drawing = regionOf(sk, f.sketch)
        const P = PLANES[plane.name]
        const axis = AXIS[f.axis]
        const angle = f.angle !== undefined ? n(f.angle) : 360
        if (!(angle > 0 && angle <= 360)) throw new InputError("旋转角度要在 0–360° 之间")
        // The profile may touch the axis but not cross it.
        if (!plane.custom && plane.origin[P.axis] === 0) {
          const bb = drawing.boundingBox.bounds
          const across = (lo: number, hi: number) => lo < -1e-6 && hi > 1e-6
          if ((dot(axis, P.y) > 0.999 && across(bb[0][0], bb[1][0])) || (dot(axis, P.x) > 0.999 && across(bb[0][1], bb[1][1])))
            throw new InputError("轮廓跨过了旋转轴：旋转体只画轴一侧的半截面")
        }
        const mode = f.mode ?? "add"
        if (f.symmetric && f.start !== undefined) throw new InputError("start 和 symmetric 只写一个")
        const start = f.symmetric ? -angle / 2 : f.start !== undefined ? n(f.start) : 0
        let tool = mergeOverlaps(sketchOn(drawing.clone(), plane).revolve(axis, { origin: [0, 0, 0], angle }) as Shape3D)
        if (start) tool = tool.rotate(start, [0, 0, 0], axis)
        const next = applyTool(body, tool, mode, warnings)
        const from = f.symmetric ? " · 两侧对称" : start ? ` · 从 ${fmt(start)}° 起` : ""
        return {
          body: next,
          tools: [{ tool, mode }],
          geom: { op: "revolve", plane: frameOf(plane) },
          summary: `${mode === "cut" ? "旋转切除" : mode === "intersect" ? "旋转求交" : "旋转"} ${fmt(angle)}°${from} · 绕 ${f.axis} 轴`,
        }
      }
      case "fillet":
      case "chamfer": {
        if (!body) throw new InputError("还没有实体")
        const size = n(f.op === "fillet" ? f.r : f.d)
        if (!(size > 0)) throw new InputError(`${f.op === "fillet" ? "半径" : "距离"}必须大于 0`)
        const faces = faceInfos(body, prev!.origins)
        const edges = edgeInfos(body, faces)
        try {
          const sel = selectEdges(f.edges, edges, faces, this.scope)
          const list = sel.map((e) => e.edge)
          const next = f.op === "fillet" ? body.fillet(size, (e) => e.inList(list)) : body.chamfer(size, (e) => e.inList(list))
          const first = sel[0]
          const geom: StepGeom = { op: "edges", at: first.mid, out: outward(first, faces), count: sel.length }
          return { body: next, selected: sel.length, geom, summary: `${f.op === "fillet" ? "R" : "C"}${fmt(size)} · ${sel.length} 条边` }
        } finally {
          disposeInfos(faces, edges)
        }
      }
      case "shell": {
        if (!body) throw new InputError("还没有实体")
        const t = n(f.t)
        if (!(t > 0)) throw new InputError("壁厚必须大于 0")
        const faces = faceInfos(body, prev!.origins)
        try {
          const sel = selectFaces(f.open, faces, this.scope)
          const list = sel.map((x) => x.face)
          const next = body.shell(t, (ff) => ff.inList(list))
          const before = measureShapeVolumeProperties(body).volume
          const after = measureShapeVolumeProperties(next).volume
          if (after > before * 0.98) throw new InputError("抽壳后体积几乎没变：内核没有真正抽空，试试更小的壁厚")
          return { body: next, selected: sel.length, geom: shellGeom(sel[0]), summary: `壁厚 ${fmt(t)} · 开口 ${sel.length} 个面` }
        } finally {
          disposeInfos(faces)
        }
      }
      case "hole": {
        if (!body) throw new InputError("还没有实体，不能打孔")
        const plane = this.plane(f.on, prev)
        let std: ReturnType<typeof standardHole> | null = null
        try {
          std = f.standard ? standardHole(f.standard) : null
        } catch (e) {
          throw new InputError((e as Error).message)
        }
        if (!std && f.d === undefined) throw new InputError("孔要么给 d（孔径），要么给 standard（标准孔）")
        const d = std ? std.d : n(f.d!)
        if (!(d > 0)) throw new InputError("孔径必须大于 0")
        const depth = f.depth !== undefined ? n(f.depth) : this.bigLength(body)
        const drill = f.reverse ? plane.normal : mul(plane.normal, -1)
        const cbore = f.cbore ? { r: n(f.cbore.d) / 2, depth: n(f.cbore.depth) } : std?.cbore && { r: std.cbore.d / 2, depth: std.cbore.depth }
        const csink = f.csink ? { r: n(f.csink.d) / 2, angle: f.csink.angle !== undefined ? n(f.csink.angle) : 90 } : std?.csink && { r: std.csink.d / 2, angle: 90 }
        const template = () => holeTool(d / 2, depth, cbore, csink)
        const centers = f.at.map(([u, v]) => add(plane.origin, add(mul(plane.x, n(u)), mul(plane.y, n(v)))))
        const parts = centers.map((c) => orient(template(), drill, c))
        const tool = parts.length === 1 ? parts[0] : (makeCompound(parts) as unknown as Shape3D)
        const next = applyTool(body, tool, "cut", warnings)
        const kind = std ? std.label : `${cbore ? "沉头孔" : csink ? "埋头孔" : "孔"} ⌀${fmt(d)}`
        return {
          body: next,
          tools: [{ tool, mode: "cut" }],
          summary: `${kind} × ${f.at.length} · ${f.depth !== undefined ? `深 ${fmt(depth)}` : "贯穿"}`,
          threads: std?.thread ? [{ r: d / 2, major: std.thread.major }] : undefined,
          geom: { op: "hole", plane: frameOf(plane), centers, r: d / 2 },
        }
      }
      case "linear_pattern":
      case "circular_pattern": {
        if (!body) throw new InputError("还没有实体")
        const sources = f.features.flatMap((id) => this.toolsOf(id))
        const moves: ((s: Shape3D) => Shape3D)[] = []
        let summary: string
        if (f.op === "linear_pattern") {
          const v = mul(DIRS[f.dir], n(f.spacing))
          const v2 = f.dir2 && f.count2 !== undefined && f.spacing2 !== undefined ? mul(DIRS[f.dir2], n(f.spacing2)) : null
          const c1 = int(f.count, 2, "个数")
          const c2 = v2 ? int(f.count2!, 2, "第二方向的个数") : 1
          if (c1 * c2 > MAX_COUNT) throw new InputError(`两个方向一共最多 ${MAX_COUNT} 个，现在是 ${c1} × ${c2}`)
          for (let i = 0; i < c1; i++)
            for (let j = 0; j < c2; j++) {
              if (i === 0 && j === 0) continue
              const t = add(mul(v, i), v2 ? mul(v2, j) : [0, 0, 0])
              moves.push((s) => s.translate(t))
            }
          summary = `×${c1}${v2 ? ` × ${c2}` : ""} · 间距 ${fmt(n(f.spacing))}`
        } else {
          const total = f.angle !== undefined ? n(f.angle) : 360
          const c = int(f.count, 2, "个数")
          const stepA = total >= 360 - 1e-9 ? 360 / c : total / (c - 1)
          for (let i = 1; i < c; i++) moves.push((s) => s.rotate(stepA * i, [0, 0, 0], AXIS[f.axis]))
          summary = `×${c} · ${fmt(total)}° · 绕 ${f.axis} 轴`
        }
        return { ...this.copyTools(body, sources, moves, summary, warnings), geom: { op: "pattern", seed: centerOf(sources) } as StepGeom }
      }
      case "sweep": {
        const plane = this.plane(f.path.on, prev)
        const pts = evalPoints(f.path.points, n)
        const corner = f.path.corner !== undefined ? n(f.path.corner) : 0
        let pen = draw(pts[0].to)
        pts.slice(1).forEach((p, i) => {
          pen = p.via ? pen.threePointsArcTo(p.to, p.via) : pen.lineTo(p.to)
          if (corner > 0 && i < pts.length - 2 && !pts[i + 2].via && !p.via) pen = pen.customCorner(corner)
        })
        const path = sketchOn(pen.done(), plane)
        const prof = f.profile
        const tool = (path as unknown as { sweepSketch: (fn: unknown) => Shape3D }).sweepSketch((pl: unknown, origin: unknown) =>
          prof.type === "circle" ? sketchCircle(n(prof.d) / 2, { plane: pl as never, origin: origin as never }) : sketchRectangle(n(prof.w), n(prof.h), { plane: pl as never, origin: origin as never }),
        )
        const mode = f.mode ?? "add"
        const next = applyTool(body, tool, mode, warnings)
        const shape = prof.type === "circle" ? `⌀${fmt(n(prof.d))}` : `${fmt(n(prof.w))}×${fmt(n(prof.h))}`
        return { body: next, tools: [{ tool, mode }], summary: `${mode === "cut" ? "扫掠切除" : "扫掠"} · 截面 ${shape} · 路径 ${pts.length} 点` }
      }
      case "loft": {
        const sketches = f.sketches.map((id) => {
          const src = this.sketchOf(id)
          const { plane } = src
          const drawing = regionOf(src, id)
          const sk = sketchOn(drawing.clone(), plane)
          if (!("wire" in sk)) throw new InputError(`放样的草图「${id}」有多个轮廓：每个截面只能是一个闭合轮廓`)
          return sk
        })
        const [first, ...rest] = sketches
        const tool = (first as unknown as { loftWith: (o: unknown[], c: unknown) => Shape3D }).loftWith(rest, { ruled: f.ruled ?? false })
        const mode = f.mode ?? "add"
        const next = applyTool(body, tool, mode, warnings)
        return { body: next, tools: [{ tool, mode }], summary: `${mode === "cut" ? "放样切除" : "放样"} · ${f.sketches.length} 个截面${f.ruled ? " · 直纹" : ""}` }
      }
      case "draft": {
        if (!body) throw new InputError("还没有实体")
        const angle = n(f.angle)
        if (!(Math.abs(angle) > 0 && Math.abs(angle) < 45)) throw new InputError("拔模角要在 0–45° 之间（常用 1–3°）")
        const faces = faceInfos(body, prev!.origins)
        try {
          const sel = selectFaces(f.faces, faces, this.scope)
          const list = sel.map((x) => x.face)
          let neutral: Plane
          if (f.neutral.face) {
            const nf = planeFace(body, prev!.origins, f.neutral.face, this.scope, "中性面")
            const x: V3 = Math.abs(nf.normal[2]) < 0.9 ? unit(cross([0, 0, 1], nf.normal)) : [1, 0, 0]
            neutral = new Plane(nf.center, x, nf.normal)
          } else {
            const origin: V3 = [0, 0, 0]
            origin[PLANES[f.neutral.plane].axis] = f.neutral.offset !== undefined ? n(f.neutral.offset) : 0
            neutral = makePlane(f.neutral.plane, origin)
          }
          const next = body.draft(angle, (ff) => ff.inList(list), neutral)
          const geom: StepGeom = { op: "faces", at: sel[0].center, out: sel[0].normal ?? [0, 0, 1] }
          return { body: next, selected: sel.length, geom, summary: `${fmt(angle)}° · ${sel.length} 个面 · 中性面 ${f.neutral.face ? "选中的面" : PLANES[f.neutral.plane].label}` }
        } finally {
          disposeInfos(faces)
        }
      }
      case "split":
        throw new InputError("拆件不在这里处理")
      case "rib": {
        if (!body) throw new InputError("还没有实体，筋要长在实体上")
        const sk = this.sketchOf(f.sketch)
        if (sk.drawing || sk.paths.length !== 1) throw new InputError("筋的草图只能有一条开放的线（path）")
        const tool = ribTool(body, sk.paths[0], frameOf(sk.plane), n(f.t), 2 * this.bigLength(body), !!f.flip)
        const next = applyTool(body, tool, "add", warnings)
        const pts = sk.paths[0]
        const mid = pts[Math.floor(pts.length / 2)]
        const geom: StepGeom = { op: "faces", at: add(sk.plane.origin, add(mul(sk.plane.x, mid[0]), mul(sk.plane.y, mid[1]))), out: sk.plane.normal }
        return { body: next, tools: [{ tool, mode: "add" }], geom, summary: `筋 厚 ${fmt(n(f.t))}` }
      }
      case "mirror": {
        if (!body) throw new InputError("还没有实体")
        const off = f.offset !== undefined ? n(f.offset) : 0
        const origin: V3 = [0, 0, 0]
        origin[PLANES[f.plane].axis] = off
        const label = `关于${PLANES[f.plane].label}${off ? `偏移 ${fmt(off)}` : ""}`
        if (!f.features?.length) {
          const mirrored = body.clone().mirror(f.plane, origin)
          const next = body.fuse(mirrored)
          mirrored.delete()
          return { body: next, summary: `镜像整个实体 · ${label}` }
        }
        const sources = f.features.flatMap((id) => this.toolsOf(id))
        return this.copyTools(body, sources, [(s) => s.mirror(f.plane, origin)], `镜像 ${f.features.length} 个特征 · ${label}`, warnings)
      }
      case "component":
        // Routed by `run` (it changes the parts, not one body).
        throw new InputError("装配里的零件不在这里处理")
    }
  }

  /** Cut the body (or one part of it) in two by a plane: two named parts. */
  private split(f: Extract<Feature, { op: "split" }>, prev: Step | null): ApplyOut {
    if (!prev?.body) throw new InputError("还没有实体，没有可以拆的")
    const parts: Part[] = prev.parts ?? [{ name: "", body: prev.body, explode: [0, 0, 0], owned: false }]
    const i = parts.length > 1 ? parts.findIndex((p) => p.name === f.of) : 0
    if (i < 0) throw new InputError(f.of ? `没有叫「${f.of}」的零件：现在有 ${parts.map((p) => p.name).join("、")}` : `已经有 ${parts.length} 个零件，要用 of 指定拆哪一个`)
    const [back, front] = f.parts
    if (back === front) throw new InputError("两个零件要起不同的名字")
    const clash = parts.filter((_, k) => k !== i).find((p) => p.name === back || p.name === front)
    if (clash) throw new InputError(`已经有叫「${clash.name}」的零件了`)
    const plane = this.plane(f.by, prev)
    const target = parts[i].body
    const big = 2 * this.bigLength(target)
    // The half space on the normal side, as a big slab starting at the plane.
    const pl = new Plane(plane.origin, plane.x, plane.normal)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slab = (drawRectangle(4 * big, 4 * big).sketchOnPlane(pl) as any).extrude(2 * big) as Shape3D
    pl.delete()
    const upper = target.intersect(slab)
    const lower = target.cut(slab)
    slab.delete()
    const vol = (x: Shape3D) => measureShapeVolumeProperties(x).volume
    const [vl, vu] = [vol(lower), vol(upper)]
    if (vl < 1e-6 || vu < 1e-6) {
      lower.delete()
      upper.delete()
      const [lo, hi] = target.boundingBox.bounds as [V3, V3]
      const along = [lo, hi].flatMap((a) => [lo, hi].map((b) => dot([a[0], b[1], (a[2] + b[2]) / 2], plane.normal)))
      const at = dot(plane.origin, plane.normal)
      throw new InputError(`切面没有碰到实体：沿切面法向的范围大约是 ${fmt(Math.min(...along))}–${fmt(Math.max(...along))}，现在切在 ${fmt(at)}`)
    }
    // Explode: the normal side moves off along the normal by most of the part's size across the cut.
    const [lo, hi] = target.boundingBox.bounds as [V3, V3]
    const across = Math.abs(dot(sub(hi, lo), plane.normal))
    const d = Math.max(15, 0.6 * across)
    const base = parts[i].explode
    const next: Part[] = [
      ...parts.slice(0, i).map((p) => ({ ...p, owned: false })),
      { name: back, body: lower, explode: base, owned: true },
      { name: front, body: upper, explode: add(base, mul(plane.normal, d)), owned: true },
      ...parts.slice(i + 1).map((p) => ({ ...p, owned: false })),
    ]
    const body = compoundOf(next.map((p) => p.body))
    return { body, parts: next, geom: { op: "sketch", plane: frameOf(plane) }, summary: `拆成 ${back}（V=${fmt(vl)}）、${front}（V=${fmt(vu)}）` }
  }

  /** An assembly's component: the part file's final shape (built in a kernel of its own, cached), placed. */
  private component(f: Extract<Feature, { op: "component" }>, prev: Step | null, warnings: string[]): ApplyOut {
    const n = (v: number | string) => num(v, this.scope)
    const got = this.components.get(f.file)
    if (!got) throw new InputError(this.componentsGiven ? `没有读到「${f.file}」` : "装配只能在桌面版 Arbor 里用：网页读不到你电脑上的文件")
    const built = buildComponent(got.source)
    const base = f.name ?? f.file.split(/[\\/]/).pop()!.replace(/\.(arbor-asm\.json|arbor\.json|json|step|stp)$/i, "")
    if (built.failed) warnings.push(`零件「${base}」有 ${built.failed} 个特征失败，用的是失败前的形状`)
    const placement: Placement = { rotate: (f.rotate ?? []).map((r) => ({ axis: r.axis, angle: n(r.angle) })), at: (f.at ?? [0, 0, 0]).map(n) as V3 }
    const added: Part[] = built.parts.map((p) => ({
      name: p.name && built.parts.length > 1 ? `${base}/${p.name}` : base,
      body: place(p.shape.clone(), placement),
      explode: [0, 0, 0],
      owned: true,
      auto: true,
      hidden: f.hidden,
    }))
    const before: Part[] = !prev?.body ? [] : prev.parts?.length ? prev.parts.map((p) => ({ ...p, owned: false })) : [{ name: prev.mainName ?? "主体", body: prev.body, explode: [0, 0, 0], owned: false, auto: true }]
    for (const a of added) {
      if (before.some((p) => p.name === a.name)) {
        added.forEach((x) => x.body.delete())
        throw new InputError(`零件名「${a.name}」重复了：给 component 写不同的 name`)
      }
      for (const p of before) {
        const r = relation(a.body, p.body, true)
        if (r.overlap > 1e-6) warnings.push(`「${a.name}」和「${p.name}」重叠 ${fmt(r.overlap)} mm³`)
      }
    }
    const parts = [...before, ...added]
    const all = added.length === 1 ? null : compoundOf(added.map((a) => a.body))
    const size = sizeOf(all ?? added[0].body)
    all?.delete()
    // Even a single component stays a named part (measure, checks and hiding go by its name).
    return { body: compoundOf(parts.map((p) => p.body)), parts, summary: `零件「${base}」← ${f.file} · ${size.map(fmt).join(" × ")}` }
  }

  /**
   * The layer `depth` thick under (cut) or over (add) one planar or cylindrical face: cutting a projected
   * sketch with it gives the same depth everywhere on the face (text on a cap, a groove round a shaft).
   */
  private band(body: Shape3D, origins: string[], sel: FaceSelector, depth: number, mode: "add" | "cut"): { shape: Shape3D; what: string; axis?: { p: V3; d: V3 } } {
    if (!(depth > 0)) throw new InputError("深度（distance）必须大于 0")
    const faces = faceInfos(body, origins)
    try {
      const got = selectFaces(sel, faces, this.scope)
      if (got.length !== 1) throw new InputError(`onto 要正好选中一个面，现在选中了 ${got.length} 个`)
      const f = got[0]
      const big = 2 * this.bigLength(body)
      if (f.kind === "plane" && f.normal) {
        // Outward normal: a cut goes in against it, an addition out along it.
        const dir = mode === "cut" ? mul(f.normal, -1) : f.normal
        const x: V3 = Math.abs(f.normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
        const xd = cross(f.normal, x)
        const pl = new Plane(f.center, xd, dir)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { shape: (drawRectangle(2 * big, 2 * big).sketchOnPlane(pl) as any).extrude(depth) as Shape3D, what: "平面" }
        } finally {
          pl.delete()
        }
      }
      if (f.kind === "cylinder" && f.radius !== undefined) {
        const ax = cylinderAxis(f)
        if (!ax) throw new InputError("读不出这个圆柱面的轴线")
        // Convex (a shaft, a cap) or concave (a bore): which way is into the material.
        const convex = isConvexCylinder(f, ax)
        const r = f.radius
        const [inner, outer] = (mode === "cut") === convex ? [r - depth, r] : [r, r + depth]
        if (inner <= 1e-6) throw new InputError(`深度 ${fmt(depth)} 超过了圆柱面的半径 R${fmt(r)}`)
        const base = add(ax.p, mul(ax.d, -big))
        const cyl = (rad: number) => makeCylinder(rad, 2 * big, base, ax.d) as unknown as Shape3D
        const o = cyl(outer)
        const i = cyl(inner)
        const shape = o.cut(i)
        o.delete()
        i.delete()
        return { shape, what: `圆柱面（R${fmt(r)}）`, axis: { p: ax.p, d: ax.d } }
      }
      throw new InputError("onto 只支持平面和圆柱面")
    } finally {
      disposeInfos(faces)
    }
  }

  /**
   * Material added under a part name that doesn't exist yet: the tool body alone becomes a new part,
   * not merged with anything. The body that was there becomes a part too (its first name, or 「主体」).
   */
  private newPart(f: Feature, prev: Step, warnings: string[]): ApplyOut {
    const name = f.part!
    if ("until" in f && f.until) throw new InputError(`新建零件「${name}」时不能用 until：新零件不和别的料合并，没有「碰到为止」。写 distance`)
    const alone: Step = { ...prev, body: null, origins: [], parts: undefined, partOrigins: undefined }
    const w: string[] = []
    const out = this.apply(f, alone, w)
    warnings.push(...w.filter((x) => !/不相连的实体/.test(x)))
    if (!out.body) throw new InputError("这一步没有生成实体")
    const before: Part[] =
      prev.parts && prev.parts.length > 1
        ? prev.parts.map((p) => ({ ...p, owned: false }))
        : [{ name: prev.mainName ?? "主体", body: prev.body!, explode: [0, 0, 0], owned: false, auto: true }]
    for (const p of before) {
      const r = relation(out.body, p.body, true)
      if (r.overlap > 1e-6) warnings.push(`新零件「${name}」和「${p.name}」重叠 ${fmt(r.overlap)} mm³`)
    }
    const parts: Part[] = [...before, { name, body: out.body, explode: [0, 0, 0], owned: true, auto: true }]
    const named = prev.parts && prev.parts.length > 1 ? "" : prev.mainName ? "" : "；原来的实体叫作「主体」"
    return { ...out, body: compoundOf(parts.map((p) => p.body)), parts, summary: `${out.summary} · 新零件「${name}」${named}` }
  }

  /**
   * A body feature after a split, run on the parts: `part` picks one; else a
   * cut changes every part it reaches, an addition must join exactly one part,
   * and shell / draft / whole-body mirror must say which part.
   */
  private onParts(f: Feature, prev: Step, parts: Part[], warnings: string[]): ApplyOut {
    const names = parts.map((p) => p.name).join("、")
    const named = f.part ? parts.filter((p) => p.name === f.part) : parts
    if (f.part && !named.length) throw new InputError(`没有叫「${f.part}」的零件：现在有 ${names}`)
    if (!f.part && (f.op === "shell" || f.op === "draft" || (f.op === "mirror" && !f.features?.length)))
      throw new InputError(`拆件之后${OP_NAMES[f.op]}要写 part，指定作用在哪个零件上（${names}）`)
    const runs: { p: Part; out: ApplyOut; w: string[] }[] = []
    let firstError: unknown = null
    for (const p of named) {
      const k = parts.indexOf(p)
      const own: Step = { ...prev, body: p.body, origins: prev.partOrigins?.[k] ?? [], parts: undefined }
      const w: string[] = []
      try {
        runs.push({ p, out: this.apply(f, own, w), w })
      } catch (e) {
        firstError ??= e
      }
    }
    if (!runs.length) throw firstError
    const vol = (x: Shape3D) => measureShapeVolumeProperties(x).volume
    const changed = runs.filter((r) => r.out.body && Math.abs(vol(r.out.body) - vol(r.p.body)) > 1e-6 * Math.max(1, vol(r.p.body)))
    const adds = f.op === "rib" || (f.op === "import" && f.mode === "add") || runs.some((r) => r.out.tools?.some((t) => t.mode === "add"))
    let used = changed
    if (adds && !f.part) {
      used = changed.filter((r) => countOf(r.out.body!, "solid") === countOf(r.p.body, "solid"))
      if (used.length !== 1) {
        for (const r of runs) if (r.out.body && r.out.body !== r.p.body) r.out.body.delete()
        throw new InputError(used.length ? `加的料碰到了 ${used.map((r) => r.p.name).join("、")}：写 part 指定加在哪个零件上` : `加的料没有接上任何零件：写 part 指定加在哪个零件上（${names}）`)
      }
    }
    if (!used.length) warnings.push("这一步没有改到任何零件")
    for (const r of used) warnings.push(...r.w.filter((w) => !/没有碰到实体|不相连的实体/.test(w)))
    // Outputs not used, and the tools of all but the first run, are freed.
    for (const r of runs) if (!used.includes(r) && r.out.body && r.out.body !== r.p.body) r.out.body.delete()
    runs.slice(1).forEach((r) => r.out.tools?.forEach((t) => t.tool.delete()))
    const next: Part[] = parts.map((p) => {
      const r = used.find((x) => x.p === p)
      return r ? { ...p, body: r.out.body!, owned: true } : { ...p, owned: false }
    })
    const body = compoundOf(next.map((p) => p.body))
    const first = (used[0] ?? runs[0]).out
    return { ...first, body, parts: next, summary: `${first.summary} · ${used.length ? used.map((r) => r.p.name).join("、") : "没有改到零件"}` }
  }

  private copyTools(body: Shape3D, sources: Tool[], moves: ((s: Shape3D) => Shape3D)[], summary: string, warnings: string[]) {
    // A pattern of a pattern (or of a many-hole feature) multiplies: count the bodies this step makes.
    const made = sources.reduce((n, s) => n + countOf(s.tool, "solid"), 0) * moves.length
    if (made > MAX_COUNT) throw new InputError(`这一步要复制出 ${made} 个实体，最多 ${MAX_COUNT} 个`)
    if (sources.some((s) => s.mode === "intersect")) throw new InputError("求交的特征不能阵列或镜像")
    let cur = body
    const tools: Tool[] = []
    for (const { tool, mode } of sources) {
      const copies = moves.map((m) => m(tool.clone()))
      const comp = makeCompound(copies) as unknown as Shape3D
      const next = applyTool(cur, comp, mode, warnings)
      if (cur !== body) cur.delete()
      cur = next
      tools.push({ tool: comp, mode })
    }
    return { body: cur, tools, summary }
  }
}

/** Does the cylinder face bulge outwards (a shaft) rather than inwards (a bore)? Its outward normal points away from the axis. */
function isConvexCylinder(f: FaceInfo, ax: { p: V3; d: V3 }): boolean {
  const pt = f.face.pointOnSurface(0.5, 0.5)
  const nrm = f.face.normalAt(pt)
  try {
    const p: V3 = [pt.x, pt.y, pt.z]
    const k = dot(sub(p, ax.p), ax.d)
    const radial = sub(p, add(ax.p, mul(ax.d, k)))
    return dot([nrm.x, nrm.y, nrm.z], radial) > 0
  } finally {
    pt.delete()
    nrm.delete()
  }
}

/** What a component's built shape depends on: its tree, the bytes it reads, its own components. */
function componentKey(c: ComponentSource): string {
  if (c.error) return `error:${c.error}`
  if (c.bytes !== undefined) return `step:${c.bytes ? contentHash(c.bytes) : "missing"}`
  return JSON.stringify([c.tree, (c.assets ?? []).map((a) => [a.name, a.bytes ? contentHash(a.bytes) : a.error]), (c.components ?? []).map(componentKey)])
}

/** Build a component (a part file in a kernel of its own, or a STEP file), or take it from the cache. */
function buildComponent(src: ComponentSource): Built {
  const key = componentKey(src)
  const hit = BUILT.get(key)
  if (hit) {
    BUILT.delete(key)
    BUILT.set(key, hit)
    return hit
  }
  if (src.error) throw new InputError(src.error)
  let built: Built
  if (src.bytes !== undefined) {
    if (!src.bytes) throw new InputError(`读不到「${src.file}」`)
    const shape = readStep(src.bytes) as Shape3D
    built = { parts: [{ name: null, shape }], failed: 0 }
  } else {
    const sub = new Kernel()
    try {
      sub.setAssets(src.assets ?? [])
      sub.setComponents(src.components ?? [])
      const rep = sub.rebuild(src.tree ?? EMPTY_TREE)
      const last = sub.lastBuilt(Infinity)
      if (!last?.body) {
        const err = rep.paramError ?? rep.features.find((x) => x.state === "error")?.message
        throw new InputError(`「${src.file}」一步都没有建成${err ? `：${err}` : ""}`)
      }
      const failed = rep.features.filter((x) => x.state === "error").length
      const parts = last.parts && last.parts.length > 1 ? last.parts.map((p) => ({ name: p.name, shape: p.body.clone() })) : [{ name: null, shape: last.body.clone() }]
      built = { parts, failed }
    } finally {
      sub.dispose()
    }
  }
  BUILT.set(key, built)
  for (const [k, b] of BUILT) {
    if (BUILT.size <= MAX_BUILT) break
    b.parts.forEach((p) => p.shape.delete())
    BUILT.delete(k)
  }
  return built
}

/** Rotate (in order, about the origin) then move: a component's place in its assembly. */
function place<T extends AnyShape>(shape: T, p: Placement): T {
  let s = shape as AnyShape
  for (const r of p.rotate) s = s.rotate(r.angle, [0, 0, 0], AXIS[r.axis])
  if (p.at.some((x) => x !== 0)) s = s.translate(p.at)
  return s as T
}

/** The inverse of `place`: from the assembly back into the part's own frame. */
function unplace<T extends AnyShape>(shape: T, p: Placement): T {
  let s = shape as AnyShape
  if (p.at.some((x) => x !== 0)) s = s.translate(mul(p.at, -1))
  for (const r of [...p.rotate].reverse()) s = s.rotate(-r.angle, [0, 0, 0], AXIS[r.axis])
  return s as T
}

/**
 * Where parts that weren't cut apart move at full explode: the biggest of them stays, the others move
 * away from its middle by 0.6 of the whole's size along that direction (at least 15 mm), as the
 * upper part of a split moves off along the cut while the lower one stays.
 */
function autoExplode(parts: Part[]): V3[] {
  const boxes = parts.map((p) => p.body.boundingBox.bounds as [V3, V3])
  const lo: V3 = [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b[0][a]))) as V3
  const hi: V3 = [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b[1][a]))) as V3
  const size = sub(hi, lo)
  const autos = parts.flatMap((p, k) => (p.auto ? [k] : []))
  if (!autos.length) return parts.map(() => [0, 0, 0])
  const vol = (k: number) => measureShapeVolumeProperties(parts[k].body).volume
  const anchor = autos.reduce((a, b) => (vol(b) > vol(a) ? b : a))
  const centre = (k: number) => mul(add(boxes[k][0], boxes[k][1]), 0.5)
  return parts.map((p, k) => {
    if (!p.auto || k === anchor) return [0, 0, 0]
    let d = sub(centre(k), centre(anchor))
    let l = Math.hypot(...d)
    if (l < 1e-6) {
      d = [0, 0, 1]
      l = 1
    }
    const u = mul(d, 1 / l)
    const across = Math.abs(dot(size, u.map(Math.abs) as V3))
    return mul(u, Math.max(15, 0.6 * across))
  })
}

/** Features that add material through a tool body (so can start a part). */
function addsMaterial(f: Feature) {
  if (f.op === "extrude" || f.op === "revolve" || f.op === "sweep" || f.op === "loft") return (f.mode ?? "add") === "add"
  return f.op === "import" && f.mode === "add"
}

/** Does `f` add material under a part name the model doesn't have yet (with a body already there)? */
function startsPart(f: Feature, prev: Step | null) {
  if (!f.part || !addsMaterial(f) || !prev?.body) return false
  if (prev.parts && prev.parts.length > 1) return !prev.parts.some((p) => p.name === f.part)
  return f.part !== (prev.mainName ?? "主体")
}

/** A pattern or mirror of features that all went to one part goes to that part too. */
function partOf(f: Feature, tree: Tree): string | undefined {
  if (f.part || !((f.op === "linear_pattern" || f.op === "circular_pattern" || f.op === "mirror") && f.features?.length)) return f.part
  const parts = new Set(f.features.map((id) => tree.features.find((x) => x.id === id)?.part))
  const [only] = parts
  return parts.size === 1 && only ? only : undefined
}

/** A sketch's closed regions, for features that need an area. */
function regionOf(sk: NonNullable<Step["sketch"]>, id: string): Drawing {
  if (!sk.drawing) throw new InputError(`草图「${id}」只有开放的线：开放的线只能做薄壁拉伸（thin）或筋（rib）`)
  return sk.drawing
}

/**
 * The sketch frame of an inclined plane face, the one rule `on.face` and
 * annotations share: origin at the face's centre, x level (Z × n; X when the
 * face is nearly flat, made square to n), y = n × x, up the slope.
 */
function faceFrame(center: V3, n: V3): Frame {
  const normal = unit(n)
  const x = Math.abs(normal[2]) < 0.999 ? unit(cross([0, 0, 1], normal)) : unit(sub([1, 0, 0], mul(normal, normal[0])))
  return { origin: center, x, y: cross(normal, x), normal }
}

/** A click on an inclined face, in that face's own sketch coordinates. */
function slopeSketch(center: V3, n: V3, p: V3): PickInfo["sketch"] {
  const fr = faceFrame(center, n)
  const d = sub(p, fr.origin)
  const r = (v: V3) => v.map(r2) as V3
  return { plane: "XY", offset: 0, uv: [r2(dot(d, fr.x)), r2(dot(d, fr.y))], face: { origin: r(fr.origin), x: r(fr.x), y: r(fr.y), normal: r(fr.normal) } }
}

type ApplyOut = { body?: Shape3D; ref?: AnyShape; summary: string; selected?: number; sketch?: Step["sketch"]; tools?: Tool[]; threads?: Thread[]; geom?: StepGeom; parts?: Part[] }

const frameOf = (p: ResolvedPlane): Frame => ({ origin: p.origin, x: p.x, y: p.y, normal: p.normal })

/** Away from the part at an edge: the mean of its two faces' normals there. */
function outward(e: EdgeInfo, faces: FaceInfo[]): V3 {
  let sum: V3 = [0, 0, 0]
  for (const i of e.faces) {
    const n = faces[i].face.normalAt(e.mid)
    sum = add(sum, [n.x, n.y, n.z])
    n.delete?.()
  }
  return unit(Math.hypot(...sum) > 1e-9 ? sum : [0, 0, 1])
}

/** The wall thickness at the opening: from the middle of its longest edge, inwards. */
function shellGeom(open: FaceInfo): StepGeom | undefined {
  const edges = edgesOf(open.face)
  try {
    const longest = edges.reduce((a, b) => (b.length > a.length ? b : a))
    const p = longest.pointAt(0.5)
    const mid: V3 = [p.x, p.y, p.z]
    p.delete?.()
    const n = open.normal ?? [0, 0, 1]
    const toward = sub(open.center, mid)
    const inward = unit(sub(toward, mul(n, dot(toward, n))))
    return { op: "shell", at: mid, inward, out: n }
  } catch {
    return undefined
  } finally {
    edges.forEach((e) => e.delete())
  }
}

/** Middle of the first tool a pattern copies. */
function centerOf(tools: Tool[]): V3 | null {
  if (!tools.length) return null
  const [a, b] = tools[0].tool.boundingBox.bounds as [V3, V3]
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

function applyTool(body: Shape3D | null, tool: Shape3D, mode: "add" | "cut" | "intersect", warnings: string[]): Shape3D {
  if (mode === "intersect") {
    if (!body) throw new InputError("还没有实体，不能求交")
    const next = body.intersect(tool)
    const v = measureShapeVolumeProperties(next).volume
    if (v < 1e-9) {
      next.delete()
      throw new InputError("求交后什么都没剩下：工具体和实体不重叠")
    }
    return next
  }
  if (mode === "cut") {
    if (!body) throw new InputError("还没有实体，不能切除")
    const before = measureShapeVolumeProperties(body).volume
    const next = body.cut(tool)
    const after = measureShapeVolumeProperties(next).volume
    if (Math.abs(before - after) < 1e-6 * Math.max(1, before)) warnings.push("切除没有碰到实体，模型没有变化")
    return next
  }
  // Booleans already unify same-domain faces; the first solid needs it too,
  // or an extruded circle keeps two half-cylinders and two half-arcs per rim.
  const solidsBefore = body ? countOf(body, "solid") : 0
  const next = body ? body.fuse(tool) : unified(tool)
  if (body) {
    const before = measureShapeVolumeProperties(body).volume
    const after = measureShapeVolumeProperties(next).volume
    if (Math.abs(after - before) < 1e-6 * Math.max(1, before)) warnings.push("加的料完全在原实体里面，模型没有变化")
  }
  const solids = countOf(next, "solid")
  if (body && solids > solidsBefore) {
    // Apart, or touching only along an edge or at a point (sharing a face would have merged them).
    const c = closest(tool, body)
    warnings.push(
      c && c.d > TOUCH
        ? `新加的料离已有实体 ${fmt(c.d)} mm，没接上：现在是 ${solids} 个不相连的实体`
        : `新加的料只碰到已有实体的边或点，没有共用的面：合并后还是 ${solids} 个不相连的实体`,
    )
  } else if (solids > 1) warnings.push(`现在是 ${solids} 个不相连的实体`)
  return next
}

/** Counts may be expressions; they must land on a whole number, and not one that would freeze the tab. */
function count(v: number, min: number, what: string): number {
  const r = Math.round(v)
  if (Math.abs(v - r) > 1e-6 || r < min) throw new InputError(`${what}要是不小于 ${min} 的整数，现在是 ${fmt(v)}`)
  if (r > MAX_COUNT) throw new InputError(`${what}最多 ${MAX_COUNT}，现在是 ${r}`)
  return r
}

function unified(tool: Shape3D): Shape3D {
  const copy = tool.clone()
  const out = copy.simplify()
  copy.delete()
  return out
}

function stats(body: Shape3D): BodyStats {
  const [a, b] = body.boundingBox.bounds as [V3, V3]
  const props = measureShapeVolumeProperties(body)
  const c = props.centerOfMass as unknown as V3
  const out: BodyStats = {
    bbox: [[r2(a[0]), r2(a[1]), r2(a[2])], [r2(b[0]), r2(b[1]), r2(b[2])]],
    size: [r2(b[0] - a[0]), r2(b[1] - a[1]), r2(b[2] - a[2])],
    volume: r2(props.volume),
    centerOfMass: [r2(c[0]), r2(c[1]), r2(c[2])],
    faces: countOf(body, "face"),
    edges: countOf(body, "edge"),
    solids: countOf(body, "solid"),
  }
  props.delete?.()
  return out
}

function shapeName(s: SketchShape) {
  const tag = "cut" in s && s.cut ? "（挖）" : ""
  switch (s.type) {
    case "rect":
      return `矩形 ${s.w}×${s.h}${tag}`
    case "circle":
      return `圆 ⌀${s.d}${tag}`
    case "polygon":
      return `正${s.sides}边形${tag}`
    case "slot":
      return `长圆孔 ${s.length}×${s.width}${tag}`
    case "polyline":
      return `轮廓 ${s.points.length} 点${tag}`
    case "path":
      return `开放的线 ${s.points.length} 点`
    case "text":
      return `文字「${s.text.replace(/\n/g, " ")}」${tag}`
  }
}

type V2 = [number, number]
/** Sketch points with numbers worked out: a corner (rounded by r), an arc through `via`, or a spline ending at `to`. */
function evalPoints(points: Point[], n: (v: number | string) => number): { to: V2; via?: V2; r?: number; spline?: V2[] }[] {
  const v2 = (p: (number | string)[]): V2 => [n(p[0]), n(p[1])]
  return points.map((p) => {
    if (Array.isArray(p)) return { to: v2(p) }
    if ("spline" in p) {
      const sp = p.spline.map(v2)
      return { to: sp[sp.length - 1], spline: sp }
    }
    if ("via" in p) return { to: v2(p.to), via: v2(p.via) }
    return { to: v2(p.to), r: n(p.r) }
  })
}

/** `mirrorText`: the sketch is seen from behind its datum plane, so text is mirrored to read right from outside. */
function sketchDrawing(shapes: SketchShape[], scope: Scope, mirrorText = false): { drawing: Drawing | null; paths: [number, number][][] } {
  const n = (v: number | string) => num(v, scope)
  let parts: Drawing[] = []
  const paths: [number, number][][] = []
  for (const s of shapes) {
    if (s.type === "path") {
      paths.push(pathPoints(evalPoints(s.points, n)))
      continue
    }
    const c = s.type !== "polyline" && s.center ? [n(s.center[0]), n(s.center[1])] : [0, 0]
    let d: Drawing
    switch (s.type) {
      case "rect": {
        const w = n(s.w)
        const h = n(s.h)
        const r = s.r !== undefined ? n(s.r) : 0
        if (!(w > 0 && h > 0)) throw new InputError("矩形的宽和高必须大于 0")
        if (r < 0 || r >= Math.min(w, h) / 2) throw new InputError("矩形圆角半径要小于短边的一半")
        d = drawRoundedRectangle(w, h, r).translate(c[0], c[1])
        break
      }
      case "circle": {
        const dd = n(s.d)
        if (!(dd > 0)) throw new InputError("圆的直径必须大于 0")
        d = drawCircle(dd / 2).translate(c[0], c[1])
        break
      }
      case "polygon": {
        const dd = n(s.d)
        if (!(dd > 0)) throw new InputError("多边形的外接圆直径必须大于 0")
        d = drawPolysides(dd / 2, count(n(s.sides), 3, "边数"))
        if (s.rotate !== undefined) d = d.rotate(n(s.rotate), [0, 0])
        d = d.translate(c[0], c[1])
        break
      }
      case "slot": {
        const L = n(s.length)
        const W = n(s.width)
        if (!(W > 0 && L > W)) throw new InputError("长圆孔的总长必须大于宽")
        const a = (L - W) / 2
        d = draw([-a, -W / 2])
          .lineTo([a, -W / 2])
          .threePointsArcTo([a, W / 2], [a + W / 2, 0])
          .lineTo([-a, W / 2])
          .threePointsArcTo([-a, -W / 2], [-a - W / 2, 0])
          .close()
        if (s.angle !== undefined) d = d.rotate(n(s.angle), [0, 0])
        d = d.translate(c[0], c[1])
        break
      }
      case "text": {
        const size = n(s.size)
        if (!(size > 0)) throw new InputError("字号必须大于 0")
        d = textDrawing(normalizeText(s.text), size)
        if (s.angle !== undefined) d = d.rotate(n(s.angle), [0, 0])
        if (mirrorText) d = d.mirror([0, 1], [0, 0], "plane")
        d = d.translate(c[0], c[1])
        break
      }
      case "polyline": {
        const pts = evalPoints(s.points, n)
        const first = pts[0].to
        const last = pts[pts.length - 1]
        if (!last.via && !last.spline && Math.hypot(last.to[0] - first[0], last.to[1] - first[1]) < 1e-9) pts.pop()
        if (pts.length < 3 && !pts.some((p) => p.via || p.spline)) throw new InputError("轮廓至少要 3 个点才能围成面")
        let pen = draw(first)
        for (const p of pts.slice(1)) {
          if (p.via) pen = pen.threePointsArcTo(p.to, p.via)
          else if (p.spline) for (const q of p.spline) pen = pen.smoothSplineTo(q)
          else pen = pen.lineTo(p.to)
          if (p.r !== undefined) {
            if (!(p.r > 0)) throw new InputError("拐角圆角半径必须大于 0")
            pen = pen.customCorner(p.r)
          }
        }
        try {
          d = pen.close()
        } catch {
          throw new InputError("轮廓画不出来：拐角圆角太大（大于相邻的边），或者样条自己交叉了")
        }
        break
      }
    }
    // 2D booleans only between shapes that overlap: separate shapes (a circle beside a
    // text) stay separate regions. replicad's 2D boolean can fail on glyph outlines.
    const hit = parts.filter((p) => overlaps(p.boundingBox.bounds, d.boundingBox.bounds))
    if (s.cut) {
      if (!parts.length) throw new InputError("「挖掉」的图形前面要先有图形")
      for (const p of hit) parts[parts.indexOf(p)] = p.cut(d)
    } else {
      const merged = hit.reduce((acc, p) => acc.fuse(p), d)
      parts = [...parts.filter((p) => !hit.includes(p)), merged]
    }
  }
  if (!parts.length) return { drawing: null, paths }
  if (parts.length === 1) return { drawing: parts[0], paths }
  // Drawing keeps its shape private; disjoint regions are just listed together.
  const inner = (x: Drawing) => (x as unknown as { innerShape: Blueprint | Blueprints | CompoundBlueprint | null }).innerShape
  return { drawing: new Drawing(new Blueprints(parts.flatMap((p) => { const i = inner(p); return !i ? [] : i instanceof Blueprints ? i.blueprints : [i] }))), paths }
}

const overlaps = (a: [number[], number[]], b: [number[], number[]]) => a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1]

/**
 * A sketch may hold regions that overlap (a text's strokes): its extrusion is
 * then several solids crossing each other, which a boolean can't take as a
 * tool. Fuse them; separate ones come out as separate solids of the compound.
 */
export function mergeOverlaps(shape: Shape3D): Shape3D {
  const solids = solidsOf(shape)
  const boxes = solids.map((s) => s.boundingBox.bounds as [V3, V3])
  const meet = (a: [V3, V3], b: [V3, V3]) => [0, 1, 2].every((k) => a[0][k] <= b[1][k] + 1e-9 && b[0][k] <= a[1][k] + 1e-9)
  const crossing = boxes.some((a, i) => boxes.some((b, j) => j > i && meet(a, b)))
  if (!crossing) {
    solids.forEach((s) => s.delete())
    return shape
  }
  // One fuse with every other solid as a tool: five hanzi take 0.27 s instead of
  // 1.4 s fused pair by pair, and the wasm heap grows a quarter as much. No
  // same-domain clean-up: on these polyline walls it loses whole strokes (偶 kept
  // a quarter of its area). The body's own boolean cleans up afterwards.
  const oc = getOC() as unknown as OCFuse
  const args = new oc.NCollection_List_TopoDS_Shape()
  const tools = new oc.NCollection_List_TopoDS_Shape()
  const progress = new oc.Message_ProgressRange()
  const fuse = new oc.BRepAlgoAPI_Fuse()
  try {
    args.Append(solids[0].wrapped)
    for (const s of solids.slice(1)) tools.Append(s.wrapped)
    fuse.SetArguments(args)
    fuse.SetTools(tools)
    fuse.Build(progress)
    if (!fuse.IsDone()) throw new Error("重叠的笔画没能合并")
    return cast(fuse.Shape() as never) as Shape3D
  } finally {
    for (const x of [fuse, progress, args, tools, ...solids, shape]) x.delete()
  }
}

type OCList = { Append(s: unknown): unknown; delete(): void }
type OCFuse = {
  NCollection_List_TopoDS_Shape: new () => OCList
  Message_ProgressRange: new () => { delete(): void }
  BRepAlgoAPI_Fuse: new () => { SetArguments(l: OCList): void; SetTools(l: OCList): void; Build(p: unknown): void; IsDone(): boolean; Shape(): unknown; delete(): void }
}

/** A hole as a revolved half-section pointing down -Z from the origin. */
function holeTool(r: number, depth: number, cbore?: { r: number; depth: number }, csink?: { r: number; angle: number }): Shape3D {
  if (!(depth > 0)) throw new InputError("孔深必须大于 0")
  const pts: [number, number][] = [[0, 0]]
  if (cbore) {
    if (!(cbore.r > r && cbore.depth > 0 && cbore.depth < depth)) throw new InputError("沉孔直径要大于孔径，沉孔深度要小于孔深")
    pts.push([cbore.r, 0], [cbore.r, -cbore.depth], [r, -cbore.depth])
  } else if (csink) {
    if (!(csink.r > r)) throw new InputError("埋头孔直径要大于孔径")
    const h = (csink.r - r) / Math.tan(((csink.angle / 2) * Math.PI) / 180)
    if (!(h < depth)) throw new InputError("埋头锥比孔还深")
    pts.push([csink.r, 0], [r, -h])
  } else pts.push([r, 0])
  pts.push([r, -depth], [0, -depth])
  let pen = draw(pts[0])
  for (const p of pts.slice(1)) pen = pen.lineTo(p)
  return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1], { origin: [0, 0, 0] }) as Shape3D
}

/** Turn a tool built along -Z at the origin to point along `dir`, then move it to `at`. */
function orient(shape: Shape3D, dir: V3, at: V3): Shape3D {
  const from: V3 = [0, 0, -1]
  const c = cross(from, dir)
  const s = Math.hypot(...c)
  const cosA = dot(from, dir)
  let out = shape
  if (s < 1e-9) {
    if (cosA < 0) out = out.rotate(180, [0, 0, 0], [1, 0, 0])
  } else out = out.rotate((Math.atan2(s, cosA) * 180) / Math.PI, [0, 0, 0], mul(c, 1 / s))
  return out.translate(at)
}

function sizeOf(shape: AnyShape): V3 {
  const [a, b] = shape.boundingBox.bounds as [V3, V3]
  return [r2(b[0] - a[0]), r2(b[1] - a[1]), r2(b[2] - a[2])]
}

/** FNV-1a over the bytes, and their length: tells one version of a file from another. */
function contentHash(bytes: Uint8Array) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return `${bytes.length}:${(h >>> 0).toString(16)}`
}

/** A STEP file as a shape, read synchronously through the wasm file system (replicad's importSTEP is async). */
function readStep(bytes: Uint8Array): AnyShape {
  const oc = getOC()
  const name = `/arbor-import-${Math.random().toString(36).slice(2)}.step`
  oc.FS.writeFile(name, bytes)
  const reader = new oc.STEPControl_Reader()
  try {
    if (!reader.ReadFile(name)) throw new InputError("不是能读的 STEP 文件")
    reader.TransferRoots()
    const raw = reader.OneShape()
    if (raw.IsNull()) {
      raw.delete()
      throw new InputError("STEP 文件里没有形体")
    }
    return cast(raw)
  } finally {
    reader.delete()
    oc.FS.unlink(name)
  }
}
