// The engine's handle on the kernel worker thread. The OpenCascade wasm heap
// only grows; past a threshold the thread is replaced and the last tree is
// rebuilt in the new one, which the engine never notices.
import { Worker } from "node:worker_threads"
import type { KernelHost } from "../../../app/src/desktop/core/engine"
import type { KernelPhase, V3 } from "../../../app/src/desktop/core/protocol"
import type { Tree } from "../../../app/src/studio/dsl"
import type { BuildReport, DisplayData, ComponentSource, ContextSource } from "../../../app/src/studio/kernel/build"
import type { Dim } from "../../../app/src/studio/kernel/dims"
import type { DrawingData } from "../../../app/src/studio/kernel/drawing"
import type { MeasureResult, MeasureSpec } from "../../../app/src/studio/kernel/measure"
import type { PickInfo } from "../../../app/src/studio/annotations"
import type { KernelReply, KernelRequest } from "./kernel-thread"

/** Same limit as the browser studio's worker. */
const RECYCLE_MB = 1400

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class ThreadKernel implements KernelHost {
  phase: KernelPhase = { phase: "loading" }
  private worker: Worker | null = null
  private started: Promise<void> | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private lastTree: Tree | null = null
  private stale = false

  constructor(
    private readonly file: URL,
    private readonly onPhase: () => void = () => {},
  ) {}

  /** Start the thread now (the app does this at launch so the first command is fast). */
  start() {
    this.started ??= this.spawn()
    return this.started
  }

  private spawn(): Promise<void> {
    // OpenCascade prints (STEP statistics, warnings) to stdout. Under `arbor mcp` stdout is the
    // protocol channel, so the thread gets its own streams and its chatter goes to stderr.
    const worker = new Worker(this.file, { stdout: true, stderr: true })
    worker.stdout.on("data", (b: Buffer) => process.stderr.write(b))
    worker.stderr.on("data", (b: Buffer) => process.stderr.write(b))
    this.worker = worker
    return new Promise<void>((resolve, reject) => {
      worker.on("message", (m: KernelReply) => {
        if ("type" in m) {
          if (m.type === "ready") {
            this.setPhase({ phase: "ready" })
            resolve()
          } else {
            this.setPhase({ phase: "error", message: m.error })
            reject(new Error(m.error))
          }
          return
        }
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.ok) {
          if (m.heapMB > RECYCLE_MB) this.stale = true
          p.resolve(m.result)
        } else p.reject(new Error(m.error))
      })
      const crashed = (why: string) => {
        if (this.worker !== worker) return
        this.worker = null
        this.started = null
        for (const p of this.pending.values()) p.reject(new Error(`建模内核意外退出（${why}），下一次调用会自动重启`))
        this.pending.clear()
        reject(new Error(why))
      }
      worker.on("error", (e) => crashed(e.message))
      worker.on("exit", (code) => crashed(`exit ${code}`))
    })
  }

  private setPhase(p: KernelPhase) {
    this.phase = p
    this.onPhase()
  }

  private async call<T>(op: KernelRequest["op"], args: unknown[]): Promise<T> {
    if (this.stale || !this.worker) await this.restart()
    else await this.start()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker!.postMessage({ id, op, args } satisfies KernelRequest)
    })
  }

  /** A fresh thread holding the same files and tree as the old one. */
  private async restart() {
    const old = this.worker
    this.stale = false
    this.worker = null
    this.started = null
    if (old) {
      old.removeAllListeners("exit")
      void old.terminate()
    }
    await this.start()
    const send = (op: KernelRequest["op"], args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++this.seq
        this.pending.set(id, { resolve, reject })
        this.worker!.postMessage({ id, op, args } satisfies KernelRequest)
      })
    if (this.assets.length) await send("setAssets", [this.assets])
    if (this.components.length) await send("setComponents", [this.components])
    if (this.context) await send("setContext", [this.context])
    if (this.lastTree) await send("rebuild", [this.lastTree])
  }

  /** The files `import` reads; kept here so a replacement thread gets them too. */
  private assets: { name: string; bytes: Uint8Array | null; error?: string }[] = []

  async setAssets(list: { name: string; bytes: Uint8Array | null; error?: string }[]) {
    this.assets = list
    await this.call<void>("setAssets", [list])
  }

  /** An assembly's components and the context of a part edited inside one; kept for a replacement thread too. */
  private components: ComponentSource[] = []
  private context: ContextSource | null = null

  async setComponents(list: ComponentSource[]) {
    this.components = list
    await this.call<void>("setComponents", [list])
  }

  async setContext(ctx: ContextSource | null) {
    this.context = ctx
    await this.call<void>("setContext", [ctx])
  }

  async rebuild(tree: Tree) {
    const r = await this.call<BuildReport>("rebuild", [tree])
    this.lastTree = tree
    return r
  }
  inspect(what: "body" | "faces" | "edges", selector?: unknown) {
    return this.call<string>("inspect", [what, selector])
  }
  display(index?: number) {
    return this.call<DisplayData>("display", [index])
  }
  pick(kind: "face" | "edge", hash: number, point: V3) {
    return this.call<PickInfo | null>("pick", [kind, hash, point])
  }
  locate(kind: "face" | "edge", selector: unknown, before?: number) {
    return this.call<number[] | null>("locate", [kind, selector, before])
  }
  selectorFor(kind: "face" | "edge", hashes: number[], before: number) {
    return this.call<{ selector: Record<string, unknown>; count: number } | null>("selectorFor", [kind, hashes, before])
  }
  faceEdges(hash: number, before: number) {
    return this.call<number[]>("faceEdges", [hash, before])
  }
  measure(targets: MeasureSpec[]) {
    return this.call<MeasureResult | null>("measure", [targets])
  }
  dimensions() {
    return this.call<Dim[]>("dimensions", [])
  }
  drawing(withIso: boolean) {
    return this.call<DrawingData | null>("drawing", [withIso])
  }
  exportBody(format: "step" | "stl", index?: number) {
    return this.call<Uint8Array | null>("exportBody", [format, index])
  }

  async dispose() {
    const w = this.worker
    this.worker = null
    if (w) {
      w.removeAllListeners("exit")
      await w.terminate()
    }
  }
}
