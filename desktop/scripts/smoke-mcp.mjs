// Drives `arbor mcp` with the official MCP client, the way a coding agent
// does: list the tools, build a flange, check it, export it, read notes.
//
//   node scripts/smoke-mcp.mjs          headless (no window): every tool but look / request_pick
//   node scripts/smoke-mcp.mjs --app    through the running Arbor app (started if needed), look included
//
// Leaves the part in a temporary folder and prints where.
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const withApp = process.argv.includes("--app")
const work = await mkdtemp(path.join(os.tmpdir(), "arbor-smoke-"))

const transport = new StdioClientTransport({
  command: path.join(root, "bin/arbor"),
  args: ["mcp"],
  cwd: work,
  // Headless runs keep their recent-parts list out of ~/.arbor.
  env: { ...process.env, ...(withApp ? {} : { ARBOR_HEADLESS: "1", ARBOR_HOME: path.join(work, ".arbor") }) },
  stderr: "inherit",
})
const client = new Client({ name: "arbor-smoke", version: "0.0.0" })
await client.connect(transport)

let step = 0
async function call(name, args = {}) {
  const t0 = Date.now()
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  const images = res.content.filter((c) => c.type === "image")
  console.log(`\n[${++step}] ${name} ${res.isError ? "✗" : "✓"} (${Date.now() - t0} ms)\n${text.split("\n").slice(0, 8).join("\n")}`)
  return { ...res, text, images }
}

