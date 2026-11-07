import { CircleAlert, FolderOpen, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { IconButton } from "@/components/ui/button"
import { arbor } from "../bridge"
import type { Snapshot } from "../core/protocol"

/** The open parts: the agent's and the person's. Clicking one shows it (and makes it the agent's default). */
export function PartsSidebar({ snapshot }: { snapshot: Snapshot | null }) {
  const parts = snapshot?.parts ?? []
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sunken max-lg:hidden" aria-label="零件">
      <div className="flex h-10 shrink-0 items-center justify-between pr-1.5 pl-3">
        <span className="text-small font-medium text-muted-foreground">零件</span>
        <div className="flex">
          <IconButton label="新建零件（⌘N）" size="icon-sm" onClick={() => void arbor.newPart()}>
            <Plus />
          </IconButton>
          <IconButton label="打开零件（⌘O）" size="icon-sm" onClick={() => void arbor.openPart()}>
            <FolderOpen />
          </IconButton>
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {parts.length === 0 && <p className="px-1.5 py-2 text-small text-faint-foreground">agent 用 open_part 打开的零件会出现在这里。</p>}
        {parts.map((p) => {
          const active = p.path === snapshot?.active
          return (
            <div key={p.path} className={cn("group relative flex items-center rounded-md", active ? "bg-selected" : "hover:bg-accent")}>
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={p.path}
                aria-current={active ? "page" : undefined}
                onClick={() => void arbor.call("open_part", { path: p.path })}
              >
                <span className={cn("flex w-full items-center gap-1.5 truncate text-body", active && "font-medium")}>
                  {p.error && <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="文件有错" />}
                  <span className="truncate">{p.name}</span>
                </span>
                <span className="flex items-center gap-2 text-caption text-faint-foreground">
                  {p.features} 个{p.kind === "assembly" ? "零件" : "特征"}
                  {p.openNotes > 0 && <span className="text-warning">{p.openNotes} 条备注</span>}
                </span>
              </button>
              <IconButton
                label="关闭（文件不动）"
                size="icon-sm"
                className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void arbor.call("close_part", { path: p.path })}
              >
                <X />
              </IconButton>
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
