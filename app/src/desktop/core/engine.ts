// The Arbor engine: open parts (feature-tree files), one OpenCascade kernel,
// undo, the person's notes, and every command the agent or the window runs.
// Platform-neutral: the kernel, the file system and the window come in as
// ports, so the same engine runs in Electron's main process and in the CLI.
import type { PickInfo } from "../../studio/annotations"
import { executeTool, moveFeature, treeText, type KernelPort } from "../../studio/apply"
import { toBuild123d } from "../../studio/codegen"
import { EMPTY_TREE, Feature, Tree, displayName } from "../../studio/dsl"
import type { BuildReport, ComponentSource, ContextSource, DisplayData } from "../../studio/kernel/build"
import { num, num as evalNum } from "../../studio/expr"
import {
  FOCUS_PADDING,
  LOOK_PADDING,
  LOOK_SIZE,
  VIEW_DIR,
  VIEW_LABEL,
  autoFocus,
  boxOfGroups,
  mmPerPixel,
  modelBox,
  scaleText,
  sizeText,
  type Box,
  type LookSection,
  type LookShot,
} from "../../studio/look-plan"
import type { Dim } from "../../studio/kernel/dims"
import type { DrawingData } from "../../studio/kernel/drawing"
import { InputError } from "../../studio/kernel/errors"
import type { MeasureResult, MeasureSpec } from "../../studio/kernel/measure"
import { STARTERS } from "../../studio/starters"
import { resolveParams } from "../../studio/expr"
import { ASM_EXT, besides, effectiveTree, gather, isAssembly, loadShared, shadowed, sharedText, type Shared } from "./sources"
import { DESKTOP_TOOLS, STUDIO_TOOLS } from "../../studio/tools"
import { AGENT_GUIDE, COMMAND } from "./catalog"
import { newNote, notesText, parseNotes, pickLines, type NotesFile } from "./notes"
import {
  NOTES_EXT,
  PART_EXT,
  type AgentActivity,
  type CallContext,
  type Change,
  type CommandResult,
  type DocState,
  type EngineEvent,
  type KernelCall,
  type KernelPhase,
  type LookRequest,
  type PartSummary,
  type PickRequest,
  type Snapshot,
} from "./protocol"
import { describeTreeChange } from "./tree-diff"

type V3 = [number, number, number]
/** One face or one edge, by selector (measure). */
type Target = { face?: Record<string, unknown>; edge?: Record<string, unknown>; feature?: string; part?: string }

export interface KernelHost {
  readonly phase: KernelPhase
  rebuild(tree: Tree): Promise<BuildReport>
  inspect(what: "body" | "faces" | "edges", selector?: unknown): Promise<string>
  display(index?: number): Promise<DisplayData>
  pick(kind: "face" | "edge", hash: number, point: V3): Promise<PickInfo | null>
  /** `before`: on the body a step starts from (re-picking a feature's faces or edges). */
  locate(kind: "face" | "edge", selector: unknown, before?: number): Promise<number[] | null>
  selectorFor(kind: "face" | "edge", hashes: number[], before: number): Promise<{ selector: Record<string, unknown>; count: number } | null>
  faceEdges(hash: number, before: number): Promise<number[]>
  measure(targets: MeasureSpec[]): Promise<MeasureResult | null>
  dimensions(): Promise<Dim[]>
  drawing(withIso: boolean): Promise<DrawingData | null>
  exportBody(format: "step" | "stl", index?: number): Promise<Uint8Array | null>
  /** Files `import` features read (absent: this host can't read files). */
  setAssets?(list: { name: string; bytes: Uint8Array | null; error?: string }[]): Promise<void>
  /** What an assembly's components read (absent: this host can't read files). */
  setComponents?(list: ComponentSource[]): Promise<void>
  /** Editing a part inside an assembly: the other parts around it (null: none). */
  setContext?(ctx: ContextSource | null): Promise<void>
}

export interface Files {
  read(path: string): Promise<string | null>
  write(path: string, data: string | Uint8Array): Promise<void>
  /** Call back when the file changes on disk; returns a function that stops watching. */
  watch(path: string, onChange: () => void): () => void
  /** The path with symlinks resolved (/tmp → /private/tmp), so one file is one part. */
  canonical?(path: string): string
  /** For `import`: the bytes of a file, and its size and modification time (to tell when it changed). */
  readBytes?(path: string): Promise<Uint8Array | null>
  stat?(path: string): Promise<{ size: number; mtimeMs: number } | null>
}

/** The window, when there is one: renders views for `look`. */
export interface Screen {
  look(req: LookRequest): Promise<string[]>
}

export type EngineOptions = {
  kernel: KernelHost
  files: Files
  screen?: () => Screen | null
  /** Recently opened parts, most recent first; kept by the host. */
  recent?: string[]
  onRecent?: (paths: string[]) => void
}

type Entry = { tree: Tree; summary: string }

type Doc = {
  path: string
  name: string
  tree: Tree
  rev: number
  report: BuildReport | null
  undo: Entry[]
  redo: Entry[]
  changes: Change[]
  notes: NotesFile
  error?: string
  /** A save found the file changed under it this command: the result says so. */
  conflict?: boolean
  /** The text last written or read: tells our own writes apart from someone else's. */
  written: string | null
  unwatch: () => void
  /** Watchers on the files the part reads (STEP imports, components, shared parameters), by absolute path. */
  assetWatch: Map<string, () => void>
  /** The shared parameter file (`uses`), loaded. */
  shared: Shared | null
  /** Editing inside an assembly: the assembly file (absolute), else null. */
  context: string | null
  /** Changes so far (the activity list is capped; this keeps counting). */
  seq: number
  /** What the agent has been told about: changes up to this one, notes up to this number. */
  agentSeq: number
  agentNoteN: number
}

type PickAnswer = { info: PickInfo; text?: string }

const MAX_UNDO = 100
const MAX_CHANGES = 200
const FEATURE_TOOLS = new Set<string>(Feature.options.map((o) => o.shape.op.value))
const STUDIO_TOOL_NAMES = new Set([...Object.keys(STUDIO_TOOLS), ...Object.keys(DESKTOP_TOOLS)].filter((n) => n !== "look"))
/** Agent-side commands the window may run too. */
const WINDOW_OK = new Set(["undo", "redo"])

const fail = (text: string): CommandResult => ({ ok: false, text: `✗ ${text}` })
const clip = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function partName(path: string) {
  const base = path.split(/[\\/]/).pop() ?? path
  if (base.endsWith(ASM_EXT)) return base.slice(0, -ASM_EXT.length)
  return base.endsWith(PART_EXT) ? base.slice(0, -PART_EXT.length) : base.replace(/\.json$/i, "")
}

export function notesPath(path: string) {
  // An assembly's notes don't share a name with a part of the same name next to it.
  if (path.endsWith(ASM_EXT)) return path.slice(0, -ASM_EXT.length) + ".asm" + NOTES_EXT
  return path.endsWith(PART_EXT) ? path.slice(0, -PART_EXT.length) + NOTES_EXT : path.replace(/\.json$/i, "") + NOTES_EXT
}

/**
 * A part path as given by a caller: made absolute against its directory, `.` and repeated
 * separators dropped, `.arbor.json` added when there's no `.json`. `..` stays: after a symlinked
 * folder it means the link target's parent, so only the file system (`Files.canonical`) resolves it.
 */
