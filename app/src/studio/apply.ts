// Executing a tool call: a pure edit of the feature tree, a rebuild through a
// kernel port (a Web Worker in the browser, the Kernel directly in Node), and
// a short plain-text result the model can act on.
import { Check, Feature, OP_NAMES, Tree, displayName, type FeatureOp } from "./dsl"
import { resolveParams } from "./expr"
import type { BuildReport } from "./kernel/build"
import { InputError } from "./kernel/errors"
import type { ToolOutput } from "./tools"

export type KernelPort = {
  rebuild(tree: Tree): Promise<BuildReport>
  inspect(what: "body" | "faces" | "edges", selector?: unknown): Promise<string>
}

export type LookFn = (views: string[], highlight?: string) => Promise<string[]>

export type ToolRun = { tree: Tree; output: ToolOutput; report?: BuildReport; focus?: string }

const FEATURE_OPS = new Set(Object.keys(OP_NAMES))
const r1 = (x: number) => Math.round(x * 10) / 10

/** Ids a feature depends on (sketch, patterned features, selector `of`). */
export function referencesOf(f: Feature): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, key?: string) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key === "features" ? "feature-item" : undefined))
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k)
    else if (typeof v === "string" && (key === "of" || key === "sketch" || key === "feature-item")) out.add(v)
  }
  walk(f)
  out.delete(f.id)
  return [...out]
}

/** Put `f` in place of the feature with its id, as a whole (fields left out are removed). */
export function replaceFeature(tree: Tree, f: unknown): Tree {
  const parsed = Feature.safeParse(f)
  if (!parsed.success) throw new InputError(`有字段不对：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("；")}`)
  const i = tree.features.findIndex((x) => x.id === parsed.data.id)
  if (i < 0) throw new InputError(`找不到特征「${parsed.data.id}」`)
  const features = [...tree.features]
  features[i] = parsed.data
  return { ...tree, features }
}

/** One field of one feature set to `value` (a dimension edited on the model). */
export function setFieldAt(tree: Tree, id: string, path: (string | number)[], value: unknown): Tree {
  const f = tree.features.find((x) => x.id === id)
  if (!f) throw new InputError(`找不到特征「${id}」`)
  const copy = structuredClone(f) as Record<string | number, unknown>
  let at: Record<string | number, unknown> = copy
  for (const k of path.slice(0, -1)) {
    const next = at[k]
    if (!next || typeof next !== "object") throw new InputError(`「${displayName(tree, f)}」没有这个字段：${path.join(".")}`)
    at = next as Record<string | number, unknown>
  }
  at[path[path.length - 1]] = value
  return replaceFeature(tree, copy)
}

/** A plain number in a feature made a named parameter: same model, now on the parameters panel. */
export function promoteToParam(tree: Tree, id: string, path: (string | number)[], name: string, note: string, value: number): Tree {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new InputError("参数名只能用字母、数字和下划线，不能以数字开头")
  if (name in tree.params) throw new InputError(`已经有参数「${name}」了`)
  const withParam: Tree = { ...tree, params: { ...tree.params, [name]: value }, paramNotes: { ...tree.paramNotes, [name]: note } }
  return setFieldAt(withParam, id, path, name)
}

/** Move a feature one step up or down, never above something it uses or below something that uses it. */
export function moveFeature(tree: Tree, id: string, by: -1 | 1): Tree {
  const i = tree.features.findIndex((x) => x.id === id)
  const j = i + by
  if (i < 0 || j < 0 || j >= tree.features.length) throw new InputError("已经到头了")
  const [a, b] = by < 0 ? [tree.features[j], tree.features[i]] : [tree.features[i], tree.features[j]]
  // After the swap `b` comes first: it must not use `a`.
  if (referencesOf(b).includes(a.id)) throw new InputError(`「${displayName(tree, b)}」用到了「${displayName(tree, a)}」，不能排到它前面`)
  const features = [...tree.features]
  features[i] = tree.features[j]
  features[j] = tree.features[i]
  return { ...tree, features }
}

