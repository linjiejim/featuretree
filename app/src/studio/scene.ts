import * as THREE from "three"
import { LineSegments2 } from "three/addons/lines/LineSegments2.js"
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js"
import type { MaterialKit } from "@/three/materials"
import type { DisplayData } from "./kernel/build"

/**
 * How faces are coloured: by this step's status, by provenance (`highlight` =
 * feature ids), or, when `faces` is given, only those faces (by mesh hash).
 */
export type Paint = { status: boolean; highlight?: string | string[]; faces?: number[] }

/** Features lit up from outside the viewport (a tree row, a parameter), and what the legend calls them. */
export type Hover = {
  ids: string[]
  label: string
  /** Pointing at a parameter: its dimensions on the model, joined to `row` by a line. */
  param?: string
  row?: HTMLElement
  /** Pointing at a feature row: that step's dimensions. */
  feature?: string
  /** Pointing at one dimension (a row of the feature card). */
  dim?: string
  /** Pointing at a requirement: the faces and edges it measures. */
  faces?: number[]
  edges?: number[]
}

/**
 * The live model as three.js objects: one mesh with a group per B-rep face
 * (painted by this step's new / modified status, or by provenance when a
 * feature is highlighted), its edges, and the sketch outline if any.
 */
export function modelObject(d: DisplayData, kit: MaterialKit, paint: Paint, view: PartsView = NO_PARTS_VIEW): THREE.Group {
  const root = new THREE.Group()
  root.name = "studio-model"
  const materials = [kit.model, kit.highlight, kit.modified, kit.ghost, kit.modelDark]
  // Parts pulled apart or hidden: one mesh (and edge set) per part, moved along its explode vector.
  if (d.parts && (view.explode > 0 || view.hidden.size || d.parts.some((p) => p.hidden))) {
    d.parts.forEach((part, k) => {
      if (view.hidden.has(k) || part.hidden || !d.mesh) return
      const groups = d.groups.filter((g) => g.part === k)
      const index: number[] = []
      const own = groups.map((g) => {
        const start = index.length
        for (let i = g.start; i < g.start + g.count; i++) index.push(d.mesh!.triangles[i])
        return { ...g, start }
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.BufferAttribute(d.mesh.vertices, 3))
      geo.setAttribute("normal", new THREE.BufferAttribute(d.mesh.normals, 3))
      geo.setIndex(index)
      for (const g of own) geo.addGroup(g.start, g.count, materialIndex(g, paint))
      const mesh = new THREE.Mesh(geo, materials)
      mesh.userData.groups = own
      mesh.userData.part = k
      const at = new THREE.Vector3(...part.explode).multiplyScalar(view.explode)
      mesh.position.copy(at)
      root.add(mesh)
      if (d.edges) {
        const pts: number[] = []
        for (const g of d.edgeGroups) if (g.part === k) for (let i = g.start * 3; i < (g.start + g.count) * 3; i++) pts.push(d.edges[i])
        const eg = new THREE.BufferGeometry()
        eg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3))
        const lines = new THREE.LineSegments(eg, kit.edge)
        lines.position.copy(at)
        root.add(lines)
      }
    })
    addRefs(root, d, kit)
    root.userData.partsMode = true
    return root
  }
  if (d.mesh) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(d.mesh.vertices, 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(d.mesh.normals, 3))
    geo.setIndex(new THREE.BufferAttribute(d.mesh.triangles, 1))
    for (const g of d.groups) geo.addGroup(g.start, g.count, materialIndex(g, paint))
    const mesh = new THREE.Mesh(geo, materials)
    mesh.userData.groups = d.groups
    root.add(mesh)
  }
  if (d.edges?.length) {
    const eg = new THREE.BufferGeometry()
    eg.setAttribute("position", new THREE.BufferAttribute(d.edges, 3))
    root.add(new THREE.LineSegments(eg, kit.edge))
  }
  if (d.threads?.length) {
    // Cosmetic threads: dashed rings at the nominal diameter, as on a drawing.
    const pts: number[] = []
    for (const t of d.threads) {
      const axis = new THREE.Vector3(...t.axis).normalize()
      const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize()
      const v = new THREE.Vector3().crossVectors(axis, u)
      const c = new THREE.Vector3(...t.center)
      const at = (k: number) => {
        const a = (k / 48) * Math.PI * 2
        return c.clone().addScaledVector(u, Math.cos(a) * t.r).addScaledVector(v, Math.sin(a) * t.r)
      }
      for (let k = 0; k < 48; k++) pts.push(...at(k).toArray(), ...at(k + 1).toArray())
    }
    const tg = new LineSegmentsGeometry()
    tg.setPositions(pts)
    const rings = new LineSegments2(tg, kit.construction)
    rings.computeLineDistances()
    rings.name = "threads"
    root.add(rings)
  }
  if (d.sketch?.length) {
    const sg = new LineSegmentsGeometry()
    sg.setPositions(d.sketch)
    const lines = new LineSegments2(sg, kit.sketch)
    lines.renderOrder = 3
    root.add(lines)
  }
  addRefs(root, d, kit)
  return root
}

