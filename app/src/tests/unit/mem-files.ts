// An in-memory file system for the Arbor engine tests.
import type { Files } from "@/desktop/core/engine"

/** An in-memory disk; `touch` plays someone else saving the file. */
export function memFiles() {
  const disk = new Map<string, string | Uint8Array>()
  const watchers = new Map<string, () => void>()
  /** Bumped on every write: the modification time of this disk. */
  const written = new Map<string, number>()
  let clock = 0
  // Like the real file system, `a/../b` reaches `b` when reading and writing.
  const norm = (p: string) => {
    const out: string[] = []
    for (const seg of p.split("/")) {
      if (seg === "..") out.pop()
      else out.push(seg)
    }
    return out.join("/")
  }
  const files: Files = {
    read: async (raw) => {
      const p = norm(raw)
      const v = disk.get(p)
      return v === undefined ? null : typeof v === "string" ? v : new TextDecoder().decode(v)
    },
    readBytes: async (raw) => {
      const p = norm(raw)
      const v = disk.get(p)
      return v === undefined ? null : typeof v === "string" ? new TextEncoder().encode(v) : v
    },
    stat: async (raw) => {
      const p = norm(raw)
      const v = disk.get(p)
      return v === undefined ? null : { size: typeof v === "string" ? v.length : v.byteLength, mtimeMs: written.get(p) ?? 0 }
    },
    write: async (raw, d) => {
      const p = norm(raw)
      disk.set(p, d)
      written.set(p, ++clock)
    },
    watch: (raw, cb) => {
      const p = norm(raw)
      watchers.set(p, cb)
      return () => watchers.delete(p)
    },
    // No symlinks in memory: `..` resolves by name, as the real file system would here.
    canonical: (p) => {
      const out: string[] = []
      for (const seg of p.split("/")) {
        if (seg === "..") out.pop()
        else out.push(seg)
      }
      return out.join("/")
    },
  }
  const touch = async (p: string, data: string | Uint8Array) => {
    disk.set(p, data)
    written.set(p, ++clock)
    watchers.get(p)?.()
  }
  return { disk, files, touch }
}