export function normalizePartPath(path: string, cwd?: string) {
  let p = path.trim().replace(/\\/g, "/")
  if (!/^([A-Za-z]:)?\//.test(p) && cwd) p = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${p}`
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? ""
  const parts = p
    .slice(drive.length)
    .split("/")
    .filter((seg) => seg && seg !== ".")
  p = `${drive}/${parts.join("/")}`
  if (!/\.json$/i.test(p)) p += PART_EXT
  return p
}

export function parseTree(text: string): { ok: true; tree: Tree } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `JSON 格式错误：${(e as Error).message}` }
  }
  const parsed = Tree.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "（根）"} ${i.message}`).join("；") }
  return { ok: true, tree: parsed.data }
}

export class Engine {
  private docs = new Map<string, Doc>()
  private active: string | null = null
  private sessions = new Map<string, string>()
  private listeners = new Set<(e: EngineEvent) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private kernelDoc: Doc | null = null
  private kernelTree: Tree | null = null
  /** Which part's files (and versions) the kernel holds for `import`. */
  private assetsKey = ""
  /** Shared parameter files written by this engine, as written (their watchers then see no change). */
  private sharedWritten = new Map<string, string>()
  private agent: AgentActivity = { busy: false, tool: null, at: null }
  private pending: { request: PickRequest; waiters: ((a: PickAnswer | null) => void)[] } | null = null
  /** A pick the person answered after the agent stopped waiting: handed over on the next identical request. */
  private late: { path: string; prompt: string; answer: PickAnswer } | null = null
  private recent: string[]
  private opts: EngineOptions

  constructor(opts: EngineOptions) {
    this.opts = opts
    this.recent = opts.recent ?? []
  }

  // ------------------------------------------------------------------ events

  on(cb: (e: EngineEvent) => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private emit(e: EngineEvent) {
    for (const cb of this.listeners) {
      try {
        cb(e)
      } catch {
        /* a listener's failure isn't the engine's */
      }
    }
  }

  private emitSnapshot() {
    this.emit({ type: "snapshot", snapshot: this.snapshot() })
  }

  /** Snapshot first: the window keeps the doc only when it's the active part, so it must know which that is. */
  private emitDoc(doc: Doc) {
    this.emitSnapshot()
    this.emit({ type: "doc", doc: this.state(doc) })
  }

  /** The kernel came up or failed: the host tells the engine, the engine tells the window. */
  kernelChanged() {
    this.emitSnapshot()
  }

  // ------------------------------------------------------------------- state

  snapshot(): Snapshot {
    const parts: PartSummary[] = [...this.docs.values()].map((d) => ({
      path: d.path,
      name: d.name,
      features: d.tree.features.length,
      openNotes: d.notes.notes.filter((n) => n.status === "open").length,
      error: d.error,
      kind: isAssembly(d.path) ? ("assembly" as const) : ("part" as const),
    }))
    return { parts, active: this.active, kernel: this.opts.kernel.phase, agent: { ...this.agent } }
  }

  docState(path?: string | null): DocState | null {
    const doc = this.docs.get(path ?? this.active ?? "")
    return doc ? this.state(doc) : null
  }

  get recentParts() {
    return [...this.recent]
  }

  pickRequest() {
    return this.pending?.request ?? null
  }

  private state(doc: Doc): DocState {
    return {
      path: doc.path,
      name: doc.name,
      tree: this.windowTree(doc),
      kind: isAssembly(doc.path) ? "assembly" : "part",
      shared: doc.tree.uses ? { file: doc.tree.uses, names: Object.keys(doc.shared?.params ?? {}), error: doc.shared?.error } : undefined,
      context: doc.context ? { assembly: doc.context, name: partName(doc.context) } : undefined,
      rev: doc.rev,
      report: doc.report,
      canUndo: doc.undo.length > 0,
      canRedo: doc.redo.length > 0,
      changes: doc.changes.slice(0, 50),
      notes: doc.notes.notes,
      nextNote: doc.notes.next,
      error: doc.error,
    }
  }

  // ---------------------------------------------------------------- commands

  /** Run one command. Everything that touches the kernel or a part runs one at a time. */
  async run(name: string, input: unknown, ctx: CallContext): Promise<CommandResult> {
    const spec = COMMAND.get(name)
    const allowed =
      spec && (spec.audience === "both" || (ctx.actor === "user" ? spec.audience === "user" || WINDOW_OK.has(name) : spec.audience === "agent"))
    if (!spec || !allowed) return fail(`没有这个命令：${name}`)
    const parsed = spec.input.safeParse(input ?? {})
    if (!parsed.success) return fail(`参数不对：${parsed.error.issues.map((i) => `${i.path.join(".") || "（根）"} ${i.message}`).join("；")}`)
    const data = parsed.data as Record<string, unknown>
    if (name === "guide") return { ok: true, text: AGENT_GUIDE }
    try {
      // Waits for the person outside the queue (and without "agent busy"): the window answers through kernel calls.
      if (name === "request_pick") return await this.requestPick(data, ctx)
      return await this.track(ctx, name, () => this.exclusive(() => this.runLocked(name, data, ctx)))
    } catch (e) {
      return fail(e instanceof InputError ? e.message : `出错了：${(e as Error)?.message ?? e}`)
    }
  }

  private async track(ctx: CallContext, name: string, fn: () => Promise<CommandResult>) {
    if (ctx.actor !== "agent") return fn()
    this.agent = { busy: true, tool: name, at: Date.now() }
    this.emitSnapshot()
    try {
      return await fn()
    } finally {
      this.agent = { busy: false, tool: name, at: Date.now() }
      this.emitSnapshot()
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.chain.then(fn)
    this.chain = job.catch(() => undefined)
    return job
  }

  private async runLocked(name: string, input: Record<string, unknown>, ctx: CallContext): Promise<CommandResult> {
    try {
      if (name === "open_part") return await this.openPart(input as { path: string; create?: boolean; template?: string; context?: string }, ctx)
      if (name === "list_parts") return this.listParts()
      if (name === "close_part") return this.closePart(this.partKey(String(input.path)))
      const doc = await this.resolveDoc(ctx)
      if (!doc) return fail("还没有打开零件：先用 open_part（path 写零件文件，新零件加 create: true）。")
      // Catch up with the file first: an editor may have saved it a moment ago (the watcher is debounced).
      await this.fileChanged(doc)
      // get_notes lists the new notes itself.
      const notice = ctx.actor === "agent" ? this.noticeFor(doc, name === "get_notes") : ""
      let res = await this.onDoc(doc, name, input, ctx)
      if (doc.conflict) {
        doc.conflict = false
        res = { ok: false, text: `${res.text}\n\n⚠ 这次修改期间，文件被别人保存过：已经以文件里的版本为准，刚才的改动没有写进文件（undo 可以找回）。` }
      }
      if (ctx.actor === "agent") this.markSeen(doc)
      return notice ? { ...res, text: `${notice}\n\n${res.text}` } : res
    } catch (e) {
      if (e instanceof InputError) return fail(e.message)
      return fail(`出错了：${(e as Error)?.message ?? e}`)
    }
  }

  private async onDoc(doc: Doc, name: string, input: Record<string, unknown>, ctx: CallContext): Promise<CommandResult> {
    if (name === "set_params" && (doc.tree.uses || input.shared)) return this.setParams(doc, input, ctx)
    if (name === "share_params") return this.shareParams(doc, input as { file?: string; create?: boolean; move?: string[]; stop?: boolean }, ctx)
    if (FEATURE_TOOLS.has(name)) {
      const asm = isAssembly(doc.path)
      if (name === "component" && !asm) return fail(`零件文件里不能放 component。新建一个装配文件（open_part，路径以 ${ASM_EXT} 结尾，create: true），在那里放零件`)
      if (asm && name !== "component") return fail("装配里只能放零件（component）。要改零件的形状，用 open_part 打开它的文件（加 context 写这个装配文件，就能看着其他零件改）")
    }
    if (STUDIO_TOOL_NAMES.has(name)) {
      await this.ensureKernel(doc)
      // With shared parameters merged in, so expressions that use them check out; saved without them.
      const before = this.effective(doc, doc.tree)
      const run = await executeTool(this.port(doc), before, name, input)
      if (run.tree !== before) await this.adopt(doc, this.unshare(doc, run.tree), ctx.actor, { report: run.report })
      else if (run.report) doc.report = run.report
      return { ok: run.output.ok, text: run.output.text }
    }
    switch (name) {
      case "get_state":
        return { ok: true, text: await this.stateText(doc) }
      case "set_tree": {
        const base = input.base_rev as number | undefined
        if (base !== undefined && base !== doc.rev) return fail(`模型已经是第 ${doc.rev} 版了（你基于第 ${base} 版）：先用 get_state 看最新的，再改。`)
        await this.adopt(doc, await this.stripShared(doc, input.tree as Tree, ctx), ctx.actor)
        return { ok: this.allOk(doc), text: `已替换特征树（第 ${doc.rev} 版）。\n${treeText(doc.tree, doc.report!)}` }
      }
      case "move_feature": {
        const by = input.by as number
        let tree = doc.tree
        for (let i = 0; i < Math.abs(by); i++) tree = moveFeature(tree, String(input.id), by < 0 ? -1 : 1)
        if (tree === doc.tree) return { ok: true, text: "顺序没变。" }
        await this.adopt(doc, tree, ctx.actor)
        return { ok: this.allOk(doc), text: treeText(doc.tree, doc.report!) }
      }
      case "undo":
      case "redo":
        return this.undoRedo(doc, name, ctx)
      case "look":
        return this.look(doc, input)
      case "measure": {
        await this.ensureKernel(doc)
        const a = await this.one(input.a as Target)
        const b = input.b ? await this.one(input.b as Target) : undefined
        const res = await this.opts.kernel.measure(b ? [a, b] : [a])
        if (!res) return fail("量不了：还没有实体。")
        return { ok: true, text: measureText(res) }
      }
      case "export":
        return this.exportPart(doc, input as { path: string; format?: "step" | "stl" | "py" | "json" }, ctx)
      case "get_notes": {
        doc.agentNoteN = Math.max(doc.agentNoteN, ...doc.notes.notes.map((n) => n.n))
        return { ok: true, text: notesText(doc.notes.notes, input.status === "all") }
      }
      case "resolve_note": {
        const note = doc.notes.notes.find((n) => n.id === input.id)
        if (!note) return fail(`没有备注 ${input.id}。用 get_notes 看有哪些。`)
        if (input.reopen) {
          note.status = "open"
          note.resolvedAt = undefined
        } else {
          note.status = "resolved"
          note.resolvedAt = Date.now()
        }
        if (typeof input.reply === "string" && input.reply.trim()) note.reply = input.reply.trim()
        this.logNote(doc, ctx.actor, `${input.reopen ? "重新打开" : "处理完"}备注 ${note.id}${note.reply && !input.reopen ? `：${note.reply}` : ""}`)
        await this.saveNotes(doc)
        this.emitDoc(doc)
        const open = doc.notes.notes.filter((n) => n.status === "open").length
        return { ok: true, text: `${note.id} ${note.status === "open" ? "已重新打开" : "已标为已处理"}。还有 ${open} 条未处理。` }
      }
      case "show":
        return this.show(doc, input)
      case "add_note": {
        const note = newNote(doc.notes, (input.pick as unknown as PickInfo | undefined) ?? null, String(input.text ?? ""))
        doc.notes = { next: note.n + 1, notes: [...doc.notes.notes, note] }
        this.logNote(doc, ctx.actor, `记下备注 ${note.id}「${clip(note.text) || "只点了位置"}」`, "added")
        await this.saveNotes(doc)
        this.emitDoc(doc)
        return { ok: true, text: `已记下备注 ${note.id}。` }
      }
      case "update_note": {
        const note = doc.notes.notes.find((n) => n.id === input.id)
        if (!note) return fail(`没有备注 ${input.id}`)
        if (input.remove) {
          doc.notes = { ...doc.notes, notes: doc.notes.notes.filter((n) => n !== note) }
          this.logNote(doc, ctx.actor, `删除备注 ${note.id}`)
        } else {
          if (typeof input.text === "string") note.text = input.text.trim()
          if (input.status && input.status !== note.status) {
            note.status = input.status as "open" | "resolved"
            note.resolvedAt = note.status === "resolved" ? Date.now() : undefined
            this.logNote(doc, ctx.actor, `把备注 ${note.id} 标为${note.status === "resolved" ? "已处理" : "未处理"}`)
          }
        }
        await this.saveNotes(doc)
        this.emitDoc(doc)
        return { ok: true, text: "已更新备注。" }
      }
    }
    return fail(`没有这个命令：${name}`)
  }

  // ------------------------------------------------------- shared params

  /**
   * set_params on a part with a shared parameter file: names the file holds (or all, with shared: true)
   * are written there and every open part using it rebuilds; the rest go to the part's own table.
   */
  private async setParams(doc: Doc, input: Record<string, unknown>, ctx: CallContext): Promise<CommandResult> {
    const set = (input.set as Record<string, number | string> | undefined) ?? {}
    const remove = (input.remove as string[] | undefined) ?? []
    const notes = (input.notes as Record<string, string> | undefined) ?? {}
    const toShared = input.shared === true
    const sh = doc.shared
    if (toShared && !sh) return fail("这个零件还没有共享参数文件：先用 share_params 指定一个（例如 pen.params.json）")
    if (sh?.error) return fail(sh.error)
    const inShared = (k: string) => toShared || (!!sh && k in sh.params)
    const pick = <T,>(o: Record<string, T>, keep: boolean) => Object.fromEntries(Object.entries(o).filter(([k]) => inShared(k) === keep))
    const sharedSet = pick(set, true)
    const sharedRemove = remove.filter((k) => !!sh && k in sh.params)
    const sharedNotes = pick(notes, true)
    const lines: string[] = []
    if (sh && (Object.keys(sharedSet).length || sharedRemove.length || Object.keys(sharedNotes).length)) {
      const apply = (cur: { params: Shared["params"]; notes: Record<string, string> }) => {
        const params = { ...cur.params, ...sharedSet }
        const pnotes = { ...cur.notes, ...sharedNotes }
        for (const k of sharedRemove) {
          delete params[k]
          delete pnotes[k]
        }
        return { params, notes: pnotes }
      }
      try {
        resolveParams({ ...doc.tree.params, ...apply({ params: sh.params, notes: sh.notes }).params })
      } catch (e) {
        return fail(`参数不对：${(e as Error).message}`)
      }
      const users = await this.writeShared(sh, apply, ctx)
      const what = [...Object.entries(sharedSet).map(([k, v]) => `${k} = ${v}`), ...sharedRemove.map((k) => `删除 ${k}`)].join("，") || "参数说明"
      lines.push(`共享参数（${sh.file}）：${what}。${users.length > 1 ? `用到它的 ${users.map((d) => d.name).join("、")} 都已重建。` : ""}`)
    }
    const own = { set: pick(set, false), remove: remove.filter((k) => !sharedRemove.includes(k)), notes: pick(notes, false) }
    if (Object.keys(own.set).length || own.remove.length || Object.keys(own.notes).length) {
      // Checked against the merged table (own parameters may use shared ones), saved without the shared ones.
      const eff = this.effective(doc, doc.tree)
      const run = await executeTool(this.port(doc), eff, "set_params", own)
      if (run.tree !== eff) await this.adopt(doc, this.unshare(doc, run.tree), ctx.actor, { report: run.report })
      lines.push(run.output.text)
    } else lines.push(treeText(doc.tree, doc.report!))
    const shadow = shadowed(doc.tree, doc.shared)
    if (shadow.length) lines.push(`⚠ 参数 ${shadow.join("、")} 在共享参数文件里也有，以共享的为准`)
    return { ok: this.allOk(doc), text: lines.join("\n") }
  }

  /**
   * Change a shared parameter file and rebuild every open part that uses it. The change applies to the
   * file as it is on disk now (someone may have edited it since it was loaded). Returns those parts.
   */
  private async writeShared(sh: Shared, change: (cur: { params: Shared["params"]; notes: Record<string, string> }) => { params: Shared["params"]; notes: Record<string, string> }, ctx: CallContext) {
    const latest = await loadShared(this.opts.files, sh.path, sh.path.split(/[\\/]/).pop()!)
    if (latest.error && latest.text !== null) throw new InputError(latest.error)
    const { params, notes } = change(latest.text === null ? { params: {}, notes: {} } : { params: latest.params, notes: latest.notes })
    // Checked as it will be written: the file on disk may differ from what was checked before.
    try {
      resolveParams(params)
    } catch (e) {
      throw new InputError(`共享参数不对，没有写入 ${sh.file}：${(e as Error).message}`)
    }
    const text = sharedText({ params, notes })
    this.sharedWritten.set(sh.path, text)
    await this.opts.files.write(sh.path, text)
    const users = [...this.docs.values()].filter((d) => d.shared?.path === sh.path || d.context)
    for (const d of users) {
      if (d.shared?.path === sh.path) await this.refreshShared(d)
      d.rev += 1
      d.changes = [{ rev: d.rev, actor: ctx.actor, at: Date.now(), summary: `改了共享参数 ${sh.file}`, seq: ++d.seq }, ...d.changes].slice(0, MAX_CHANGES)
      if (this.kernelDoc === d) this.kernelDoc = null
    }
    this.assetsKey = ""
    const active = users.find((d) => d.path === this.active) ?? users[0]
    if (active) {
      await this.ensureKernel(active, true)
      this.emitDoc(active)
    }
    return users.filter((d) => d.shared?.path === sh.path)
  }

  /** Start using a shared parameter file (creating it, moving some of the part's own parameters into it), or stop. */
  private async shareParams(doc: Doc, input: { file?: string; create?: boolean; move?: string[]; stop?: boolean }, ctx: CallContext): Promise<CommandResult> {
    if (input.stop) {
      if (!doc.tree.uses) return { ok: true, text: "这个零件本来就没有用共享参数文件。" }
      const { uses: _drop, ...rest } = doc.tree
      void _drop
      // The values in use: the shared ones won, so they stay.
      const kept = { ...doc.tree.params, ...(doc.shared?.params ?? {}) }
      const keptNotes = { ...(doc.tree.paramNotes ?? {}), ...(doc.shared?.notes ?? {}) }
      await this.adopt(doc, { ...rest, params: kept, paramNotes: Object.keys(keptNotes).length ? keptNotes : undefined }, ctx.actor, { summary: `不再用共享参数文件 ${doc.tree.uses}（参数抄回零件里）` })
      return { ok: this.allOk(doc), text: `已停用共享参数文件，共享参数的当前值抄回了零件自己的参数表。\n${treeText(doc.tree, doc.report!)}` }
    }
    const file = input.file?.trim()
    if (!file) return fail("file 写共享参数文件的路径，相对零件文件所在的文件夹，例如 pen.params.json")
    const abs = besides(doc.path, file)
    let sh = await loadShared(this.opts.files, doc.path, file)
    if (sh.text === null) {
      if (!input.create) return fail(`没有 ${abs}。要新建就设 create: true`)
      await this.opts.files.write(abs, sharedText({ params: {}, notes: {} }))
      sh = await loadShared(this.opts.files, doc.path, file)
    }
    if (sh.error) return fail(sh.error)
    const move = input.move ?? []
    const missing = move.filter((k) => !(k in doc.tree.params))
    if (missing.length) return fail(`零件里没有参数 ${missing.join("、")}`)
    let tree: Tree = { ...doc.tree, uses: file }
    if (move.length) {
      const params = { ...sh.params, ...Object.fromEntries(move.map((k) => [k, doc.tree.params[k]])) }
      const notes = { ...sh.notes, ...Object.fromEntries(move.flatMap((k) => (doc.tree.paramNotes?.[k] ? [[k, doc.tree.paramNotes[k]]] : []))) }
      const own = Object.fromEntries(Object.entries(doc.tree.params).filter(([k]) => !move.includes(k)))
      const ownNotes = Object.fromEntries(Object.entries(doc.tree.paramNotes ?? {}).filter(([k]) => !move.includes(k)))
      tree = { ...tree, params: own, paramNotes: Object.keys(ownNotes).length ? ownNotes : undefined }
      await this.writeShared(sh, (cur) => ({ params: { ...cur.params, ...Object.fromEntries(move.map((k) => [k, params[k]])) }, notes: { ...cur.notes, ...Object.fromEntries(Object.entries(notes).filter(([k]) => move.includes(k))) } }), ctx)
    }
    await this.adopt(doc, tree, ctx.actor, { summary: `用共享参数文件 ${file}${move.length ? `，移进去 ${move.join("、")}` : ""}` })
    const shadow = shadowed(doc.tree, doc.shared)
    return {
      ok: this.allOk(doc),
      text: `已用共享参数文件 ${file}（${Object.keys(doc.shared?.params ?? {}).length} 个参数）。别的零件和装配写同一个 uses（share_params）就共用这些尺寸；改它们用 set_params，会写回这个文件。${shadow.length ? `\n⚠ 参数 ${shadow.join("、")} 在共享参数文件里也有，以共享的为准` : ""}\n${treeText(doc.tree, doc.report!)}`,
    }
  }

  /** A whole tree from the window (it shows shared parameters in the table): those go back to the shared file. */
  private async stripShared(doc: Doc, tree: Tree, ctx: CallContext): Promise<Tree> {
    const sh = doc.shared
    if (!sh || sh.error || !tree.uses || tree.uses !== doc.tree.uses) return tree
    const params = { ...tree.params }
    const notes = { ...(tree.paramNotes ?? {}) }
    const changed: Record<string, number | string> = {}
    for (const k of Object.keys(sh.params)) {
      if (!(k in params)) continue
      if (params[k] !== sh.params[k]) changed[k] = params[k]
      delete params[k]
      delete notes[k]
    }
    if (Object.keys(changed).length) await this.writeShared(sh, (cur) => ({ params: { ...cur.params, ...changed }, notes: cur.notes }), ctx)
    return { ...tree, params, paramNotes: Object.keys(notes).length ? notes : undefined }
  }

  /** A tree worked on with the shared parameters merged in, back to the part's own: shared ones out (unless it had its own). */
  private unshare(doc: Doc, tree: Tree): Tree {
    const sh = doc.shared
    if (!sh || sh.error) return tree
    const ownParams = doc.tree.params
    const ownNotes = doc.tree.paramNotes ?? {}
    // Shared names go; an own parameter they shadowed comes back as it was (the merge overwrote it).
    const params = Object.fromEntries(
      Object.entries(tree.params).flatMap(([k, v]) => (k in sh.params ? (k in ownParams ? [[k, ownParams[k]]] : []) : [[k, v]])),
    )
    const notes = Object.fromEntries(
      Object.entries(tree.paramNotes ?? {}).flatMap(([k, v]) => (k in sh.params || k in sh.notes ? (k in ownNotes ? [[k, ownNotes[k]]] : []) : [[k, v]])),
    )
    return { ...tree, params, paramNotes: Object.keys(notes).length ? notes : undefined }
  }

  // ------------------------------------------------------------------ parts

  private async openPart(input: { path: string; create?: boolean; template?: string; context?: string }, ctx: CallContext): Promise<CommandResult> {
    const path = this.partKey(input.path, ctx.cwd)
    const existed = this.docs.has(path) || (await this.opts.files.read(path)) !== null
    const doc = await this.load(path, { create: input.create, template: isAssembly(path) ? undefined : input.template })
    // In an assembly (or out of one): the other parts come along as see-through references.
    const context = input.context ? this.partKey(input.context, ctx.cwd) : null
    let contextNote = ""
    if (context !== doc.context) {
      if (context) {
        if (isAssembly(path)) return fail("context 用来在装配里改一个零件；打开的是装配本身，不用写 context")
        const before = doc.context
        doc.context = context
        const found = await this.contextOf(doc, false)
        if (!found) {
          doc.context = before
          return fail(`${input.context} 里没有用到这个零件（要有一个 component 的 file 指向 ${partName(path)}），或者装配文件读不了`)
        }
        contextNote = found.note ? `\n${found.note}。` : ""
      } else doc.context = null
      this.assetsKey = ""
      await this.ensureKernel(doc, true)
    }
    this.active = path
    if (ctx.session) this.sessions.set(ctx.session, path)
    // What was there before the agent arrived isn't news to it.
    if (ctx.actor === "agent") this.markSeen(doc)
    this.emitDoc(doc)
    const what = isAssembly(path) ? "装配" : "零件"
    const head = existed ? `已打开${what} ${path}（第 ${doc.rev} 版）` : `已新建${what} ${path}${input.template && !isAssembly(path) ? `（从「${STARTERS.find((s) => s.id === input.template)?.title}」开始）` : ""}`
    const open = doc.notes.notes.filter((n) => n.status === "open")
    const notes = open.length ? `\n窗口里有 ${open.length} 条未处理的备注，用 get_notes 读。` : ""
    const warn = existed && input.template ? "\n文件已经存在，没有用 template。" : ""
    const inCtx = doc.context ? `\n在装配「${partName(doc.context)}」里编辑：装配里的其他零件（${(doc.report?.refs ?? []).map((r) => r.name).join("、") || "无"}）半透明地显示在旁边，可以 look、measure、check（gap / clearance / interference 写它们的名字）。${contextNote}` : ""
    const asmHint = isAssembly(path) && !doc.tree.features.length ? "\n这是空装配：用 component 放零件（file 写零件文件，rotate、at 摆位置）。" : ""
    return { ok: true, text: `${head}。Arbor 窗口已切到这个${what}。${warn}${notes}${inCtx}${asmHint}\n${treeText(doc.tree, doc.report!)}` }
  }

  private listParts(): CommandResult {
    const parts = [...this.docs.values()]
    if (!parts.length) return { ok: true, text: `没有打开的零件。${this.recent.length ? `\n最近打开过：\n${this.recent.slice(0, 10).map((p) => `- ${p}`).join("\n")}` : ""}` }
    const lines = parts.map((d) => {
      const open = d.notes.notes.filter((n) => n.status === "open").length
      return `${d.path === this.active ? "▸" : "-"} ${d.path}（${isAssembly(d.path) ? "装配" : "零件"}）：${d.tree.features.length} 个${isAssembly(d.path) ? "零件" : "特征"}${open ? `，${open} 条未处理备注` : ""}${d.error ? `，文件有错：${d.error}` : ""}`
    })
    return { ok: true, text: `打开的零件（▸ = 窗口里正在看的）：\n${lines.join("\n")}` }
  }

  private closePart(path: string): CommandResult {
    const doc = this.docs.get(path)
    if (!doc) return { ok: true, text: "没有打开这个零件。" }
    doc.unwatch()
    for (const stop of doc.assetWatch.values()) stop()
    this.docs.delete(path)
    if (this.kernelDoc === doc) this.kernelDoc = null
    for (const [s, p] of this.sessions) if (p === path) this.sessions.delete(s)
    if (this.active === path) this.active = [...this.docs.keys()].pop() ?? null
    const next = this.active ? this.docs.get(this.active) : null
    if (next) this.emitDoc(next)
    else this.emitSnapshot()
    return { ok: true, text: "已关闭。" }
  }

  /** Open a part for the window (File → Open, the parts list): same as the agent's open_part, as the person. */
  openForUser(path: string, create = false) {
    return this.run("open_part", { path, create }, { actor: "user" })
  }

  /** One file, one part: the same file reached by different paths gets the same key. */
  private partKey(path: string, cwd?: string) {
    const p = normalizePartPath(path, cwd)
    return this.opts.files.canonical?.(p) ?? p
  }

  private async resolveDoc(ctx: CallContext): Promise<Doc | null> {
    if (ctx.part) {
      const path = this.partKey(ctx.part, ctx.cwd)
      return this.docs.get(path) ?? (await this.load(path, {}))
    }
    const path = (ctx.session && this.sessions.get(ctx.session)) || this.active
    return path ? (this.docs.get(path) ?? null) : null
  }

  private async load(path: string, opts: { create?: boolean; template?: string }): Promise<Doc> {
    const existing = this.docs.get(path)
    if (existing) return existing
    const text = await this.opts.files.read(path)
    let tree: Tree
    if (text === null) {
      if (!opts.create) throw new InputError(`没有这个文件：${path}。要新建就设 create=true。`)
      tree = (opts.template && STARTERS.find((s) => s.id === opts.template)?.tree) || EMPTY_TREE
    } else {
      const parsed = parseTree(text)
      if (!parsed.ok) throw new InputError(`${path} 不是合法的特征树：${parsed.error}`)
      tree = parsed.tree
    }
    const notes = parseNotes(await this.opts.files.read(notesPath(path)))
    const doc: Doc = {
      path,
      name: partName(path),
      tree,
      rev: 0,
      report: null,
      undo: [],
      redo: [],
      changes: [],
      notes,
      written: text,
      unwatch: () => {},
      assetWatch: new Map(),
      shared: null,
      context: null,
      seq: 0,
      agentNoteN: 0,
      agentSeq: 0,
    }
    this.docs.set(path, doc)
    await this.refreshShared(doc)
    if (text === null) await this.save(doc)
    doc.unwatch = this.opts.files.watch(path, () => void this.exclusive(() => this.fileChanged(doc)))
    await this.ensureKernel(doc)
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 20)
    this.opts.onRecent?.(this.recent)
    return doc
  }

  /** Someone (the agent with its own editor, git, a person in another editor) changed the file. */
  private async fileChanged(doc: Doc) {
    if (this.docs.get(doc.path) !== doc) return
    const text = await this.opts.files.read(doc.path)
    if (text === doc.written) return
    if (text === null) {
      doc.error = "文件被删除或移走了；窗口里还是删之前的模型"
      this.emitDoc(doc)
      return
    }
    doc.written = text
    const parsed = parseTree(text)
    if (!parsed.ok) {
      doc.error = `文件不是合法的特征树：${parsed.error}`
      this.emitDoc(doc)
      return
    }
    // Don't write it back: an editor that just saved it would see the file change under it.
    await this.adopt(doc, parsed.tree, "file", { save: false })
  }

  // ---------------------------------------------------------- tree changes

  /** Make `tree` the part's current tree: rebuild, record who did what, save, tell the window. Undoable. */
  private async adopt(doc: Doc, tree: Tree, actor: CallContext["actor"], opts: { report?: BuildReport; save?: boolean; summary?: string; undoable?: boolean } = {}) {
    const summary = opts.summary ?? (describeTreeChange(doc.tree, tree) || "重新保存（内容没变）")
    if (opts.undoable !== false) {
      doc.undo = [...doc.undo, { tree: doc.tree, summary }].slice(-MAX_UNDO)
      doc.redo = []
    }
    const usesChanged = doc.tree.uses !== tree.uses
    doc.tree = tree
    doc.rev += 1
    doc.error = undefined
    if (usesChanged) await this.refreshShared(doc)
    if (opts.report && this.kernelDoc === doc && this.kernelTree === tree) doc.report = opts.report
    else await this.ensureKernel(doc, true)
    doc.changes = [{ rev: doc.rev, actor, at: Date.now(), summary, seq: ++doc.seq }, ...doc.changes].slice(0, MAX_CHANGES)
    if (opts.save !== false && !(await this.save(doc))) {
      // Someone saved the file while this ran: theirs wins, ours stays one undo away.
      doc.conflict = true
      await this.fileChanged(doc)
      return
    }
    this.emitDoc(doc)
  }

  private async undoRedo(doc: Doc, which: "undo" | "redo", ctx: CallContext): Promise<CommandResult> {
    const from = which === "undo" ? doc.undo : doc.redo
    const entry = from[from.length - 1]
    if (!entry) return fail(which === "undo" ? "没有可以撤销的改动。" : "没有可以重做的改动。")
    if (which === "undo") {
      doc.undo = doc.undo.slice(0, -1)
      doc.redo = [...doc.redo, { tree: doc.tree, summary: entry.summary }]
    } else {
      doc.redo = doc.redo.slice(0, -1)
      doc.undo = [...doc.undo, { tree: doc.tree, summary: entry.summary }]
    }
    await this.adopt(doc, entry.tree, ctx.actor, { summary: `${which === "undo" ? "撤销" : "重做"}：${entry.summary}`, undoable: false })
    return { ok: true, text: `已${which === "undo" ? "撤销" : "重做"}：${entry.summary}\n${treeText(doc.tree, doc.report!)}` }
  }

  /** Notes don't change the tree (no new version) but belong in the activity list: who wrote, handled or removed what. */
  private logNote(doc: Doc, actor: CallContext["actor"], summary: string, note: "added" | "changed" = "changed") {
    doc.changes = [{ rev: doc.rev, actor, at: Date.now(), summary, note, seq: ++doc.seq }, ...doc.changes].slice(0, MAX_CHANGES)
  }

  private allOk(doc: Doc) {
    return !!doc.report && !doc.report.paramError && doc.report.features.every((f) => f.state === "ok" || f.state === "suppressed")
  }

  /** Write the tree, unless the file changed since we last read or wrote it (returns false: don't overwrite). */
  private async save(doc: Doc) {
    const disk = await this.opts.files.read(doc.path)
    if (disk !== null && doc.written !== null && disk !== doc.written) return false
    const text = `${JSON.stringify(doc.tree, null, 2)}\n`
    doc.written = text
    await this.opts.files.write(doc.path, text)
    return true
  }

  private async saveNotes(doc: Doc) {
    await this.opts.files.write(notesPath(doc.path), `${JSON.stringify(doc.notes, null, 2)}\n`)
  }

  // ------------------------------------------------------------------ kernel

  /** The kernel holds one tree at a time: make it this part's current one (with its shared parameters). */
  private async ensureKernel(doc: Doc, force = false) {
    const sourcesChanged = await this.syncAssets(doc, doc.tree)
    if (force || sourcesChanged || this.kernelDoc !== doc || this.kernelTree !== doc.tree) {
      const tree = doc.tree
      doc.report = await this.opts.kernel.rebuild(this.effective(doc, tree))
      this.kernelDoc = doc
      this.kernelTree = tree
    }
    return doc.report!
  }

  /** The tree the kernel builds: the part's own, with its shared parameters (which win). */
  private effective(doc: Doc, tree: Tree) {
    return effectiveTree(tree, doc.shared)
  }

  /** The tree the window shows: shared parameters in the table, their notes saying where they come from. */
  private windowTree(doc: Doc): Tree {
    const sh = doc.shared
    if (!sh || sh.error) return doc.tree
    const eff = effectiveTree(doc.tree, sh)
    const notes = { ...(eff.paramNotes ?? {}) }
    for (const k of Object.keys(sh.params)) notes[k] = `${sh.notes[k] ? `${sh.notes[k]}` : ""}（共享：${sh.file}）`
    return { ...eff, paramNotes: notes }
  }

  /** (Re)load the part's shared parameter file, if it names one. */
  private async refreshShared(doc: Doc) {
    doc.shared = doc.tree.uses ? await loadShared(this.opts.files, doc.path, doc.tree.uses) : null
  }

  /**
   * What the part reads besides its own file, handed to the kernel when it changes: STEP imports, an
   * assembly's components (recursively, with their shared parameters), and the assembly around a part
   * edited in context. Unchanged files (by size and modification time) aren't read again. Returns
   * whether anything changed.
   */
  private async syncAssets(doc: Doc, tree: Tree) {
    const files = this.opts.files
    const probe = await gather(files, doc.path, tree, [], false)
    const ctx = doc.context ? await this.contextOf(doc, false) : null
    this.watchAssets(doc, [...probe.watch, ...(doc.shared ? [doc.shared.path] : []), ...(ctx?.watch ?? [])])
    const key = JSON.stringify([doc.path, probe.signature, ctx?.key ?? null])
    if (key === this.assetsKey) return false
    const full = await gather(files, doc.path, tree, [], true)
    await this.opts.kernel.setAssets?.(full.assets)
    await this.opts.kernel.setComponents?.(full.components)
    await this.opts.kernel.setContext?.(doc.context ? ((await this.contextOf(doc, true))?.source ?? null) : null)
    this.assetsKey = key
    return true
  }

  /**
   * The assembly a part is edited in: this part's placement and every other component's, worked out
   * with the assembly's parameters. `read`: with the components' contents (else only what to watch).
   */
  private async contextOf(doc: Doc, read: boolean): Promise<{ source: ContextSource; watch: string[]; key: string; note?: string } | null> {
    const asm = doc.context!
    const files = this.opts.files
    const text = await files.read(asm)
    if (text === null) return null
    const parsed = parseTree(text)
    if (!parsed.ok) return null
    const shared = parsed.tree.uses ? await loadShared(files, asm, parsed.tree.uses) : null
    const tree = effectiveTree(parsed.tree, shared)
    let scope: Record<string, number>
    try {
      scope = resolveParams(tree.params)
    } catch {
      return null
    }
    const g = await gather(files, asm, tree, [], read)
    const comps = tree.features.filter((f): f is Extract<Feature, { op: "component" }> => f.op === "component" && !f.hidden)
    const canon = (f: string) => files.canonical?.(besides(asm, f)) ?? besides(asm, f)
    const mine = comps.filter((c) => canon(c.file) === doc.path)
    if (!mine.length) return null
    const placeOf = (c: Extract<Feature, { op: "component" }>) => ({
      rotate: (c.rotate ?? []).map((r) => ({ axis: r.axis, angle: num(r.angle, scope) })),
      at: (c.at ?? [0, 0, 0]).map((v) => num(v, scope)) as [number, number, number],
    })
    const others = comps
      .filter((c) => canon(c.file) !== doc.path)
      .flatMap((c) => {
        const source = g.components.find((x) => x.file === c.file)
        return source ? [{ name: c.name ?? partName(c.file).replace(/\.(step|stp)$/i, ""), source, place: placeOf(c) }] : []
      })
    const source: ContextSource = { self: placeOf(mine[0]), assembly: partName(asm), others }
    const watch = [asm, ...g.watch, ...(shared ? [shared.path] : [])]
    const note = mine.length > 1 ? `这个零件在装配里用了 ${mine.length} 次，按第一个（${mine[0].name ?? mine[0].id}）的位置显示其他零件` : undefined
    return { source, watch, key: JSON.stringify([text, g.signature, shared?.text ?? null]), note }
  }

  /** A STEP file the part imports changed on disk: rebuild, as a change by 「文件」. */
  private watchAssets(doc: Doc, paths: string[]) {
    for (const [p, stop] of doc.assetWatch) {
      if (paths.includes(p)) continue
      stop()
      doc.assetWatch.delete(p)
    }
    for (const p of paths) {
      if (doc.assetWatch.has(p)) continue
      doc.assetWatch.set(
        p,
        this.opts.files.watch(p, () =>
          void this.exclusive(async () => {
            if (this.docs.get(doc.path) !== doc) return
            if (doc.shared?.path === p) {
              const text = await this.opts.files.read(p)
              if (text !== null && text === this.sharedWritten.get(p)) return
              await this.refreshShared(doc)
            }
            this.assetsKey = ""
            doc.rev += 1
            doc.changes = [{ rev: doc.rev, actor: "file" as const, at: Date.now(), summary: `${p.split(/[\\/]/).pop()} 更新了，已重建`, seq: ++doc.seq }, ...doc.changes].slice(0, MAX_CHANGES)
            await this.ensureKernel(doc, true)
            this.emitDoc(doc)
          }),
        ),
      )
    }
  }

  private port(doc: Doc): KernelPort {
    return {
      rebuild: async (t) => {
        this.kernelTree = null
        if (t.uses !== doc.shared?.file) doc.shared = t.uses ? await loadShared(this.opts.files, doc.path, t.uses) : null
        await this.syncAssets(doc, t)
        const r = await this.opts.kernel.rebuild(this.effective(doc, t))
        this.kernelDoc = doc
        this.kernelTree = t
        return r
      },
      inspect: (what, selector) => this.opts.kernel.inspect(what, selector),
    }
  }

  /** The window's own kernel calls: drawing, clicking, measuring, exporting the part it shows. */
  kernelCall(path: string, call: KernelCall): Promise<unknown> {
    return this.exclusive(async () => {
      const doc = this.docs.get(path)
      if (!doc) throw new Error("这个零件已经关闭了")
      await this.ensureKernel(doc)
      const k = this.opts.kernel
      switch (call.op) {
        case "display":
          return k.display(call.index)
        case "pick":
          return k.pick(call.kind, call.hash, call.point)
        case "locate":
          return k.locate(call.kind, call.selector, call.before)
        case "selectorFor":
          return k.selectorFor(call.kind, call.hashes, call.before)
        case "faceEdges":
          return k.faceEdges(call.hash, call.before)
        case "measure":
          return k.measure(call.targets)
        case "dims":
          return k.dimensions()
        case "drawing":
          return k.drawing(call.iso)
        case "export":
          return k.exportBody(call.format, call.index)
      }
    })
  }

  private async one(t: Target): Promise<MeasureSpec> {
    if (t.feature) return { kind: "feature", id: t.feature }
    if (t.part) return { kind: "part", name: t.part }
    const kind = t.face ? "face" : "edge"
    const selector = t.face ?? t.edge
    if (!selector) throw new InputError("要写 face、edge、feature 或 part 之一")
    const hashes = await this.opts.kernel.locate(kind, selector)
    if (!hashes?.length) throw new InputError(`选择器什么都没选中：${JSON.stringify(selector)}`)
    if (hashes.length > 1) throw new InputError(`选择器选中了 ${hashes.length} 个，要正好一个（加 near 或更多条件）：${JSON.stringify(selector)}`)
    return { kind, hash: hashes[0], point: [0, 0, 0] }
  }

  // ----------------------------------------------------------- observation

  private async stateText(doc: Doc) {
    const report = await this.ensureKernel(doc)
    const open = doc.notes.notes.filter((n) => n.status === "open")
    const lines = [`${isAssembly(doc.path) ? "装配" : "零件"}：${doc.path}（第 ${doc.rev} 版）`]
    if (doc.error) lines.push(`⚠ ${doc.error}`)
    if (doc.tree.uses) lines.push(doc.shared?.error ? `⚠ ${doc.shared.error}` : `共享参数文件：${doc.tree.uses}（${Object.keys(doc.shared?.params ?? {}).join("、") || "空"}）`)
    const shadow = shadowed(doc.tree, doc.shared)
    if (shadow.length) lines.push(`⚠ 参数 ${shadow.join("、")} 在共享参数文件里也有，以共享的为准`)
    if (doc.context) lines.push(`在装配「${partName(doc.context)}」里编辑：其他零件 ${(report.refs ?? []).map((r) => r.name).join("、") || "（没有）"} 半透明显示，只读`)
    if (report.parts?.length) lines.push(`零件：${report.parts.map((p) => `${p.name}（${p.size.map((x) => Math.round(x * 10) / 10).join("×")}）`).join("、")}`)
    lines.push(treeText(this.effective(doc, doc.tree), report))
    lines.push(open.length ? `未处理的备注 ${open.length} 条：${open.map((n) => `${n.id}「${clip(n.text)}」`).join("、")}（get_notes 看详情）` : "没有未处理的备注。")
    if (doc.changes.length) {
      const who = { agent: "你", user: "用户", file: "文件" } as const
      lines.push(`最近的改动：\n${doc.changes.slice(0, 6).map((c) => `- 第 ${c.rev} 版 · ${who[c.actor]}：${c.summary}`).join("\n")}`)
    }
    return lines.join("\n")
  }

  private async look(doc: Doc, input: Record<string, unknown>): Promise<CommandResult> {
    const screen = this.opts.screen?.()
    if (!screen) return fail("看图要在 Arbor 窗口里渲染：先打开 Arbor App（命令行 arbor open <零件>），再调用 look。其余命令不需要窗口。")
    const report = await this.ensureKernel(doc)
    const at = input.at as string | undefined
    const index = at ? doc.tree.features.findIndex((f) => f.id === at) : -1
    if (at && index < 0) return fail(`找不到特征「${at}」`)
    const display = await this.opts.kernel.display(index >= 0 ? index : undefined)
    if (!display.mesh && !display.refs?.length) return fail("还没有实体可以看。")
    const size = (input.size as "normal" | "large" | undefined) ?? "normal"
    const H = LOOK_SIZE[size][1]
    const whole = modelBox(display) ?? refsBox(display)

    // A cut: which side goes, and the view that looks straight at the cut.
    const sec = input.section as { plane: "XY" | "XZ" | "YZ"; offset?: number | string } | undefined
    let section: LookSection | undefined
    if (sec) {
      const axis = ({ XY: "Z", XZ: "Y", YZ: "X" } as const)[sec.plane]
      const i = { X: 0, Y: 1, Z: 2 }[axis]
      const atValue = sec.offset !== undefined ? evalNum(sec.offset, report.params) : whole ? (whole[0][i] + whole[1][i]) / 2 : 0
      section = { axis, at: atValue }
    }
    const hide = (input.hide as string[] | undefined) ?? []
    const known = new Set([...(display.parts ?? []).map((p) => p.name), ...(display.refs ?? []).flatMap((r) => [r.name, r.id])])
    const unknown = hide.filter((n) => !known.has(n))
    if (unknown.length) return fail(`hide 里的「${unknown.join("、")}」不是零件或参考体的名字${known.size ? `：现在有 ${[...known].join("、")}` : "：现在只有一个没名字的实体"}`)

    // Framing: an explicit focus frames every view on it; otherwise a small last change gets a close-up of its own.
    const focusIn = input.focus as string | { part: string } | { faces: Record<string, unknown> } | undefined
    let focus: { box: Box; name: string } | null = null
    if (focusIn !== undefined) {
      const res = await this.focusBox(doc, display, focusIn)
      if ("error" in res) return fail(res.error)
      focus = res
    }
    const sectionView = section ? ({ Z: "top", Y: "front", X: "right" } as const)[section.axis] : null
    const views = (input.views as string[] | undefined)?.length
      ? (input.views as string[])
      : sectionView
        ? [sectionView, "iso"]
        : focus
          ? ["iso", "front"]
          : ["iso", "front", "top", "right"]
    const shots: LookShot[] = views.map((v) =>
      focus
        ? { label: `特写：${focus.name} · ${VIEW_LABEL[v] ?? v}`, dir: VIEW_DIR[v] ?? VIEW_DIR.iso, box: focus.box, padding: FOCUS_PADDING }
        : { label: VIEW_LABEL[v] ?? v, dir: VIEW_DIR[v] ?? VIEW_DIR.iso },
    )
    const dir = input.dir as number[] | undefined
    if (dir) {
      const l = Math.hypot(...dir)
      if (!l) return fail("dir 不能是 [0, 0, 0]")
      shots.push({ label: `从 (${dir.join(", ")}) 方向看${focus ? `（特写：${focus.name}）` : ""}`, dir: [dir[0] / l, dir[1] / l, dir[2] / l], box: focus?.box, padding: focus ? FOCUS_PADDING : undefined })
    }
    let auto: Box | null = null
    if (!focus) {
      auto = autoFocus(display)
      const f = doc.tree.features[display.index]
      if (auto) shots.push({ label: `特写：${f ? displayName(doc.tree, f) : "最后一步"}（自动）`, dir: VIEW_DIR.iso, box: auto, padding: FOCUS_PADDING })
    }

    const pins = input.notes === false ? [] : doc.notes.notes.filter((n) => n.status === "open" && n.kind !== "part").map((n) => ({ n: n.n, point: n.point }))
    const images = await screen.look({ display, views, highlight: input.highlight as string | undefined, pins, shots, section, hide: hide.length ? hide : undefined, size })
    const step = at ? `（回滚到「${displayName(doc.tree, doc.tree.features[index])}」这一步）` : ""
    const legend = input.highlight ? "蓝色 = 高亮的特征，灰色 = 其余" : "蓝色 = 这一步新生成的面，橙色 = 被它修改的面"
    const lines = [`视图：${shots.map((s) => s.label).join("、")}${step}。${legend}${pins.length ? "；圆圈数字 = 备注编号" : ""}。`]
    if (section) lines.push(`剖视：在 ${section.axis} = ${round2(section.at)} 处剖开，去掉了${{ Z: "上面（+Z）", Y: "前面（-Y）", X: "右面（+X）" }[section.axis]}那一侧。`)
    if (whole) {
      const scales = [...new Set(shots.map((s) => s.box ?? null))].map((b) => `${b ? `特写（${sizeText(b)} mm）` : "整件"} 1 px ≈ ${scaleText(mmPerPixel(b ?? whole, H, b ? FOCUS_PADDING : LOOK_PADDING))} mm`)
      lines.push(`整件 ${sizeText(whole)} mm；${scales.join("；")}。小于 3 px 的细节看不清：用 focus（特征 id、{ part } 或 { faces }）放大，用 section 剖开看里面。`)
    }
    if (auto) lines.push("最后一步的改动只占整件的一小块，已自动加了一张特写。")
    return { ok: true, text: lines.join("\n"), images }
  }

  /** The box `look` frames for a feature id, a part (or reference body) by name, or a face selector. */
  private async focusBox(doc: Doc, d: DisplayData, focus: string | { part: string } | { faces: Record<string, unknown> }): Promise<{ box: Box; name: string } | { error: string }> {
    if (typeof focus === "string") {
      const f = doc.tree.features.find((x) => x.id === focus)
      if (!f) return { error: `找不到特征「${focus}」` }
      const box = boxOfGroups(d, (g) => g.origin === focus)
      return box ? { box, name: displayName(doc.tree, f) } : { error: `「${displayName(doc.tree, f)}」生成的面现在都不在了（被后面的特征盖掉或切掉了），框不出来：换一个特征，或者用 at 回滚到它那一步看` }
    }
    if ("part" in focus) {
      const k = d.parts?.findIndex((p) => p.name === focus.part) ?? -1
      if (k >= 0) return { box: boxOfGroups(d, (g) => g.part === k)!, name: focus.part }
      const ref = d.refs?.find((r) => r.name === focus.part || r.id === focus.part)
      if (ref) return { box: meshBox(ref.mesh.vertices), name: ref.name }
      const names = [...(d.parts ?? []).map((p) => p.name), ...(d.refs ?? []).map((r) => r.name)]
      return { error: `没有叫「${focus.part}」的零件或参考体${names.length ? `：现在有 ${names.join("、")}` : ""}` }
    }
    const hashes = await this.opts.kernel.locate("face", focus.faces)
    if (!hashes?.length) return { error: `选择器什么都没选中：${JSON.stringify(focus.faces)}` }
    const set = new Set(hashes)
    const box = boxOfGroups(d, (g) => set.has(g.hash))
    return box ? { box, name: `${hashes.length} 个面` } : { error: "选中的面不在显示的这一步里（用了 at 时，focus.faces 按最新一步选）" }
  }

  private async show(doc: Doc, input: Record<string, unknown>): Promise<CommandResult> {
    if (this.active !== doc.path) {
      this.active = doc.path
      this.emitDoc(doc)
    }
    if (input.clear) {
      this.emit({ type: "show", request: { path: doc.path, clear: true } })
      return { ok: true, text: "已取消高亮。" }
    }
    const label = input.label as string | undefined
    if (input.feature) {
      const f = doc.tree.features.find((x) => x.id === input.feature)
      if (!f) return fail(`找不到特征「${input.feature}」`)
      this.emit({ type: "show", request: { path: doc.path, feature: f.id, label: label ?? displayName(doc.tree, f) } })
      return { ok: true, text: `已在窗口里高亮「${displayName(doc.tree, f)}」。` }
    }
    const kind = input.faces ? "face" : input.edges ? "edge" : null
    if (!kind) return fail("写 feature、faces 或 edges 之一。")
    await this.ensureKernel(doc)
    const hashes = await this.opts.kernel.locate(kind, input.faces ?? input.edges)
    if (!hashes?.length) return fail("选择器什么都没选中。")
    this.emit({ type: "show", request: { path: doc.path, kind, hashes, label } })
    return { ok: true, text: `已在窗口里高亮 ${hashes.length} ${kind === "face" ? "个面" : "条边"}。` }
  }

  private async exportPart(doc: Doc, input: { path: string; format?: "step" | "stl" | "py" | "json" | "bom" }, ctx: CallContext): Promise<CommandResult> {
    let path = input.path.trim()
    if (!/^([A-Za-z]:)?[\\/]/.test(path) && ctx.cwd) path = `${ctx.cwd.replace(/[\\/]+$/, "")}/${path}`
    const ext = path.split(".").pop()?.toLowerCase()
    const format = input.format ?? (ext === "stp" ? "step" : ext === "md" ? "bom" : ext)
    if (format !== "step" && format !== "stl" && format !== "py" && format !== "json" && format !== "bom")
      return fail("不知道导出成什么：扩展名用 .step / .stl / .py / .json / .md（零件清单），或者写 format。")
    let data: string | Uint8Array | null
    if (format === "py") {
      if (isAssembly(doc.path)) return fail("装配不能导出成 build123d 代码：请分别打开每个零件导出")
      data = toBuild123d(this.effective(doc, doc.tree), { title: doc.name })
    } else if (format === "json") data = `${JSON.stringify(doc.tree, null, 2)}\n`
    else if (format === "bom") {
      const report = await this.ensureKernel(doc)
      data = bomText(doc, report)
    } else {
      const report = await this.ensureKernel(doc)
      data = await this.opts.kernel.exportBody(format)
      // Several parts: one STL each, zipped.
      if (format === "stl" && (report.parts?.length ?? 0) > 1 && !/\.zip$/i.test(path)) path = path.replace(/\.stl$/i, "") + ".zip"
    }
    if (!data) return fail("还没有实体可以导出。")
    await this.opts.files.write(path, data)
    const bytes = typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength
    const failed = format === "step" || format === "stl" ? doc.report?.features.filter((f) => f.state === "error").length : 0
    return { ok: true, text: `已导出 ${format.toUpperCase()} 到 ${path}（${(bytes / 1024).toFixed(1)} KB）${failed ? `。注意：有 ${failed} 个特征失败，导出的是最后一个成功的步骤` : ""}` }
  }

  // ------------------------------------------------------------------ picks

  private async requestPick(input: Record<string, unknown>, ctx: CallContext): Promise<CommandResult> {
    if (!this.opts.screen?.()) return fail("要请用户在 Arbor 窗口里点选：先打开 Arbor App。")
    const doc = await this.exclusive(() => this.resolveDoc(ctx))
    if (!doc) return fail("还没有打开零件：先用 open_part。")
    const prompt = String(input.prompt)
    if (this.late && this.late.path === doc.path && this.late.prompt === prompt) {
      const { answer } = this.late
      this.late = null
      return pickResult(answer)
    }
    if (this.active !== doc.path) {
      this.active = doc.path
      this.emitDoc(doc)
    }
    let p = this.pending
    if (!p || p.request.path !== doc.path || p.request.prompt !== prompt) {
      if (p) this.settlePick(null)
      p = this.pending = { request: { id: `pick-${Date.now().toString(36)}`, path: doc.path, prompt, kind: (input.kind as PickRequest["kind"]) ?? "any" }, waiters: [] }
      this.emit({ type: "pick", request: p.request })
    }
    const req = p
    const answer = await new Promise<PickAnswer | null | "timeout">((resolve) => {
      const waiter = (a: PickAnswer | null) => {
        clearTimeout(timer)
        resolve(a)
      }
      const timer = setTimeout(() => {
        req.waiters = req.waiters.filter((w) => w !== waiter)
        resolve("timeout")
      }, ((input.timeout_sec as number | undefined) ?? 120) * 1000)
      req.waiters.push(waiter)
    })
    if (answer === "timeout") return { ok: false, text: "用户还没点。请求还显示在窗口里：可以用同一句 prompt 再调用 request_pick 接着等，或者先做别的。" }
    if (!answer) return { ok: false, text: "用户取消了点选。" }
    return pickResult(answer)
  }

  /** The person clicked (or cancelled) in the window. */
  answerPick(id: string, answer: PickAnswer | null) {
    const p = this.pending
    if (!p || p.request.id !== id) return
    if (answer && !p.waiters.length) this.late = { path: p.request.path, prompt: p.request.prompt, answer }
    this.settlePick(answer)
  }

  private settlePick(answer: PickAnswer | null) {
    const p = this.pending
    if (!p) return
    this.pending = null
    for (const w of p.waiters) w(answer)
    this.emit({ type: "pick", request: null })
  }

  // ----------------------------------------------------------------- agent

  /** What changed under the agent since its last call: told first, so it doesn't undo the person's edits. */
  private noticeFor(doc: Doc, skipNewNotes = false) {
    const theirs = doc.changes.filter((c) => c.actor !== "agent" && (c.seq ?? 0) > doc.agentSeq).reverse()
    const tree = theirs.filter((c) => !c.note)
    // New notes get their own line below; what happened to existing ones (handled, removed) goes here.
    const notes = theirs.filter((c) => c.note === "changed")
    const fresh = skipNewNotes ? [] : doc.notes.notes.filter((n) => n.status === "open" && n.n > doc.agentNoteN)
    const lines: string[] = []
    if (tree.length) {
      lines.push(`⚠ 自你上次调用以来，模型被改过（以现在的状态为准，不要改回去）：`)
      for (const c of tree.slice(-8)) lines.push(`- ${c.actor === "user" ? "用户在窗口里" : "文件被直接修改"}：${c.summary}`)
      lines.push(`现在是第 ${doc.rev} 版。`)
    }
    if (notes.length) lines.push(`备注有变化：${notes.slice(-6).map((c) => `用户${c.summary}`).join("；")}。`)
    if (fresh.length) lines.push(`◆ 用户在窗口里留了 ${fresh.length} 条新备注：${fresh.map((n) => `${n.id}「${clip(n.text)}」`).join("、")}。用 get_notes 读详情。`)
    return lines.join("\n")
  }

  /** The agent has seen the part as it is now. */
  private markSeen(doc: Doc) {
    doc.agentSeq = doc.seq
    doc.agentNoteN = Math.max(doc.agentNoteN, ...doc.notes.notes.map((n) => n.n))
  }

  dispose() {
    for (const d of this.docs.values()) {
      d.unwatch()
      for (const stop of d.assetWatch.values()) stop()
    }
    this.settlePick(null)
  }
}

function pickResult(answer: PickAnswer): CommandResult {
  const lines = ["用户在窗口里点了：", ...pickLines({ ...answer.info, point: answer.info.point as V3 })]
  if (answer.text?.trim()) lines.push(`- 用户补充：${answer.text.trim()}`)
  return { ok: true, text: lines.join("\n") }
}

/** The parts list: one row per part file (a component used twice counts 2), with volume and size. */
function bomText(doc: Doc, report: BuildReport) {
  const asm = isAssembly(doc.path)
  const fileOf = new Map<string, string>()
  for (const f of doc.tree.features) if (f.op === "component") fileOf.set(f.name ?? partName(f.file).replace(/\.(step|stp)$/i, ""), f.file)
  const parts = report.parts ?? (report.body ? [{ name: doc.name, volume: report.body.volume, size: report.body.size }] : [])
  const rows = new Map<string, { name: string; file: string; count: number; volume: number; size: number[] }>()
  for (const p of parts) {
    const comp = p.name.split("/")[0]
    const file = asm ? (fileOf.get(comp) ?? "") : doc.path.split(/[\\/]/).pop()!
    const key = asm ? `${file}|${p.name.slice(comp.length)}` : p.name
    const row = rows.get(key)
    if (row) row.count += 1
    else rows.set(key, { name: p.name, file, count: 1, volume: p.volume, size: p.size })
  }
  const r1 = (x: number) => Math.round(x * 10) / 10
  const lines = [
    `# 零件清单：${doc.name}`,
    "",
    "| 序号 | 名称 | 文件 | 数量 | 单件体积 (cm³) | 外形 (mm) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...rows.values()].map((r, i) => `| ${i + 1} | ${r.name} | ${r.file} | ${r.count} | ${Math.round(r.volume / 10) / 100} | ${r.size.map(r1).join(" × ")} |`),
    "",
    `共 ${[...rows.values()].reduce((n, r) => n + r.count, 0)} 件。`,
    "",
  ]
  return lines.join("\n")
}

