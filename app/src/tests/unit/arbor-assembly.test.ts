// Arbor, part two of the agent-modelling spec (docs/specs/2026-11-07-arbor-agent-modeling.md):
// new parts in one file, shared parameter files, assemblies of part files, editing a part
// inside its assembly, and what an assembly exports.
import { beforeAll, describe, expect, it, vi } from "vitest"
import { DirectKernel } from "@/desktop/core/direct-kernel"
import { Engine } from "@/desktop/core/engine"
import type { CallContext } from "@/desktop/core/protocol"
import { toBuild123d } from "@/studio/codegen"
import type { Tree } from "@/studio/dsl"
import { Kernel } from "@/studio/kernel/build"
import { initNodeKernel } from "@/studio/kernel/node"
import { memFiles } from "./mem-files"

const AGENT: CallContext = { actor: "agent", session: "s1", cwd: "/work" }

beforeAll(async () => {
  await initNodeKernel()
}, 60_000)

const box = (w: number, h: number, d: number, extra: Record<string, unknown> = {}) => [
  { id: "sk", op: "sketch" as const, on: { plane: "XY" as const }, shapes: [{ type: "rect" as const, w, h }] },
  { id: "box", op: "extrude" as const, sketch: "sk", distance: d, ...extra },
]

describe("new parts in one file", () => {
  it("adds material under a new name as a part of its own; the first addition names the body", () => {
    const k = new Kernel()
    const tree: Tree = {
      params: {},
      features: [
        ...box(80, 50, 30, { part: "盒体" }),
        { id: "ls", op: "sketch", on: { plane: "XY", offset: 30 }, shapes: [{ type: "rect", w: 80, h: 50 }] },
        { id: "lid", op: "extrude", sketch: "ls", distance: 3, part: "盖板" },
        { id: "ks", op: "sketch", on: { plane: "XY", offset: 33 }, shapes: [{ type: "circle", d: 6, center: [20, 0] }] },
        { id: "knob", op: "extrude", sketch: "ks", distance: 4, part: "盖板" },
        { id: "pat", op: "linear_pattern", features: ["knob"], dir: "-X", count: 2, spacing: 40 },
        { id: "h", op: "hole", on: { plane: "XY", offset: 33 }, at: [[0, 0]], d: 4, depth: 10 },
      ],
    }
    const rep = k.rebuild(tree)
    expect(rep.features.map((f) => f.state)).toEqual(Array(tree.features.length).fill("ok"))
    expect(rep.features[3].summary).toMatch(/新零件「盖板」$/)
    expect(rep.features[6].summary).toMatch(/盖板$/)
    // A hole without `part` goes through every part it reaches.
    expect(rep.features[7].summary).toMatch(/盒体、盖板/)
    expect(rep.parts?.map((p) => p.name)).toEqual(["盒体", "盖板"])
    expect(rep.parts?.[1].size).toEqual([80, 50, 7])
    // The bigger part stays, the lid moves up.
    const d = k.display()
    expect(d.parts?.[0].explode).toEqual([0, 0, 0])
    expect(d.parts?.[1].explode[2]).toBeGreaterThan(15)
    k.dispose()
  })

  it("calls an unnamed body 「主体」, warns when a new part overlaps, refuses until and unknown names", () => {
    const k = new Kernel()
    const base = box(40, 40, 20)
    let rep = k.rebuild({
      params: {},
      features: [...base, { id: "s2", op: "sketch", on: { plane: "XY", offset: 10 }, shapes: [{ type: "circle", d: 10 }] }, { id: "pin", op: "extrude", sketch: "s2", distance: 30, part: "销" }],
    })
    expect(rep.features[3].summary).toMatch(/新零件「销」；原来的实体叫作「主体」/)
    expect(rep.features[3].warnings?.join()).toMatch(/新零件「销」和「主体」重叠 785\.\d+ mm³/)
    rep = k.rebuild({ params: {}, features: [...base, { id: "s2", op: "sketch", on: { plane: "XY", offset: 30 }, shapes: [{ type: "circle", d: 10 }] }, { id: "pin", op: "extrude", sketch: "s2", until: "next", part: "销" }] })
    expect(rep.features[3].message).toMatch(/新建零件「销」时不能用 until/)
    rep = k.rebuild({ params: {}, features: [...base, { id: "f", op: "fillet", edges: { parallel: "Z" }, r: 2, part: "盖" }] })
    expect(rep.features[2].message).toMatch(/没有叫「盖」的零件/)
    k.dispose()
  })

  it("exports a new part to build123d as its own entry", () => {
    const code = toBuild123d({
      params: {},
      features: [...box(80, 50, 30), { id: "ls", op: "sketch", on: { plane: "XY", offset: 30 }, shapes: [{ type: "rect", w: 80, h: 50 }] }, { id: "lid", op: "extrude", sketch: "ls", distance: 3, part: "盖板" }],
    })
    expect(code).toMatch(/parts = \{"主体": part\}/)
    expect(code).toMatch(/parts\["盖板"\] = tool_lid/)
    expect(code).toMatch(/part = Compound\(list\(parts.values\(\)\)\)/)
  })
})

