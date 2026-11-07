// What `look` draws, worked out before any rendering (no three.js here, so the
// desktop engine can plan and the tests can check it): which pictures, from
// where, framing what, and how many millimetres one pixel is.
import type { DisplayData } from "./kernel/build"

type V3 = [number, number, number]
export type Box = [V3, V3]

/** One picture: a label, the direction the camera looks from, and the box it frames (absent: the whole model). */
export type LookShot = { label: string; dir: V3; box?: Box; padding?: number }

/** A cut: keep the side of the plane `sectionPlane` keeps (see section.ts). */
export type LookSection = { axis: "X" | "Y" | "Z"; at: number }

export const LOOK_SIZE = { normal: [448, 336], large: [896, 672] } as const
/** The snapshotter's vertical field of view and the default padding around the framed box. */
const VFOV = 26
export const LOOK_PADDING = 1.12
export const FOCUS_PADDING = 1.35
/** A last change smaller than this share of the model's diagonal gets a close-up of its own. */
export const AUTO_FOCUS_SHARE = 0.1

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

export const VIEW_DIR: Record<string, V3> = {
  iso: norm([1, -1.1, 0.85]),
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: norm([0, -1e-4, 1]),
  bottom: norm([0, -1e-4, -1]),
}

export const VIEW_LABEL: Record<string, string> = {
  iso: "等轴测",
  front: "前视（从 -Y 看）",
  back: "后视（从 +Y 看）",
  top: "上视（从 +Z 看）",
  bottom: "下视（从 -Z 看）",
  right: "右视（从 +X 看）",
  left: "左视（从 -X 看）",
  current: "学习者当前的视角",
}

/** Bounding box of the triangles of the face groups `keep` accepts (null: none). */
export function boxOfGroups(d: DisplayData, keep: (g: DisplayData["groups"][number]) => boolean): Box | null {
  if (!d.mesh) return null
  const v = d.mesh.vertices
  const t = d.mesh.triangles
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  let any = false
  for (const g of d.groups) {
    if (!keep(g)) continue
    for (let i = g.start; i < g.start + g.count; i++) {
      const k = t[i] * 3
      for (let a = 0; a < 3; a++) {
        const x = v[k + a]
        if (x < lo[a]) lo[a] = x
        if (x > hi[a]) hi[a] = x
      }
      any = true
    }
  }
  return any ? [lo, hi] : null
}

export const diagonal = (b: Box) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2])
export const sizeText = (b: Box) => b[1].map((x, i) => fmt(x - b[0][i])).join("×")
const fmt = (x: number) => String(Math.round(x * 10) / 10)

/** The whole model: the solid and the reference bodies' boxes (refs carry no box, so the mesh's own). */
export function modelBox(d: DisplayData): Box | null {
  return d.bbox ?? boxOfGroups(d, () => true)
}

/**
 * The faces the shown step created, when they are a small corner of the model. Only new faces:
 * a small hole or boss also modifies the big face it sits on, which would frame the whole part.
 */
export function autoFocus(d: DisplayData): Box | null {
  const whole = modelBox(d)
  const changed = boxOfGroups(d, (g) => g.status === "new")
  if (!whole || !changed) return null
  return diagonal(changed) < AUTO_FOCUS_SHARE * diagonal(whole) ? changed : null
}

/**
 * Millimetres per pixel at the centre of a picture `h` pixels high that frames `box` with `padding`
 * (the snapshotter fits the box's bounding sphere into the vertical field of view).
 */
export function mmPerPixel(box: Box, h: number, padding = LOOK_PADDING) {
  const r = diagonal(box) / 2 || 1
  const half = (VFOV / 2) * (Math.PI / 180)
  const dist = (r * padding) / Math.sin(half)
  return (2 * dist * Math.tan(half)) / h
}

export const scaleText = (mm: number) => (mm >= 0.1 ? fmt(mm) : String(Math.round(mm * 1000) / 1000))