/** Reference bodies (`import`, desktop app): see-through, faint edges, not pickable, never painted. */
function addRefs(root: THREE.Group, d: DisplayData, kit: MaterialKit) {
  for (const r of d.refs ?? []) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(r.mesh.vertices, 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(r.mesh.normals, 3))
    geo.setIndex(new THREE.BufferAttribute(r.mesh.triangles, 1))
    const mesh = new THREE.Mesh(geo, kit.glass)
    mesh.userData.reference = r.id
    mesh.renderOrder = 2
    root.add(mesh)
    if (r.edges?.length) {
      const eg = new THREE.BufferGeometry()
      eg.setAttribute("position", new THREE.BufferAttribute(r.edges, 3))
      root.add(new THREE.LineSegments(eg, kit.edgeGhost))
    }
  }
}

function materialIndex(g: DisplayData["groups"][number], paint: Paint) {
  // Parts alternate between the model grey and a darker one; new / modified colours go on top.
  const rest = g.part !== undefined && g.part % 2 === 1 ? 4 : 0
  if (paint.faces) return paint.faces.includes(g.hash) ? 1 : rest
  if (paint.highlight) return (typeof paint.highlight === "string" ? g.origin === paint.highlight : paint.highlight.includes(g.origin)) ? 1 : rest
  if (!paint.status) return rest
  return g.status === "new" ? 1 : g.status === "modified" ? 2 : rest
}

/** How a split body is shown: parts pulled apart (0–1 of their explode vectors) and hidden ones. */
export type PartsView = { explode: number; hidden: Set<number> }
export const NO_PARTS_VIEW: PartsView = { explode: 0, hidden: new Set() }

/** Re-paint an existing model object without rebuilding geometry. */
export function repaint(root: THREE.Object3D, paint: Paint) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.userData.groups) return
    const groups = mesh.userData.groups as DisplayData["groups"]
    mesh.geometry.groups.forEach((gr, i) => (gr.materialIndex = materialIndex(groups[i], paint)))
  })
}

/** Thick lines over the given edges (by mesh hash), drawn on top of the model. */
export function edgeHighlight(d: DisplayData, hashes: number[], kit: MaterialKit): THREE.Object3D | null {
  if (!d.edges) return null
  const pts: number[] = []
  for (const g of d.edgeGroups) {
    if (!hashes.includes(g.hash)) continue
    for (let i = g.start * 3; i < (g.start + g.count) * 3; i++) pts.push(d.edges[i])
  }
  if (!pts.length) return null
  const geo = new LineSegmentsGeometry()
  geo.setPositions(pts)
  // Its own material: thicker, in the highlight colour, and never hidden by the faces it borders.
  const mat = kit.sketch.clone()
  mat.color.copy(kit.edgeHighlight.color)
  mat.linewidth = 4
  mat.depthTest = false
  mat.resolution.copy(kit.sketch.resolution)
  const lines = new LineSegments2(geo, mat)
  lines.renderOrder = 4
  return lines
}

/** The face group a raycast hit landed on. */
export function groupAt(hit: THREE.Intersection): DisplayData["groups"][number] | null {
  const groups = (hit.object as THREE.Mesh).userData.groups as DisplayData["groups"] | undefined
  if (!groups || hit.faceIndex === undefined || hit.faceIndex === null) return null
  const idx = hit.faceIndex * 3
  return groups.find((x) => idx >= x.start && idx < x.start + x.count) ?? null
}