/** A pen-like assembly on an in-memory disk: shared diameter and length, a barrel and a cap. */
async function penWorkspace() {
  const mem = memFiles()
  const engine = new Engine({ kernel: new DirectKernel(), files: mem.files })
  const run = (name: string, input: unknown) => engine.run(name, input, AGENT)
  await mem.files.write("/work/pen.params.json", JSON.stringify({ params: { D: 10, L: 60 }, paramNotes: { D: "笔杆直径" } }))
  const barrel: Tree = {
    uses: "../pen.params.json",
    params: {},
    features: [
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: "D" }] },
      { id: "e", op: "extrude", sketch: "s", distance: "L" },
    ],
  }
  const cap: Tree = {
    uses: "../pen.params.json",
    params: { t: 1 },
    features: [
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: "D+2*t" }] },
      { id: "e", op: "extrude", sketch: "s", distance: 20 },
    ],
  }
  await mem.files.write("/work/parts/barrel.arbor.json", JSON.stringify(barrel))
  await mem.files.write("/work/parts/cap.arbor.json", JSON.stringify(cap))
  const open = await run("open_part", { path: "pen.arbor-asm.json", create: true })
  expect(open.ok, open.text).toBe(true)
  expect(open.text).toMatch(/已新建装配/)
  const sp = await run("share_params", { file: "pen.params.json" })
  expect(sp.ok, sp.text).toBe(true)
  const c1 = await run("component", { id: "barrel", name: "笔杆", file: "parts/barrel.arbor.json" })
  expect(c1.ok, c1.text).toBe(true)
  const c2 = await run("component", { id: "cap", name: "笔帽", file: "parts/cap.arbor.json", at: [0, 0, "L"] })
  expect(c2.ok, c2.text).toBe(true)
  return { engine, run, ...mem }
}