export function measureText(res: MeasureResult) {
  const KIND = { face: "面", edge: "边", feature: "特征", part: "零件" } as const
  const items = res.items.map((i, k) => `${res.items.length > 1 ? (k ? "B" : "A") + "：" : ""}${KIND[i.kind]} · ${i.what} · ${i.facts.join("，")}`)
  const between = res.between.map((b) => `${b.name}：${b.value}`)
  return [...items, ...between].join("\n")
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** Bounding box of a flat vertex array. */
function meshBox(v: Float32Array): Box {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], v[i + a])
      hi[a] = Math.max(hi[a], v[i + a])
    }
  return [lo, hi]
}

/** All reference bodies together (when there is no solid yet). */
function refsBox(d: DisplayData): Box | null {
  if (!d.refs?.length) return null
  const boxes = d.refs.map((r) => meshBox(r.mesh.vertices))
  return [[0, 1, 2].map((a) => Math.min(...boxes.map((b) => b[0][a]))), [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b[1][a])))] as Box
}

/** A file an `import` names, relative to the part's folder (or absolute). */
export function assetPath(dir: string, file: string) {
  const f = file.trim().replace(/\\/g, "/")
  return /^([A-Za-z]:)?\//.test(f) ? f : `${dir.replace(/[\\/]+$/, "")}/${f.replace(/^\.\//, "")}`
}