export function applyEdit(tree: Tree, name: string, input: Record<string, unknown>): { tree: Tree; target?: string; note?: string } {
  if (name === "set_params") {
    const params = { ...tree.params }
    const notes = { ...tree.paramNotes }
    for (const k of (input.remove as string[] | undefined) ?? []) {
      delete params[k]
      delete notes[k]
    }
    for (const [k, v] of Object.entries((input.set as Record<string, number | string>) ?? {})) {
      if (!/^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/.test(k)) throw new InputError(`参数名「${k}」不合法：用字母、数字、下划线或中文，不以数字开头`)
      params[k] = v
    }
    for (const [k, v] of Object.entries((input.notes as Record<string, string>) ?? {})) if (k in params && typeof v === "string") notes[k] = v.trim().slice(0, 60)
    resolveParams(params) // unknown names / cycles fail here, before the tree changes
    return { tree: { ...tree, params, ...(Object.keys(notes).length ? { paramNotes: notes } : { paramNotes: undefined }) } }
  }
  if (FEATURE_OPS.has(name)) {
    const { after, ...rest } = input as { after?: string } & Record<string, unknown>
    const parsed = Feature.safeParse({ ...rest, op: name })
    if (!parsed.success) throw new InputError(`参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`)
    const f = parsed.data
    if (tree.features.some((x) => x.id === f.id)) throw new InputError(`已经有 id 为「${f.id}」的特征了，换一个 id，或用 edit_feature 修改它`)
    const features = [...tree.features]
    let at = after ? features.findIndex((x) => x.id === after) : features.length - 1
    if (after && at < 0) throw new InputError(`找不到特征「${after}」`)
    // `after` that would put it before what it uses (a sketch made just now): after the last of those instead.
    const uses = referencesOf(f).map((id) => features.findIndex((x) => x.id === id)).filter((i) => i >= 0)
    const latest = uses.length ? Math.max(...uses) : -1
    let note: string | undefined
    if (latest > at) {
      note = `after「${after}」会排在它用到的「${displayName(tree, features[latest])}」前面，已改为放在「${displayName(tree, features[latest])}」后面。after 只在要插到中间时才写。`
      at = latest
    }
    features.splice(at + 1, 0, f)
    return { tree: { ...tree, features }, target: f.id, note }
  }
  if (name === "edit_feature") {
    const { id, changes } = input as { id: string; changes: Record<string, unknown> }
    const i = tree.features.findIndex((x) => x.id === id)
    if (i < 0) throw new InputError(`找不到特征「${id}」`)
    const { op: _op, id: _id, ...rest } = changes ?? {}
    void _op
    void _id
    // null removes a field: { "thin": null } turns a thin wall back into a plain extrusion.
    const merged: Record<string, unknown> = { ...tree.features[i], ...rest }
    for (const [k, v] of Object.entries(rest)) if (v === null) delete merged[k]
    const parsed = Feature.safeParse(merged)
    if (!parsed.success) throw new InputError(`修改后的特征不合法：${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("；")}`)
    const features = [...tree.features]
    features[i] = parsed.data
    return { tree: { ...tree, features }, target: id }
  }
  if (name === "delete_feature") {
    const { id, cascade } = input as { id: string; cascade?: boolean }
    if (!tree.features.some((x) => x.id === id)) throw new InputError(`找不到特征「${id}」`)
    const doomed = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const f of tree.features) {
        if (!doomed.has(f.id) && referencesOf(f).some((r) => doomed.has(r))) {
          doomed.add(f.id)
          grew = true
        }
      }
    }
    doomed.delete(id)
    if (doomed.size && !cascade) throw new InputError(`后面的特征引用了「${id}」：${[...doomed].join("、")}。要一起删，设 cascade=true；或者先改它们的引用`)
    doomed.add(id)
    return { tree: { ...tree, features: tree.features.filter((f) => !doomed.has(f.id)) } }
  }
  throw new InputError(`未知工具「${name}」`)
}

export async function executeTool(port: KernelPort, tree: Tree, name: string, input: Record<string, unknown>, look?: LookFn): Promise<ToolRun> {
  try {
    if (name === "inspect") {
      const what = input.what as "tree" | "body" | "faces" | "edges"
      if (what === "tree") {
        const report = await port.rebuild(tree)
        return { tree, output: { ok: true, text: treeText(tree, report) }, report }
      }
      const text = await port.inspect(what, what === "faces" ? input.faces : what === "edges" ? input.edges : undefined)
      return { tree, output: { ok: true, text } }
    }
    if (name === "check") {
      const items = Check.array().parse(input.items ?? [])
      const drop = new Set([...((input.remove as string[] | undefined) ?? []), ...items.map((c) => c.id)])
      const checks = [...(tree.checks ?? []).filter((c) => !drop.has(c.id)), ...items]
      const next: Tree = { ...tree, checks: checks.length ? checks : undefined }
      const report = await port.rebuild(next)
      return { tree: next, output: { ok: true, text: checkText(report) }, report }
    }
    if (name === "look") {
      if (!look) return { tree, output: { ok: false, text: "这个环境不能渲染视图。" } }
      const views = (input.views as string[] | undefined)?.length ? (input.views as string[]) : ["iso", "front", "top", "right"]
      const images = await look(views, input.highlight as string | undefined)
      return { tree, output: { ok: true, text: `视图：${views.join("、")}（蓝色 = 高亮的特征，灰色 = 其余）`, images } }
    }
    const { tree: next, target, note } = applyEdit(tree, name, input)
    const report = await port.rebuild(next)
    return { tree: next, output: { ok: resultOk(report, target), text: [note && `⚠ ${note}`, resultText(name, report, target)].filter(Boolean).join("\n") }, report, focus: target }
  } catch (e) {
    if (e instanceof InputError || (e as Error)?.name === "ExprError") return { tree, output: { ok: false, text: `✗ ${(e as Error).message}` } }
    return { tree, output: { ok: false, text: `✗ 出错了：${(e as Error)?.message ?? e}` } }
  }
}

