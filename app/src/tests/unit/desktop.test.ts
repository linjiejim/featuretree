import { beforeAll, describe, expect, it } from "vitest"
import { initNodeKernel } from "@/studio/kernel/node"
import { agentCommands, COMMANDS, inputJsonSchema } from "@/desktop/core/catalog"
import { DirectKernel } from "@/desktop/core/direct-kernel"
import { Engine, normalizePartPath, notesPath, partName, type Screen } from "@/desktop/core/engine"
import type { CallContext, EngineEvent, PickInfo } from "@/desktop/core/protocol"
import { describeTreeChange } from "@/desktop/core/tree-diff"
import { memFiles } from "./mem-files"

/** A 60 × 40 × 10 block standing on XY, as a STEP file: the kernel's own export plays a vendor's board model. */
async function boardStep(w = 60, d = 40, h = 10) {
  const k = new DirectKernel()
  await k.rebuild({
    params: {},
    features: [
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "rect", w, h: d }] },
      { id: "e", op: "extrude", sketch: "s", distance: h },
    ],
  })
  const bytes = (await k.exportBody("step"))!
  k.dispose()
  return bytes
}

const AGENT: CallContext = { actor: "agent", session: "s1", cwd: "/work" }
const USER: CallContext = { actor: "user" }
const PART = "/work/box.arbor.json"

async function boxEngine(screen?: Screen) {
  const mem = memFiles()
  const events: EngineEvent[] = []
  const engine = new Engine({ kernel: new DirectKernel(), files: mem.files, screen: screen ? () => screen : undefined })
  engine.on((e) => events.push(e))
  const run = (name: string, input: unknown, ctx = AGENT) => engine.run(name, input, ctx)
  expect((await run("open_part", { path: "box", create: true })).ok).toBe(true)
  await run("set_params", { set: { L: 80, W: 50, H: 30, d: 8 } })
  await run("sketch", { id: "sk1", on: { plane: "XY" }, shapes: [{ type: "rect", w: "L", h: "W" }] })
  await run("extrude", { id: "ex1", sketch: "sk1", distance: "H" })
  const hole = await run("hole", { id: "h1", on: { plane: "XY", face: { normal: "+Z", extreme: "+Z" } }, at: [[0, 0]], d: "d" })
  expect(hole.ok, hole.text).toBe(true)
  return { engine, run, events, ...mem }
}

beforeAll(async () => {
  await initNodeKernel()
}, 60_000)

describe("arbor: paths and catalog", () => {
  it("normalizes part paths and derives names", () => {
    expect(normalizePartPath("parts/box", "/work")).toBe("/work/parts/box.arbor.json")
    expect(normalizePartPath("/abs/x.json")).toBe("/abs/x.json")
    // `..` is left to the file system: after a symlinked folder it means the target's parent.
    expect(normalizePartPath("./parts/../box", "/work/")).toBe("/work/parts/../box.arbor.json")
    expect(normalizePartPath("/work//a/./b.json")).toBe("/work/a/b.json")
    expect(partName("/a/b/lid.arbor.json")).toBe("lid")
    expect(notesPath("/a/lid.arbor.json")).toBe("/a/lid.notes.json")
  })

  it("turns every command's input into a JSON schema, and keeps window-only commands from agents", () => {
    for (const c of COMMANDS) expect(inputJsonSchema(c).type).toBe("object")
    const names = agentCommands().map((c) => c.name)
    expect(names).toContain("extrude")
    expect(names).toContain("request_pick")
    expect(names).not.toContain("add_note")
    expect(names).not.toContain("look-in-browser")
  })

  it("says how a tree changed in one line", () => {
    const a = { params: { W: 40 }, features: [{ id: "f1", op: "fillet" as const, name: "圆角", edges: {}, r: 2 }] }
    const b = { params: { W: 45, t: 2 }, features: [{ ...a.features[0], r: 3 }] }
    expect(describeTreeChange(a, b)).toBe("参数 W 40 → 45、+t = 2；改了 「圆角」（f1） 的 r")
  })
})

