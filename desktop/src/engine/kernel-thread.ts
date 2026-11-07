// The OpenCascade kernel in its own worker thread, so a long rebuild never
// blocks the engine, and the wasm heap (which only grows) can be thrown away
// by ending the thread.
import { parentPort } from "node:worker_threads"
import { DirectKernel, wasmHeapMB } from "../../../app/src/desktop/core/direct-kernel"
import { initNodeKernel } from "../../../app/src/studio/kernel/node"

export type KernelRequest = {
  id: number
  op: "setAssets" | "setComponents" | "setContext" | "rebuild" | "inspect" | "display" | "pick" | "locate" | "selectorFor" | "faceEdges" | "measure" | "dimensions" | "drawing" | "exportBody"
  args: unknown[]
}
export type KernelReply =
  | { id: number; ok: true; result: unknown; heapMB: number }
  | { id: number; ok: false; error: string }
  | { type: "ready" }
  | { type: "failed"; error: string }

const port = parentPort!
const post = (m: KernelReply, transfer: ArrayBuffer[] = []) => port.postMessage(m, transfer)

const ready = initNodeKernel().then(() => new DirectKernel())
ready.then(
  () => post({ type: "ready" }),
  (e) => post({ type: "failed", error: String((e as Error)?.message ?? e) }),
)

port.on("message", async (req: KernelRequest) => {
  try {
    const k = await ready
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (k as any)[req.op](...req.args)
    const transfer: ArrayBuffer[] = []
    if (req.op === "display" && result) {
      const d = result as { mesh: { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array } | null; edges: Float32Array | null; sketch: Float32Array | null }
      if (d.mesh) transfer.push(d.mesh.vertices.buffer as ArrayBuffer, d.mesh.normals.buffer as ArrayBuffer, d.mesh.triangles.buffer as ArrayBuffer)
      if (d.edges) transfer.push(d.edges.buffer as ArrayBuffer)
      if (d.sketch) transfer.push(d.sketch.buffer as ArrayBuffer)
    }
    if (req.op === "exportBody" && result) transfer.push((result as Uint8Array).buffer as ArrayBuffer)
    post({ id: req.id, ok: true, result, heapMB: wasmHeapMB() }, transfer)
  } catch (e) {
    post({ id: req.id, ok: false, error: String((e as Error)?.message ?? e) })
  }
})