const { tools } = await client.listTools()
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`)
assert.ok(tools.length >= 30, "all agent commands are listed")
assert.ok(!tools.some((t) => t.name === "add_note"), "window-only commands stay hidden")
assert.match(client.getInstructions() ?? "", /Arbor/, "the server sends its guide as instructions")

const open = await call("open_part", { path: "parts/flange", create: true })
assert.ok(!open.isError)
assert.match(open.text, /parts\/flange\.arbor\.json/)

await call("set_params", { set: { D: 90, T: 10, d: 20, pcd: 70, hd: 8, n: 6 }, notes: { D: "外径", T: "厚", d: "中心孔", pcd: "螺栓孔分布圆", hd: "螺栓孔径", n: "螺栓孔数" } })
await call("sketch", { id: "sk1", name: "外圆", on: { plane: "XY" }, shapes: [{ type: "circle", d: "D" }] })
assert.ok(!(await call("extrude", { id: "body", name: "盘体", sketch: "sk1", distance: "T" })).isError)
const top = { plane: "XY", face: { normal: "+Z", extreme: "+Z" } }
assert.ok(!(await call("hole", { id: "bore", name: "中心孔", on: top, at: [[0, 0]], d: "d" })).isError)
assert.ok(!(await call("hole", { id: "bolt", name: "螺栓孔", on: top, at: [["pcd/2", 0]], d: "hd" })).isError)
assert.ok(!(await call("circular_pattern", { id: "bolts", name: "螺栓孔阵列", features: ["bolt"], axis: "Z", count: "n" })).isError)
// A mistake on purpose: the agent learns from the error and fixes it in place.
const bad = await call("fillet", { id: "f1", edges: { kind: "circle", extreme: "+Z", radius: 45 }, r: 20 })
assert.ok(bad.isError, "an impossible fillet is reported as an error")
assert.ok(!(await call("edit_feature", { id: "f1", changes: { r: 1 } })).isError)

// The requirements go onto the part (the site's checklist) and are measured by the kernel.
const check = await call("check", {
  items: [
    { id: "size", said: "⌀90 × 10", kind: "size", expect: [90, 90, 10] },
    { id: "bore", said: "中心孔 ⌀20", kind: "holes", faces: { kind: "cylinder", radius: 10 }, count: 1, d: 20 },
    { id: "bolts", said: "6 个 ⌀8 螺栓孔", kind: "holes", faces: { kind: "cylinder", radius: 4 }, count: 6, d: 8 },
    { id: "pcd", said: "均布在 ⌀70 上", kind: "pcd", faces: { kind: "cylinder", radius: 4 }, count: 6, expect: 70 },
  ],
})
assert.ok(!check.isError, check.text)
assert.ok(!check.text.includes("✗"), check.text)

const state = await call("get_state")
assert.match(state.text, /第 \d+ 版/)
await call("undo")
await call("redo")

const exp = await call("export", { path: "out/flange.step" })
assert.ok(!exp.isError)
assert.ok((await readFile(path.join(work, "out/flange.step"))).length > 1000)
await call("export", { path: "out/flange.py" })
assert.match(await readFile(path.join(work, "out/flange.py"), "utf8"), /from build123d import/)

// Someone edits the file directly (the agent's own editor, git…): the engine picks it up and says so.
const file = path.join(work, "parts/flange.arbor.json")
const tree = JSON.parse(await readFile(file, "utf8"))
tree.params.n = 8
await writeFile(file, JSON.stringify(tree, null, 2))
await new Promise((r) => setTimeout(r, 600))
const after = await call("inspect", { what: "body" })
assert.match(after.text, /文件被直接修改：参数 n 6 → 8/)

const notes = await call("get_notes")
assert.match(notes.text, /没有未处理的备注/)

if (withApp) {
  const look = await call("look", { views: ["iso", "top"] })
  assert.equal(look.images.length, 2, "look returns two pictures")
  for (const [i, img] of look.images.entries()) await writeFile(path.join(work, `look-${i}.png`), Buffer.from(img.data, "base64"))
  await call("show", { feature: "bolts", label: "螺栓孔阵列" })
} else {
  const look = await call("look")
  assert.ok(look.isError, "look needs the window")
}

// An assembly: two part files sharing a parameter file, placed and checked together.
assert.ok(!(await call("open_part", { path: "pen/barrel", create: true })).isError)
assert.ok(!(await call("share_params", { file: "pen.params.json", create: true })).isError)
assert.ok(!(await call("set_params", { set: { D: 10, L: 60 }, shared: true })).isError)
await call("sketch", { id: "s", on: { plane: "XY" }, shapes: [{ type: "circle", d: "D" }] })
assert.ok(!(await call("extrude", { id: "e", sketch: "s", distance: "L" })).isError)
assert.ok(!(await call("open_part", { path: "pen/cap", create: true })).isError)
assert.ok(!(await call("share_params", { file: "pen.params.json" })).isError)
await call("sketch", { id: "s", on: { plane: "XY" }, shapes: [{ type: "circle", d: "D+2" }] })
await call("extrude", { id: "e", sketch: "s", distance: 20 })
const asm = await call("open_part", { path: "pen/pen.arbor-asm.json", create: true })
assert.match(asm.text, /已新建装配/)
await call("share_params", { file: "pen.params.json" })
assert.ok(!(await call("component", { id: "barrel", name: "笔杆", file: "barrel.arbor.json" })).isError)
assert.ok(!(await call("component", { id: "cap", name: "笔帽", file: "cap.arbor.json", at: [0, 0, "L"] })).isError)
const fit = await call("check", { items: [{ id: "seat", said: "笔帽压在笔杆上", kind: "gap", a: { part: "笔帽" }, b: { part: "笔杆" }, max: 0 }] })
assert.ok(!fit.text.includes("✗"), fit.text)
const longer = await call("set_params", { set: { L: 70 } })
assert.match(longer.text, /共享参数（pen\.params\.json）：L = 70/)
assert.ok(!(await call("export", { path: "out/pen-bom.md" })).isError)
assert.match(await readFile(path.join(work, "out/pen-bom.md"), "utf8"), /笔帽/)
const inCtx = await call("open_part", { path: "pen/barrel", context: "pen/pen.arbor-asm.json" })
assert.match(inCtx.text, /在装配「pen」里编辑/)
if (withApp) {
  const close = await call("look", { focus: { part: "笔帽" }, section: { plane: "XZ", offset: 0 } })
  assert.ok(close.images.length >= 2, "a section with a close-up")
  for (const [i, img] of close.images.entries()) await writeFile(path.join(work, `look-asm-${i}.png`), Buffer.from(img.data, "base64"))
}

await client.close()
console.log(`\nMCP smoke passed (${withApp ? "with the app" : "headless"}). Part: ${file}`)
