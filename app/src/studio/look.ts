import * as THREE from "three"
import { acquireSnapshotter, releaseSnapshotter } from "@/three/snapshot"
import { VIEW_DIRS, disposeObject, type ViewName } from "@/three/viewer"
import type { DisplayData } from "./kernel/build"
import { LOOK_PADDING, LOOK_SIZE, VIEW_LABEL, type LookSection, type LookShot } from "./look-plan"
import { modelObject } from "./scene"
import { sectionPlane } from "./section"

/** A numbered annotation pin at a point on the model. */
export type Pin = { n: number; point: [number, number, number] }

/** How to draw a set of shots: what to light up, pins, a cut, parts or reference bodies left out, picture size. */
export type ShotOptions = { highlight?: string; pins?: Pin[]; section?: LookSection; hide?: string[]; size?: "normal" | "large" }

/**
 * Render the current model from standard views as PNG data URLs, for the
 * model to look at (and for the learner to see what it saw). Fixed light
 * background so the pictures read the same in either site theme.
 */
export function renderViews(d: DisplayData, views: string[], highlight?: string, extra: { pins?: Pin[]; dir?: THREE.Vector3 } = {}): string[] {
  const shots: LookShot[] = views.map((v) => {
    const dir = v === "current" && extra.dir ? extra.dir : VIEW_DIRS[(v as ViewName) in VIEW_DIRS ? (v as ViewName) : "iso"]
    return { label: VIEW_LABEL[v] ?? v, dir: [dir.x, dir.y, dir.z] }
  })
  return renderShots(d, shots, { highlight, pins: extra.pins })
}

/** Render planned shots (look-plan.ts): each its own direction, framing and label. */
export function renderShots(d: DisplayData, shots: LookShot[], opts: ShotOptions = {}): string[] {
  if (!d.mesh && !d.refs?.length) return []
  const [W, H] = LOOK_SIZE[opts.size ?? "normal"]
  const hide = new Set(opts.hide ?? [])
  const shown: DisplayData = hide.size ? { ...d, refs: d.refs?.filter((r) => !hide.has(r.name) && !hide.has(r.id)) } : d
  const hiddenParts = new Set((d.parts ?? []).flatMap((p, k) => (hide.has(p.name) ? [k] : [])))
  const snap = acquireSnapshotter()
  snap.renderer.localClippingEnabled = true
  if (opts.section) snap.kit.setSection(sectionPlane({ ...opts.section, flip: false }))
  try {
    return shots.map((shot) => {
      const canvas = document.createElement("canvas")
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext("2d")!
      const obj = modelObject(shown, snap.kit, { status: false, highlight: opts.highlight }, { explode: 0, hidden: hiddenParts })
      const box = shot.box ? new THREE.Box3(new THREE.Vector3(...shot.box[0]), new THREE.Vector3(...shot.box[1])) : undefined
      snap.draw(ctx, obj, { w: W, h: H, dir: new THREE.Vector3(...shot.dir), box, padding: shot.padding ?? LOOK_PADDING })
      disposeObject(obj)
      ctx.globalCompositeOperation = "destination-over"
      ctx.fillStyle = "white" // design-allow: picture for the model, independent of the site theme
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = "source-over"
      ctx.fillStyle = "black" // design-allow: label on the model-facing picture
      ctx.font = "14px sans-serif"
      ctx.fillText(shot.label, 10, 22)
      for (const p of opts.pins ?? []) drawPin(ctx, p, snap.camera, W, H)
      return canvas.toDataURL("image/png")
    })
  } finally {
    if (opts.section) snap.kit.setSection(null)
    releaseSnapshotter()
  }
}

/** A numbered dot where the learner clicked, as seen by `camera`. */
function drawPin(ctx: CanvasRenderingContext2D, pin: Pin, camera: THREE.Camera, W: number, H: number) {
  const v = new THREE.Vector3(...pin.point).project(camera)
  if (v.z > 1) return
  const x = ((v.x + 1) / 2) * W
  const y = ((1 - v.y) / 2) * H
  ctx.beginPath()
  ctx.arc(x, y, 10, 0, Math.PI * 2)
  ctx.fillStyle = "#d9480f" // design-allow: pin colour on the model-facing picture
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = "white" // design-allow: pin outline on the model-facing picture
  ctx.stroke()
  ctx.fillStyle = "white" // design-allow: pin number on the model-facing picture
  ctx.font = "bold 13px sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(String(pin.n), x, y + 0.5)
  ctx.textAlign = "start"
  ctx.textBaseline = "alphabetic"
}