describe("shared parameters and assemblies", () => {
  it("places part files in an assembly, checks how they meet, and follows a shared parameter", async () => {
    const { run, disk } = await penWorkspace()
    let st = await run("get_state", {})
    expect(st.text).toMatch(/装配：\/work\/pen\.arbor-asm\.json/)
    expect(st.text).toMatch(/零件：笔杆（10×10×60）、笔帽（12×12×20）/)
    const chk = await run("check", {
      items: [
        { id: "size", said: "总长 80", kind: "size", expect: [12, 12, 80] },
        { id: "seat", said: "笔帽压在笔杆上", kind: "gap", a: { part: "笔帽" }, b: { part: "笔杆" }, max: 0 },
        { id: "no", said: "笔帽和笔杆不相交", kind: "interference", ref: "笔帽" },
      ],
    })
    expect(chk.text).toMatch(/✓[^\n]*总长 80/)
    expect(chk.text).toMatch(/✓[^\n]*笔帽压在笔杆上/)
    expect(chk.text).toMatch(/✓[^\n]*笔帽和笔杆不相交/)
    // A shared parameter changed from the assembly: the file changes, the parts follow.
    const set = await run("set_params", { set: { L: 70 } })
    expect(set.ok, set.text).toBe(true)
    expect(set.text).toMatch(/共享参数（pen\.params\.json）：L = 70/)
    expect(JSON.parse(disk.get("/work/pen.params.json") as string).params.L).toBe(70)
    st = await run("get_state", {})
    expect(st.text).toMatch(/笔杆（10×10×70）/)
    const chk2 = await run("check", {})
    expect(chk2.text).toMatch(/✗[^\n]*总长 80[^\n]*12 × 12 × 90/)
  })

  it("rebuilds when a part file changes on disk, and exports a BOM, a STEP and a zip of STLs", async () => {
    const { run, touch, disk } = await penWorkspace()
    const cap = JSON.parse(disk.get("/work/parts/cap.arbor.json") as string) as Tree
    cap.features[1] = { ...cap.features[1], distance: 25 } as Tree["features"][number]
    await touch("/work/parts/cap.arbor.json", JSON.stringify(cap))
    const st = await run("get_state", {})
    expect(st.text).toMatch(/笔帽（12×12×25）/)
    expect(st.text).toMatch(/cap\.arbor\.json 更新了，已重建/)
    const bom = await run("export", { path: "pen-bom.md" })
    expect(bom.ok, bom.text).toBe(true)
    const md = disk.get("/work/pen-bom.md") as string
    expect(md).toMatch(/\| 1 \| 笔杆 \| parts\/barrel\.arbor\.json \| 1 \| 4\.71 \| 10 × 10 × 60 \|/)
    expect(md).toMatch(/共 2 件/)
    const step = await run("export", { path: "pen.step" })
    expect(step.ok, step.text).toBe(true)
    const text = new TextDecoder().decode(disk.get("/work/pen.step") as Uint8Array)
    expect(text.match(/PRODUCT\(/g)?.length).toBeGreaterThanOrEqual(2)
    const stl = await run("export", { path: "pen.stl" })
    expect(stl.text).toMatch(/pen\.zip/)
    expect(disk.has("/work/pen.zip")).toBe(true)
    const py = await run("export", { path: "pen.py" })
    expect(py.text).toMatch(/装配不能导出成 build123d 代码/)
  })

  it("edits a part inside its assembly: the others show around it, and checks can name them", async () => {
    const { run } = await penWorkspace()
    const open = await run("open_part", { path: "parts/barrel.arbor.json", context: "pen.arbor-asm.json" })
    expect(open.ok, open.text).toBe(true)
    expect(open.text).toMatch(/在装配「pen」里编辑：装配里的其他零件（笔帽）/)
    const st = await run("get_state", {})
    expect(st.text).toMatch(/共享参数文件：\.\.\/pen\.params\.json（D、L）/)
    const chk = await run("check", { items: [{ id: "top", said: "笔杆顶面贴着笔帽", kind: "gap", a: { face: { normal: "+Z" } }, b: { part: "笔帽" }, max: 0 }] })
    expect(chk.text).toMatch(/✓[^\n]*笔杆顶面贴着笔帽/)
    const m = await run("measure", { a: { part: "笔帽" } })
    expect(m.text).toMatch(/参考体「笔帽」 · 外形 12×12×20/)
    // Out of the assembly again.
    const out = await run("open_part", { path: "parts/barrel.arbor.json" })
    expect(out.text).not.toMatch(/在装配/)
    const bad = await run("open_part", { path: "parts/barrel.arbor.json", context: "nothing.arbor-asm.json" })
    expect(bad.ok).toBe(false)
  })

  it("keeps assemblies and parts apart, refuses cycles, and uses the last good shape of a failing part", async () => {
    const { run, files } = await penWorkspace()
    const ext = await run("sketch", { id: "x", on: { plane: "XY" }, shapes: [{ type: "circle", d: 2 }] })
    expect(ext.text).toMatch(/装配里只能放零件/)
    await run("open_part", { path: "parts/barrel.arbor.json" })
    const comp = await run("component", { id: "c", file: "cap.arbor.json" })
    expect(comp.text).toMatch(/零件文件里不能放 component/)
    // A sub-assembly that contains the assembly that contains it.
    await files.write("/work/sub.arbor-asm.json", JSON.stringify({ params: {}, features: [{ id: "back", op: "component", file: "pen.arbor-asm.json" }] }))
    await run("open_part", { path: "pen.arbor-asm.json" })
    const loop = await run("component", { id: "sub", file: "sub.arbor-asm.json" })
    expect(loop.text).toMatch(/循环引用：pen\.arbor-asm\.json → sub\.arbor-asm\.json → pen\.arbor-asm\.json/)
    await run("delete_feature", { id: "sub" })
    // A part with a failing fillet still shows, as it was before the fillet.
    await run("open_part", { path: "parts/barrel.arbor.json" })
    await run("fillet", { id: "f", edges: { kind: "circle", extreme: "+Z" }, r: 50 })
    await run("open_part", { path: "pen.arbor-asm.json" })
    const st = await run("get_state", {})
    expect(st.text).toMatch(/零件「笔杆」有 1 个特征失败，用的是失败前的形状/)
  })

  it("writes shared parameters onto the file as it is now, lets own parameters use them, and stops keeping the values in use", async () => {
    const { run, files, disk } = await penWorkspace()
    // Someone edits the shared file; before the watcher fires, the agent sets another shared parameter.
    await files.write("/work/pen.params.json", JSON.stringify({ params: { D: 10, L: 30 } }))
    const set = await run("set_params", { set: { D: 12 } })
    expect(set.ok, set.text).toBe(true)
    expect(JSON.parse(disk.get("/work/pen.params.json") as string).params).toEqual({ D: 12, L: 30 })
    await run("open_part", { path: "parts/cap.arbor.json" })
    const own = await run("set_params", { set: { R: "D/2" } })
    expect(own.ok, own.text).toBe(true)
    const saved = JSON.parse(disk.get("/work/parts/cap.arbor.json") as string)
    expect(saved.params).toEqual({ t: 1, R: "D/2" })
    // An own parameter the shared file overrides: stopping keeps the shared value that was in use.
    await run("set_params", { set: { t: 1 } })
    disk.set("/work/parts/cap.arbor.json", JSON.stringify({ ...saved, params: { ...saved.params, D: 5 } }))
    await files.write("/work/parts/cap.arbor.json", disk.get("/work/parts/cap.arbor.json") as string)
    await run("get_state", {})
    const stop = await run("share_params", { stop: true })
    expect(stop.ok, stop.text).toBe(true)
    expect(JSON.parse(disk.get("/work/parts/cap.arbor.json") as string).params.D).toBe(12)
  })

  it("leaves a shadowed own parameter alone on other edits, and won't write a shared file that no longer resolves", async () => {
    const { run, files, disk } = await penWorkspace()
    await run("open_part", { path: "parts/cap.arbor.json" })
    const cap = JSON.parse(disk.get("/work/parts/cap.arbor.json") as string)
    await files.write("/work/parts/cap.arbor.json", JSON.stringify({ ...cap, params: { ...cap.params, D: 5 }, paramNotes: { D: "自己的直径" } }))
    expect((await run("set_params", { set: { R: "D/2" } })).ok).toBe(true)
    const saved = JSON.parse(disk.get("/work/parts/cap.arbor.json") as string)
    expect(saved.params.D).toBe(5)
    expect(saved.paramNotes.D).toBe("自己的直径")
    // The shared file changed on disk to depend on D; removing D would leave L unresolvable.
    await files.write("/work/pen.params.json", JSON.stringify({ params: { D: 10, L: "D*6" } }))
    const bad = await run("set_params", { remove: ["D"] })
    expect(bad.ok).toBe(false)
    expect(bad.text).toMatch(/共享参数不对，没有写入/)
    expect(JSON.parse(disk.get("/work/pen.params.json") as string).params).toEqual({ D: 10, L: "D*6" })
  })

  it("keeps a single component a named part: measured by name, hidden when asked", async () => {
    const mem = memFiles()
    const engine = new Engine({ kernel: new DirectKernel(), files: mem.files })
    const run = (name: string, input: unknown) => engine.run(name, input, AGENT)
    await mem.files.write("/work/block.arbor.json", JSON.stringify({ params: {}, features: box(10, 10, 10) }))
    await run("open_part", { path: "one.arbor-asm.json", create: true })
    await run("component", { id: "b", name: "块", file: "block.arbor.json", hidden: true })
    const m = await run("measure", { a: { part: "块" } })
    expect(m.text).toMatch(/零件「块」 · 体积 1000/)
    const k = new Kernel()
    k.setComponents([{ file: "block.arbor.json", tree: { params: {}, features: box(10, 10, 10) } }])
    k.rebuild({ params: {}, features: [{ id: "b", op: "component", name: "块", file: "block.arbor.json", hidden: true }] })
    expect(k.display().parts?.[0]).toMatchObject({ name: "块", hidden: true })
    k.dispose()
  })

  it("builds a component once while only another one changes", async () => {
    const { run, touch, disk } = await penWorkspace()
    const spy = vi.spyOn(Kernel.prototype, "rebuild")
    const cap = JSON.parse(disk.get("/work/parts/cap.arbor.json") as string) as Tree
    cap.params.t = 2
    await touch("/work/parts/cap.arbor.json", JSON.stringify(cap))
    await run("get_state", {})
    const built = spy.mock.calls.map(([t]) => (t.features[1] as { distance?: unknown })?.distance)
    spy.mockRestore()
    // The cap's tree was built again; the barrel's (distance "L") came from the cache.
    expect(built).toContain(20)
    expect(built).not.toContain("L")
  })
})