describe("arbor: the engine", () => {
  it("builds through tools, writes the file, and reports state", async () => {
    const { run, disk } = await boxEngine()
    const text = disk.get(PART) as string
    expect(JSON.parse(text).features.map((f: { id: string }) => f.id)).toEqual(["sk1", "ex1", "h1"])
    const state = await run("get_state", {})
    expect(state.text).toContain("80 × 50 × 30")
    expect(state.text).toContain("第 4 版")
  }, 30_000)

  it("keeps requirements on the part (the site's checklist), measured by the kernel on every rebuild", async () => {
    const { engine, run, disk } = await boxEngine()
    await run("check", {
      items: [
        { id: "size", said: "80×50×30", kind: "size", expect: [80, 50, 30] },
        { id: "hole", said: "⌀8 通孔", kind: "holes", faces: { kind: "cylinder" }, count: 1, d: 8 },
      ],
    })
    expect(JSON.parse(disk.get(PART) as string).checks).toHaveLength(2)
    expect(engine.docState(PART)!.report!.checks!.every((c) => c.pass)).toBe(true)
    // The person makes the box taller: the requirement is re-measured and no longer holds.
    await engine.run("set_params", { set: { H: 31 } }, USER)
    const size = engine.docState(PART)!.report!.checks!.find((c) => c.id === "size")!
    expect(size).toMatchObject({ pass: false, actual: "80 × 50 × 31" })
    const m = await run("measure", { a: { face: { normal: "+Z", extreme: "+Z" } }, b: { face: { normal: "-Z" } } })
    expect(m.text).toContain("平行面间距：31 mm")
  }, 30_000)

  it("tells the agent what the person and the file changed since its last call", async () => {
    const { engine, run, touch, disk } = await boxEngine()
    await engine.run("set_params", { set: { H: 40 } }, USER)
    const r1 = await run("inspect", { what: "body" })
    expect(r1.text).toMatch(/用户在窗口里：参数 H 30 → 40/)
    const again = await run("inspect", { what: "body" })
    expect(again.text).not.toContain("自你上次调用以来")

    const tree = JSON.parse(disk.get(PART) as string)
    tree.params.L = 100
    await touch(PART, JSON.stringify(tree))
    const r2 = await run("inspect", { what: "body" })
    expect(r2.text).toMatch(/文件被直接修改：参数 L 80 → 100/)
    expect(r2.text).toContain("100 × 50 × 40")
    // The engine doesn't write a file someone else just saved.
    expect(disk.get(PART)).toBe(JSON.stringify(tree))

    await touch(PART, "{ not json")
    await run("get_state", {})
    const s = engine.docState(PART)!
    expect(s.error).toMatch(/JSON/)
    expect(s.tree.params.L).toBe(100)
  }, 30_000)

  it("catches up with a save the watcher hasn't reported yet before running a command", async () => {
    const { run, disk } = await boxEngine()
    // Saved a moment ago, before the (debounced) watcher fired: the next command builds on it.
    const tree = JSON.parse(disk.get(PART) as string)
    tree.params.W = 60
    disk.set(PART, JSON.stringify(tree))
    const r = await run("set_params", { set: { H: 40 } })
    expect(r.text).toMatch(/文件被直接修改：参数 W 50 → 60/)
    expect(JSON.parse(disk.get(PART) as string).params).toMatchObject({ W: 60, H: 40 })
  }, 30_000)

  it("yields to a save made while a command runs: the file wins, the command's change is one undo away", async () => {
    const mem = memFiles()
    const direct = new DirectKernel()
    let during: (() => void) | null = null
    // The editor's save lands while the kernel rebuilds: after the command read the file, before it writes.
    const kernel = Object.assign(Object.create(direct) as DirectKernel, {
      rebuild: async (t: Parameters<DirectKernel["rebuild"]>[0]) => {
        during?.()
        during = null
        return direct.rebuild(t)
      },
    })
    const engine = new Engine({ kernel, files: mem.files })
    const run = (name: string, input: unknown) => engine.run(name, input, AGENT)
    await run("open_part", { path: "box", create: true })
    await run("set_params", { set: { L: 80, t: 2 } })
    const theirs = { params: { L: 120, t: 2 }, features: [] }
    during = () => mem.disk.set(PART, JSON.stringify(theirs))
    const c = await run("set_params", { set: { t: 3 } })
    expect(c.ok).toBe(false)
    expect(c.text).toMatch(/文件被别人保存过/)
    expect(JSON.parse(mem.disk.get(PART) as string)).toEqual(theirs)
    expect(engine.docState(PART)!.tree.params).toEqual(theirs.params)
    await run("undo", {})
    expect(engine.docState(PART)!.tree.params).toEqual({ L: 80, t: 3 })
  }, 30_000)

  it("treats one file reached by different paths as one part", async () => {
    const { engine, run } = await boxEngine()
    await run("open_part", { path: "parts/../box.arbor.json" })
    expect(engine.snapshot().parts).toHaveLength(1)
  }, 30_000)

  it("undoes and redoes whoever made the change, and refuses a stale whole-tree write", async () => {
    const { engine, run } = await boxEngine()
    await engine.run("delete_feature", { id: "h1" }, USER)
    expect(engine.docState()!.tree.features).toHaveLength(2)
    const u = await run("undo", {})
    expect(u.text).toMatch(/已撤销：删了 「.+」（h1）/)
    expect(engine.docState()!.tree.features).toHaveLength(3)
    await run("redo", {})
    expect(engine.docState()!.tree.features).toHaveLength(2)
    const rev = engine.docState()!.rev
    const stale = await run("set_tree", { tree: { params: {}, features: [] }, base_rev: rev - 1 })
    expect(stale.ok).toBe(false)
    expect((await run("set_tree", { tree: { params: {}, features: [] }, base_rev: rev })).ok).toBe(true)
  }, 30_000)

  it("keeps notes the person pins, hands them to the agent with a verified selector", async () => {
    const { engine, run, disk } = await boxEngine()
    const [hash] = (await engine.kernelCall(PART, { op: "locate", kind: "face", selector: { normal: "+Z", extreme: "+Z" } })) as number[]
    const pick = (await engine.kernelCall(PART, { op: "pick", kind: "face", hash, point: [20, 10, 30] })) as PickInfo
    expect(pick.selector).toBeTruthy()
    await engine.run("add_note", { pick, text: "这里开一个 ⌀5 的孔" }, USER)
    expect(JSON.parse(disk.get("/work/box.notes.json") as string).notes).toHaveLength(1)

    const r = await run("inspect", { what: "body" })
    expect(r.text).toContain("◆ 用户在窗口里留了 1 条新备注：n1「这里开一个 ⌀5 的孔」")
    const notes = await run("get_notes", {})
    expect(notes.text).toContain("[备注 n1]")
    expect(notes.text).toContain("已验证只选中它的选择器")
    expect(notes.text).toContain("点击处的草图坐标 (20, 10)")
    await run("resolve_note", { id: "n1", reply: "已加 ⌀5 通孔" })
    expect(engine.docState()!.notes[0]).toMatchObject({ status: "resolved", reply: "已加 ⌀5 通孔" })
    expect((await run("get_notes", {})).text).toBe("没有未处理的备注。")

    // What the person does with notes shows in the activity list, and the agent hears about it.
    await engine.run("update_note", { id: "n1", status: "open" }, USER)
    const changes = engine.docState()!.changes.map((c) => `${c.actor}:${c.summary}`)
    expect(changes.slice(0, 3)).toEqual(["user:把备注 n1 标为未处理", "agent:处理完备注 n1：已加 ⌀5 通孔", "user:记下备注 n1「这里开一个 ⌀5 的孔」"])
    const told = await run("get_state", {})
    expect(told.text).toContain("备注有变化：用户把备注 n1 标为未处理")
    expect(told.text).not.toContain("模型被改过")
  }, 30_000)

  it("exports files, renders through the window, and waits for a pick", async () => {
    let asked: EngineEvent | undefined
    const screen: Screen = { look: async (req) => req.views.map((v) => `data:image/png;base64,${v}`) }
    const { engine, run, disk, events } = await boxEngine(screen)
    expect((await run("export", { path: "out/box.step" })).text).toMatch(/已导出 STEP/)
    expect((disk.get("/work/out/box.step") as Uint8Array).byteLength).toBeGreaterThan(1000)
    expect(disk.get("/work/out/box.py")).toBeUndefined()
    await run("export", { path: "box.py" })
    expect(disk.get("/work/box.py") as string).toContain("from build123d import")

    const look = await run("look", { views: ["iso", "top"] })
    expect(look.images).toHaveLength(2)

    const waiting = run("request_pick", { prompt: "点一下要开孔的面", kind: "face", timeout_sec: 5 })
    await new Promise((r) => setTimeout(r, 20))
    asked = events.findLast((e) => e.type === "pick")
    expect(asked && asked.type === "pick" && asked.request?.prompt).toBe("点一下要开孔的面")
    const [hash] = (await engine.kernelCall(PART, { op: "locate", kind: "face", selector: { normal: "-Y" } })) as number[]
    const info = (await engine.kernelCall(PART, { op: "pick", kind: "face", hash, point: [0, -25, 15] })) as PickInfo
    engine.answerPick((asked as Extract<EngineEvent, { type: "pick" }>).request!.id, { info, text: "前面这块" })
    const res = await waiting
    expect(res.ok).toBe(true)
    expect(res.text).toContain("朝前（-Y）")
    expect(res.text).toContain("用户补充：前面这块")
  }, 30_000)

  it("refuses look without a window, and window-only commands from the agent", async () => {
    const { run } = await boxEngine()
    expect((await run("look", {})).text).toMatch(/先打开 Arbor App/)
    expect((await run("add_note", { pick: {}, text: "x" })).text).toMatch(/没有这个命令/)
  }, 30_000)
})

