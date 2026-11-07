// The kernel called directly, in the same thread: for tests and for the
// kernel worker thread itself. The caller initialises OpenCascade first
// (initNodeKernel in Node).
import { getOC } from "replicad"
import type { Tree } from "../../studio/dsl"
import { Kernel, type ComponentSource, type ContextSource } from "../../studio/kernel/build"
import type { MeasureSpec } from "../../studio/kernel/measure"
import type { KernelHost } from "./engine"
import type { KernelPhase, V3 } from "./protocol"

/** Size of the OpenCascade wasm heap in MB. It only grows; the host replaces the kernel past a limit. */
export function wasmHeapMB() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any
  return (oc?.wasmMemory?.buffer?.byteLength ?? oc?.HEAPU8?.length ?? 0) / 1048576
}

export class DirectKernel implements KernelHost {
  readonly phase: KernelPhase = { phase: "ready" }
  private k = new Kernel()

  async rebuild(tree: Tree) {
    return this.k.rebuild(tree)
  }
  async inspect(what: "body" | "faces" | "edges", selector?: unknown) {
    return this.k.inspect(what, undefined, selector)
  }
  async display(index?: number) {
    return this.k.display(index)
  }
  async pick(kind: "face" | "edge", hash: number, point: V3) {
    return this.k.pick({ kind, hash, point })
  }
  async locate(kind: "face" | "edge", selector: unknown, before?: number) {
    return this.k.locate(kind, selector, before)
  }
  async selectorFor(kind: "face" | "edge", hashes: number[], before: number) {
    return this.k.selectorFor(kind, hashes, before)
  }
  async faceEdges(hash: number, before: number) {
    return this.k.faceEdges(hash, before)
  }
  async measure(targets: MeasureSpec[]) {
    return this.k.measure(targets)
  }
  async dimensions() {
    return this.k.dimensions()
  }
  async drawing(withIso: boolean) {
    return this.k.drawing(withIso)
  }
  async setAssets(list: { name: string; bytes: Uint8Array | null; error?: string }[]) {
    this.k.setAssets(list)
  }
  async setComponents(list: ComponentSource[]) {
    this.k.setComponents(list)
  }
  async setContext(ctx: ContextSource | null) {
    this.k.setContext(ctx)
  }
  async exportBody(format: "step" | "stl", index?: number) {
    const blob = await this.k.exportBody(format, index)
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  }
  dispose() {
    this.k.dispose()
  }
}
