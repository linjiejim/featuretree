import * as React from "react"
import { CircleAlert, CircleDashed, Eye, EyeOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button, IconButton } from "@/components/ui/button"
import { OpIcon } from "@/components/op-icon"
import type { OpId } from "@/content/ops"
import type { FeatureResult } from "../kernel/build"
import { displayName, OP_NAMES, type Feature, type Tree } from "../dsl"
import { NO_PARTS_VIEW, type Hover, type PartsView } from "../scene"
import { FeatureCard } from "./feature-card"
import type { Annotations } from "../use-annotations"
import type { Reselect } from "../use-reselect"
import type { Studio } from "../use-studio"

const OP_ICON: Record<Feature["op"], OpId> = {
  sketch: "sketch",
  extrude: "extrude",
  revolve: "revolve",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  hole: "hole",
  linear_pattern: "pattern",
  circular_pattern: "pattern",
  mirror: "mirror",
  sweep: "sweep",
  loft: "loft",
  draft: "draft",
  rib: "rib",
  split: "cut",
  import: "boolean",
  component: "boolean",
}

function iconOf(f: Feature): OpId {
  return f.op === "extrude" && f.mode === "cut" ? "cut" : OP_ICON[f.op]
}

/** The row the pointer (or focus) is on: where its details go, and how tall the column is. */
type Peek = { id: string; top: number; bound: number }

/**
 * The feature tree over the left edge of the 3D view: icon and name in grey,
 * a row lifts on hover and lights up the faces it made, details open beside
 * it. Click a row to edit that feature by hand; `readOnly` (a shared link): to view the model at that step.
 */