describe("arbor: importing STEP", () => {
  const CASE = "/work/case.arbor.json"

  /** An open-top case around the board: inside 61 × 41, floor at z = 0, walls t. The board sits 1 mm up. */
  async function caseEngine() {
    const mem = memFiles()
    await mem.files.write("/work/vendor/board.step", await boardStep())
    const engine = new Engine({ kernel: new DirectKernel(), files: mem.files })
    const run = (name: string, input: unknown) => engine.run(name, input, AGENT)
    await run("open_part", { path: "case", create: true })
    const imp = await run("import", { id: "board", name: "开发板", file: "vendor/board.step", at: [0, 0, 1] })
    expect(imp.ok, imp.text).toBe(true)
    expect(imp.text).toContain("参考体 vendor/board.step · 60 × 40 × 10")
    await run("set_params", { set: { gap: 0.5, t: 2, W: "60 + 2*gap + 2*t", D: "40 + 2*gap + 2*t" } })
    await run("sketch", { id: "s", on: { plane: "XY", offset: "-t" }, shapes: [{ type: "rect", w: "W", h: "D" }] })
    await run("extrude", { id: "e", sketch: "s", distance: "14 + t" })
    const shell = await run("shell", { id: "sh", open: { normal: "+Z", extreme: "+Z" }, t: "t" })
    expect(shell.ok, shell.text).toBe(true)
    return { engine, run, ...mem }
  }

  it("brings a board in as a reference body and checks the fit against it", async () => {
    const { engine, run } = await caseEngine()
    await run("check", {
      items: [
        { id: "gap", said: "四周留 0.5", kind: "clearance", ref: "board", min: 0.5 },
        { id: "fit", said: "不能碰到板", kind: "interference", ref: "board" },
      ],
    })
    const report = engine.docState(CASE)!.report!
    expect(report.refs).toEqual([{ id: "board", name: "开发板", size: [60, 40, 10] }])
    expect(report.checks!.map((c) => [c.id, c.pass, c.actual])).toEqual([
      ["gap", true, "最小间隙 0.5 mm"],
      ["fit", true, "最小间隙 0.5 mm"],
    ])
    // The board is shown, the case is what's exported.
    const display = (await engine.kernelCall(CASE, { op: "display" })) as { refs?: unknown[]; mesh: unknown }
    expect(display.refs).toHaveLength(1)
    expect(display.mesh).toBeTruthy()
    expect(engine.docState(CASE)!.report!.body!.size).toEqual([65, 45, 16])

    // A cavity too small for the board: they overlap, and the checks say by how much.
    await engine.run("set_params", { set: { gap: -1 } }, USER)
    const after = engine.docState(CASE)!.report!.checks!
    expect(after.every((c) => !c.pass)).toBe(true)
    expect(after[1].actual).toMatch(/^相交 [\d.]+ mm³$/)
  }, 60_000)

  it("cuts a pocket with an imported shape, and rebuilds when the file changes", async () => {
    const { engine, run, touch } = await caseEngine()
    const before = engine.docState(CASE)!.report!.body!.volume
    // A connector-sized block poking through the front wall, subtracted.
    await touch("/work/vendor/usb.step", await boardStep(9, 8, 3.5))
    const cut = await run("import", { id: "usb", file: "vendor/usb.step", mode: "cut", at: [0, -22, 4] })
    expect(cut.ok, cut.text).toBe(true)
    expect(engine.docState(CASE)!.report!.body!.volume).toBeLessThan(before)

    // A new version of the board file: rebuilt without anyone touching the tree.
    const rev = engine.docState(CASE)!.rev
    await touch("/work/vendor/board.step", await boardStep(70, 40, 10))
    await run("get_state", {})
    const s = engine.docState(CASE)!
    expect(s.rev).toBe(rev + 1)
    expect(s.changes[0]).toMatchObject({ actor: "file", summary: "board.step 更新了，已重建" })
    expect(s.report!.refs![0].size).toEqual([70, 40, 10])
  }, 60_000)

  it("lets the agent see a reference body before there is any part: where it is, and its own faces", async () => {
    const mem = memFiles()
    await mem.files.write("/work/board.step", await boardStep())
    const engine = new Engine({ kernel: new DirectKernel(), files: mem.files })
    const run = (name: string, input: unknown) => engine.run(name, input, AGENT)
    await run("open_part", { path: "case", create: true })
    await run("import", { id: "board", file: "board.step", at: [0, 0, 3] })
    const body = await run("inspect", { what: "body" })
    expect(body.text).toContain("参考体 board（导入1）：包围盒 X -30…30，Y -20…20，Z 3…13")
    const faces = await run("inspect", { what: "faces", faces: { of: "board", normal: "-Y" } })
    expect(faces.text).toMatch(/法向 -Y 中心\(0, -20, 8\) 来自 board/)
  }, 60_000)

  it("cuts every split part an imported solid reaches: what's exported is what's reported", async () => {
    const k = new DirectKernel()
    await k.setAssets([{ name: "cutter.step", bytes: await boardStep(20, 20, 20) }])
    const cube = [
      { id: "s", op: "sketch" as const, on: { plane: "XY" as const }, shapes: [{ type: "rect" as const, w: 20, h: 20 }] },
      { id: "e", op: "extrude" as const, sketch: "s", distance: 20 },
      { id: "sp", op: "split" as const, by: { plane: "XY" as const, offset: 10 }, parts: ["low", "high"] },
    ]
    // The right half of both parts goes.
    const r = await k.rebuild({ params: {}, features: [...cube, { id: "c", op: "import", file: "cutter.step", mode: "cut", at: [10, 0, 0] }] })
    expect(r.features.at(-1)!.state).toBe("ok")
    expect(r.body!.volume).toBeCloseTo(4000, 3)
    expect(r.parts!.map((p) => p.volume)).toEqual([2000, 2000])
    const exported = (await k.exportBody("step"))!
    const again = new DirectKernel()
    await again.setAssets([{ name: "x.step", bytes: exported }])
    const back = await again.rebuild({ params: {}, features: [{ id: "i", op: "import", file: "x.step", mode: "add" }] })
    expect(back.body!.volume).toBeCloseTo(4000, 3)
    // Adding an imported solid after a split: it must land on one part, as any added material.
    const add = await k.rebuild({ params: {}, features: [...cube, { id: "a", op: "import", file: "cutter.step", mode: "add", at: [0, 0, 20] }] })
    expect(add.features.at(-1)!).toMatchObject({ state: "ok", summary: expect.stringContaining("high") })
    k.dispose()
    again.dispose()
  }, 60_000)

  it("tells what's wrong with a missing file, and that the site can't read files at all", async () => {
    const { run } = await caseEngine()
    const missing = await run("import", { id: "nope", file: "nope.step" })
    expect(missing.text).toMatch(/找不到 \/work\/nope\.step/)
    const web = new DirectKernel()
    const r = await web.rebuild({ params: {}, features: [{ id: "i", op: "import", file: "board.step" }] })
    expect(r.features[0].message).toMatch(/只能在桌面版 Arbor 里用/)
    web.dispose()
  }, 60_000)
})
