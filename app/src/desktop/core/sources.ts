// What a part or an assembly reads besides its own file: the shared parameter
// file (`uses`) and, for an assembly, every component file (recursively),
// with their own shared parameters and STEP imports. The engine gathers them;
// the kernel only ever sees trees and bytes (it never touches the disk).
import { Tree, type Feature } from "../../studio/dsl"
import type { ComponentSource } from "../../studio/kernel/build"
import { z } from "zod"
import { Num } from "../../studio/dsl"
import type { Files } from "./engine"

export const ASM_EXT = ".arbor-asm.json"
export const PARAMS_EXT = ".params.json"
/** Sub-assemblies nest at most this deep. */
export const MAX_DEPTH = 4

/** A shared parameter file: the same shape as a tree's parameter table and notes. */
export const SharedFile = z.object({ params: z.record(z.string(), Num), paramNotes: z.record(z.string(), z.string()).optional() })
export type SharedFile = z.infer<typeof SharedFile>

/** A loaded shared parameter file (or why it couldn't be). `text`: as last read or written, to tell our writes apart. */
export type Shared = { path: string; file: string; params: SharedFile["params"]; notes: Record<string, string>; error?: string; text: string | null }

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "")

/** A file named in a part (an import, a component, `uses`), relative to the part's folder (or absolute). */
export function besides(partPath: string, file: string) {
  const f = file.trim().replace(/\\/g, "/")
  return /^([A-Za-z]:)?\//.test(f) ? f : `${dirOf(partPath).replace(/[\\/]+$/, "")}/${f.replace(/^\.\//, "")}`
}

export async function loadShared(files: Files, partPath: string, uses: string): Promise<Shared> {
  const path = besides(partPath, uses)
  const text = await files.read(path)
  if (text === null) return { path, file: uses, params: {}, notes: {}, error: `共享参数文件 ${uses} 读不到（${path}）`, text }
  try {
    const parsed = SharedFile.safeParse(JSON.parse(text))
    if (!parsed.success) return { path, file: uses, params: {}, notes: {}, error: `共享参数文件 ${uses} 格式不对：要写成 { "params": { … }, "paramNotes": { … } }`, text }
    return { path, file: uses, params: parsed.data.params, notes: parsed.data.paramNotes ?? {}, text }
  } catch (e) {
    return { path, file: uses, params: {}, notes: {}, error: `共享参数文件 ${uses} 不是合法的 JSON：${(e as Error).message}`, text }
  }
}

/** The tree the kernel builds: shared parameters win over the part's own of the same name. */
export function effectiveTree(tree: Tree, shared: Shared | null): Tree {
  if (!shared || shared.error) return tree
  return { ...tree, params: { ...tree.params, ...shared.params }, paramNotes: { ...(tree.paramNotes ?? {}), ...shared.notes } }
}

/** Own parameters a shared file overrides (named in a warning). */
export function shadowed(tree: Tree, shared: Shared | null) {
  return shared && !shared.error ? Object.keys(tree.params).filter((k) => k in shared.params) : []
}

export function sharedText(s: Pick<Shared, "params" | "notes">) {
  const out: SharedFile = { params: s.params }
  if (Object.keys(s.notes).length) out.paramNotes = s.notes
  return `${JSON.stringify(out, null, 2)}\n`
}

export const isAssembly = (path: string) => path.toLowerCase().endsWith(ASM_EXT)
const isStep = (file: string) => /\.(step|stp)$/i.test(file)

/** What a tree reads from disk, for the kernel: imports' bytes and components (recursively). */
export type Gathered = { assets: { name: string; bytes: Uint8Array | null; error?: string }[]; components: ComponentSource[]; watch: string[]; signature: string }

/**
 * Everything `tree` (in the file at `path`) reads: STEP imports, and for an assembly each component file
 * with its own shared parameters, imports and sub-components. `stack`: the assembly files above, to stop
 * a file from containing itself. `read`: false only stats and parses (to tell whether anything changed),
 * without reading STEP bytes.
 */
export async function gather(files: Files, path: string, tree: Tree, stack: string[] = [], read = true): Promise<Gathered> {
  const watch: string[] = []
  const sig: string[] = []
  const stamp = async (abs: string) => {
    watch.push(abs)
    const st = (await files.stat?.(abs)) ?? null
    sig.push(`${abs}:${st ? `${st.size}:${st.mtimeMs}` : "missing"}`)
    return st
  }

  const imports = [...new Set(tree.features.flatMap((f) => (f.op === "import" ? [f.file] : [])))]
  const assets = await Promise.all(
    imports.map(async (name) => {
      const abs = besides(path, name)
      const st = await stamp(abs)
      const bytes = st && read ? ((await files.readBytes?.(abs)) ?? null) : null
      return { name, bytes, error: bytes ? undefined : `找不到 ${abs}（路径相对零件文件所在的文件夹）` }
    }),
  )

  const comps = [...new Set(tree.features.flatMap((f: Feature) => (f.op === "component" ? [f.file] : [])))]
  const components: ComponentSource[] = []
  for (const name of comps) {
    const abs = besides(path, name)
    const st = await stamp(abs)
    if (!st) {
      components.push({ file: name, error: `找不到 ${abs}（路径相对装配文件所在的文件夹）` })
      continue
    }
    if (isStep(name)) {
      components.push({ file: name, bytes: read ? ((await files.readBytes?.(abs)) ?? null) : null })
      continue
    }
    if (stack.includes(abs) || abs === path) {
      components.push({ file: name, error: `循环引用：${[...stack, path, abs].map((p) => p.split(/[\\/]/).pop()).join(" → ")}` })
      continue
    }
    if (stack.length + 1 > MAX_DEPTH) {
      components.push({ file: name, error: `装配最多套 ${MAX_DEPTH} 层` })
      continue
    }
    const text = await files.read(abs)
    let parsed: Tree
    try {
      const t = Tree.safeParse(JSON.parse(text ?? ""))
      if (!t.success) throw new Error(t.error.issues.map((i) => `${i.path.join(".") || "（根）"} ${i.message}`).join("；"))
      parsed = t.data
    } catch (e) {
      components.push({ file: name, error: `${name} 不是合法的特征树：${(e as Error).message}` })
      continue
    }
    let shared: Shared | null = null
    if (parsed.uses) {
      shared = await loadShared(files, abs, parsed.uses)
      await stamp(shared.path)
      if (shared.error) {
        components.push({ file: name, error: shared.error })
        continue
      }
    }
    const inner = await gather(files, abs, parsed, [...stack, path], read)
    watch.push(...inner.watch)
    sig.push(inner.signature)
    components.push({ file: name, tree: effectiveTree(parsed, shared), assets: inner.assets, components: inner.components })
  }
  return { assets, components, watch: [...new Set(watch)], signature: sig.join("|") }
}