/** One line per requirement: 「✓ size「80×50×30」：实际 80 × 50 × 30」. */
export function checkText(report: BuildReport) {
  const rows = report.checks ?? []
  if (!rows.length) return "没有核对项。"
  const failed = rows.filter((r) => !r.pass && !r.invalid).length
  const invalid = rows.filter((r) => r.invalid).length
  return [
    ...rows.map((r) => (r.invalid ? `? ${r.id}「${r.said}」：量不了，${r.actual}` : `${r.pass ? "✓" : "✗"} ${r.id}「${r.said}」：要求 ${r.expected}，实际 ${r.actual}`)),
    ...(failed ? [`${failed} 项不满足：先确认量的位置对不对（size 是整个零件的外形；局部尺寸用 distance / thickness，选择器要正好选中那个面）。量错了就用同一个 id 改写这一项；确实没做到再用 edit_feature 修模型，然后再核对。不要为了通过去改期望值。`] : []),
    ...(invalid ? [`${invalid} 项量不了：是这一项的选择器写得不对（要正好选中要量的面或边，例如加上 normal、of），用同一个 id 改写这一项，不是改模型。`] : []),
    ...(!failed && !invalid ? ["全部满足。"] : []),
  ].join("\n")
}

function resultOk(report: BuildReport, target?: string) {
  if (report.paramError) return false
  if (!target) return report.features.every((f) => f.state === "ok" || f.state === "suppressed")
  return report.features.find((f) => f.id === target)?.state === "ok"
}

export function bodyLine(report: BuildReport) {
  const b = report.body
  if (!b) return "还没有实体。"
  if (report.parts) return `实体：${b.size.join(" × ")} mm，${report.parts.length} 个零件：${report.parts.map((p) => `${p.name}（${p.size.join(" × ")} mm，${r1(p.volume / 1000)} cm³）`).join("、")}。`
  const solids = b.solids > 1 ? `，${b.solids} 个不相连的实体` : ""
  return `实体：${b.size.join(" × ")} mm，体积 ${r1(b.volume / 1000)} cm³${solids}。`
}

function resultText(name: string, report: BuildReport, target?: string) {
  const lines: string[] = []
  if (report.paramError) lines.push(`✗ 参数有错：${report.paramError}`)
  if (name === "set_params") lines.push(`参数：${Object.entries(report.params).map(([k, v]) => `${k}=${r1(v)}`).join("，")}`)
  if (name === "delete_feature") lines.push("已删除。")
  const r = target ? report.features.find((f) => f.id === target) : undefined
  if (r) {
    if (r.state === "ok") {
      const faces = r.faces ? `新生成 ${r.faces.new} 个面，修改 ${r.faces.modified} 个。` : ""
      lines.push(`✓ ${r.name}（${r.id}）：${r.summary ?? ""}。${faces}`)
    } else if (r.state === "error") {
      lines.push(`✗ ${r.name}（${r.id}）失败：${r.message}`)
      if (r.hint) lines.push(`建议：${r.hint}`)
      lines.push("这个特征留在特征树里并标为失败：用 edit_feature 修好它，或 delete_feature 删掉。")
    } else lines.push(`… ${r.name}（${r.id}）没有重建：前面有特征失败。`)
    for (const w of r.warnings ?? []) lines.push(`⚠ ${w}`)
  }
  const failed = report.features.filter((f) => f.state === "error" && f.id !== target)
  if (failed.length) lines.push(`特征树里还有失败的特征：${failed.map((f) => `${f.name}（${f.id}）：${f.message}`).join("；")}`)
  const skipped = report.features.filter((f) => f.state === "skipped").length
  if (skipped) lines.push(`因此后面 ${skipped} 个特征没有重建。`)
  lines.push(bodyLine(report))
  return lines.join("\n")
}

export function treeText(tree: Tree, report: BuildReport) {
  const params = Object.entries(tree.params)
    .map(([k, v]) => `${k} = ${v}${typeof v === "string" ? `（= ${r1(report.params[k] ?? NaN)}）` : ""}`)
    .join("，")
  const rows = tree.features.map((f, i) => {
    const r = report.features[i]
    const mark = r?.state === "ok" ? "✓" : r?.state === "error" ? "✗" : r?.state === "suppressed" ? "⊘" : "…"
    const why = f.intent ? ` — ${f.intent}` : ""
    const msg = r?.state === "error" ? ` 失败：${r.message}` : ""
    const warn = r?.warnings?.length ? `（⚠ ${r.warnings.join("；")}）` : ""
    return `${i + 1}. ${mark} ${f.id}（${displayName(tree, f)}，${OP_NAMES[f.op as FeatureOp]}）${r?.summary ? `：${r.summary}` : ""}${warn}${msg}${why}`
  })
  return [`参数：${params || "无"}`, ...(rows.length ? rows : ["（特征树是空的）"]), bodyLine(report)].join("\n")
}