export function TreeOverlay({
  studio,
  onHover,
  reselect,
  annotations,
  busy = false,
  parts = NO_PARTS_VIEW,
  onParts,
  readOnly = false,
}: {
  studio: Studio
  onHover: (h: Hover | null) => void
  reselect?: Reselect
  annotations?: Annotations
  busy?: boolean
  parts?: PartsView
  onParts?: (v: PartsView) => void
  /** A shared link: a click rolls back to that step; no feature card. */
  readOnly?: boolean
}) {
  const { tree, report, rollback } = studio
  const root = React.useRef<HTMLElement>(null)
  const [peek, setPeek] = React.useState<Peek | null>(null)
  const [editing, setEditing] = React.useState<Peek | null>(null)
  const rollbackIndex = rollback ? tree.features.findIndex((x) => x.id === rollback) : -1

  const show = (f: Feature, el: HTMLElement) => {
    const box = root.current
    if (!box) return
    setPeek({ id: f.id, top: el.getBoundingClientRect().top - box.getBoundingClientRect().top, bound: box.clientHeight })
    onHover({ ids: f.op === "sketch" ? [] : [f.id], label: "该特征生成的面", feature: f.id })
  }
  const hide = () => {
    setPeek(null)
    onHover(null)
  }

  if (!tree.features.length) return null
  const peeked = peek && !editing ? tree.features.findIndex((f) => f.id === peek.id) : -1
  const edited = editing ? tree.features.find((f) => f.id === editing.id) : undefined
  const edit = (f: Feature, el: HTMLElement) => {
    const box = root.current
    if (!box) return
    setPeek(null)
    setEditing(editing?.id === f.id ? null : { id: f.id, top: el.getBoundingClientRect().top - box.getBoundingClientRect().top, bound: box.clientHeight })
  }

  return (
    <nav ref={root} aria-label="特征树" className="pointer-events-none absolute top-3 bottom-20 left-3 z-10 flex max-w-[45%] flex-col">
      <div className="pointer-events-auto flex h-7 items-center gap-2 px-2 text-caption text-faint-foreground">
        <span>{tree.features.length} 个特征</span>
        {rollback && (
          <Button size="sm" variant="secondary" className="h-6 px-2 text-caption" onClick={() => studio.showFeature(null)}>
            回到最新
          </Button>
        )}
      </div>
      {studio.display?.parts && studio.display.parts.length > 1 && (
        <ul aria-label="零件" className="pointer-events-auto mb-1 flex flex-col gap-0.5 border-b pb-1">
          {studio.display.parts.map((p, k) => {
            const hidden = parts.hidden.has(k)
            const faces = studio.display!.groups.filter((g) => g.part === k).map((g) => g.hash)
            return (
              <li key={p.name} className="flex max-w-52 items-center gap-2 px-2 py-0.5 text-small text-muted-foreground" onMouseEnter={() => onHover({ ids: [], label: `零件「${p.name}」`, faces })} onMouseLeave={() => onHover(null)}>
                <span aria-hidden className={cn("size-3 shrink-0 rounded-xs border", k % 2 ? "bg-scene-model-dark" : "bg-scene-model")} />
                <span className={cn("truncate", hidden && "line-through opacity-60")}>{p.name}</span>
                <IconButton
                  label={hidden ? `显示「${p.name}」` : `隐藏「${p.name}」`}
                  size="icon-sm"
                  className="ml-auto size-6"
                  onClick={() => {
                    const next = new Set(parts.hidden)
                    if (hidden) next.delete(k)
                    else next.add(k)
                    onParts?.({ ...parts, hidden: next })
                  }}
                >
                  {hidden ? <EyeOff /> : <Eye />}
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
      <ol className="pointer-events-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pr-4 pb-1" onMouseLeave={hide} onScroll={hide}>
        {tree.features.map((f, i) => {
          const r = report?.features[i]
          const active = rollback === f.id
          const after = rollbackIndex >= 0 && i > rollbackIndex
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={(e) => (readOnly ? studio.showFeature(active ? null : f.id) : edit(f, e.currentTarget))}
                aria-expanded={readOnly ? undefined : editing?.id === f.id}
                onMouseEnter={(e) => show(f, e.currentTarget)}
                onFocus={(e) => show(f, e.currentTarget)}
                onBlur={hide}
                aria-describedby={peek?.id === f.id ? "feature-peek" : undefined}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex max-w-52 origin-left items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-small text-muted-foreground",
                  "transition-[transform,background-color,color,border-color] duration-(--duration-fast) ease-out motion-reduce:transition-colors",
                  "hover:scale-[1.06] hover:border-border hover:bg-background hover:text-foreground focus-visible:scale-[1.06] focus-visible:bg-background focus-visible:text-foreground motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100",
                  (active || editing?.id === f.id) && "border-border bg-background font-medium text-foreground",
                  (after || f.suppressed) && "opacity-50",
                )}
              >
                <OpIcon op={iconOf(f)} className="size-4 shrink-0" />
                <span className={cn("truncate max-sm:sr-only", f.suppressed && "line-through")}>{displayName(tree, f)}</span>
                {f.part && <span className="shrink-0 rounded-xs bg-muted px-1 text-caption text-faint-foreground max-sm:sr-only">{f.part}</span>}
                {f.suppressed && <span className="sr-only">（已压缩）</span>}
                {r?.state === "error" ? (
                  <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="失败" />
                ) : r?.state === "skipped" ? (
                  <CircleDashed className="size-3.5 shrink-0 text-faint-foreground" aria-label="未重建" />
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
      {editing && edited && reselect && annotations && (
        <div className="pointer-events-none absolute inset-y-0 left-full ml-1 flex w-80 max-w-[calc(100vw-5rem)] flex-col">
          <div className="pointer-events-auto flex min-h-0 flex-col" style={{ marginTop: Math.max(0, Math.min(editing.top, editing.bound - 380)) }}>
            <FeatureCard
              key={edited.id}
              studio={studio}
              feature={edited}
              result={report?.features[tree.features.indexOf(edited)]}
              reselect={reselect}
              annotations={annotations}
              busy={busy}
              onClose={() => {
                if (reselect.state?.feature === edited.id) reselect.cancel()
                setEditing(null)
              }}
              onPointDim={(id) => onHover(id ? { ids: [], label: "", dim: id } : null)}
            />
          </div>
        </div>
      )}
      {peek && peeked >= 0 && (
        <FeaturePeek
          tree={tree}
          f={tree.features[peeked]}
          r={report?.features[peeked]}
          active={rollback === peek.id}
          readOnly={readOnly}
          top={peek.top}
          bound={peek.bound}
        />
      )}
    </nav>
  )
}

/** The details layer beside a hovered row. Read-only, so it never takes the pointer. */
function FeaturePeek({ tree, f, r, active, readOnly, top, bound }: { tree: Tree; f: Feature; r?: FeatureResult; active: boolean; readOnly: boolean; top: number; bound: number }) {
  const card = React.useRef<HTMLDivElement>(null)
  // Level with the row; slid up when the row is near the bottom so the card stays in view.
  React.useLayoutEffect(() => {
    const el = card.current
    if (el) el.style.top = `${Math.max(0, Math.min(top, bound - el.offsetHeight))}px`
  }, [top, bound, f.id])

  const kind = `${OP_NAMES[f.op]}${"mode" in f && f.mode === "cut" ? " · 切除" : ""}`
  const uses = usesOf(tree, f)
  return (
    <div
      ref={card}
      id="feature-peek"
      role="tooltip"
      className="pointer-events-none absolute left-full ml-1 w-64 animate-fade-in rounded-md border bg-popover p-3 text-small shadow-popover"
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-body font-medium">{displayName(tree, f)}</span>
        <span className="font-mono text-caption text-faint-foreground">{f.id}</span>
      </div>
      <div className="text-muted-foreground">{kind}</div>
      {r?.summary && <div className="mt-2">{r.summary}</div>}
      {uses && <div className="mt-1 text-muted-foreground">{uses}</div>}
      {r?.state === "error" && (
        <div className="mt-2 text-destructive">
          {r.message}
          {r.hint && <div className="mt-0.5 text-muted-foreground">{r.hint}</div>}
        </div>
      )}
      {r?.state === "skipped" && <div className="mt-2 text-faint-foreground">前面失败，这一步没有重建</div>}
      {r?.state === "suppressed" && <div className="mt-2 text-faint-foreground">已压缩：暂时不参与重建</div>}
      {r?.warnings?.map((w) => (
        <div key={w} className="mt-1 text-warning">
          {w}
        </div>
      ))}
      {f.intent && <div className="mt-2 text-muted-foreground">设计意图：{f.intent}</div>}
      {r?.state === "ok" && (
        <div className="mt-2 text-caption text-faint-foreground tabular">
          {[r.faces && `新面 ${r.faces.new}`, r.faces?.modified && `改动 ${r.faces.modified} 个面`, `用时 ${Math.round(r.ms)} ms`].filter(Boolean).join(" · ")}
        </div>
      )}
      <div className="mt-2 border-t pt-2 text-caption text-faint-foreground">
        {readOnly ? (active ? "正在这一步查看 · 单击回到最新" : "单击在这一步查看") : active ? "正在这一步查看 · 单击看尺寸和选择" : "单击看尺寸和选择"}
      </div>
    </div>
  )
}

/** 「基于 草图1」「复制 拉伸2、孔1」: what a feature builds on. */
function usesOf(tree: Tree, f: Feature): string | null {
  const name = (id: string) => {
    const x = tree.features.find((g) => g.id === id)
    return x ? displayName(tree, x) : id
  }
  if (f.op === "extrude" || f.op === "revolve") return `基于 ${name(f.sketch)}`
  if (f.op === "loft") return `截面 ${f.sketches.map(name).join("、")}`
  if ((f.op === "linear_pattern" || f.op === "circular_pattern" || f.op === "mirror") && f.features?.length) return `复制 ${f.features.map(name).join("、")}`
  return null
}
