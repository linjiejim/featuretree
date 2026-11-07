import * as React from "react"
import { Boxes, CircleAlert, MousePointerClick, Sparkles, X } from "lucide-react"
import { Button, IconButton } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { notify } from "@/components/ui/toast"
import { renderShots, renderViews } from "@/studio/look"
import { NO_PARTS_VIEW, type Hover, type PartsView } from "@/studio/scene"
import { CodePanel, ParamsPanel } from "@/studio/ui/side-panels"
import { StudioViewport } from "@/studio/ui/studio-viewport"
import { TreeOverlay } from "@/studio/ui/tree-overlay"
import { useReselect } from "@/studio/use-reselect"
import { arbor } from "./bridge"
import type { DocState, PartNote, PickRequest, ShowRequest } from "./core/protocol"
import { besides } from "./core/sources"
import { asNote, useDesktopNotes, useDesktopStudio, useEngine } from "./use-desktop"
import { AgentSetupDialog } from "./ui/agent-setup"
import { NoteComposer } from "./ui/note-composer"
import { PartsSidebar } from "./ui/parts-sidebar"
import { ActivityPanel, NotesPanel } from "./ui/side-panels"
import { TitleBar } from "./ui/title-bar"
import { Welcome } from "./ui/welcome"

/** A note pinned on a face or an edge (not one about the whole part). */
const onSpot = (n: PartNote): n is PartNote & { kind: "face" | "edge" } => n.kind !== "part"

const editing = () => {
  const el = document.activeElement as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

export function DesktopApp() {
  const { snapshot, doc, pick, show, setShow } = useEngine()
  const studio = useDesktopStudio(doc, snapshot)
  const notes = useDesktopNotes(studio, doc, pick)
  const reselect = useReselect(studio)
  const [partsView, setPartsView] = React.useState<PartsView>(NO_PARTS_VIEW)
  const [treeHover, setTreeHover] = React.useState<Hover | null>(null)
  const [setupOpen, setSetupOpen] = React.useState(false)
  const [tab, setTab] = React.useState("notes")

  // The agent's `look`: render the views it asked for, from the mesh the engine sent.
  React.useEffect(
    () =>
      arbor.onLook(async (req) =>
        req.shots ? renderShots(req.display, req.shots, { highlight: req.highlight, pins: req.pins, section: req.section, hide: req.hide, size: req.size }) : renderViews(req.display, req.views, req.highlight, { pins: req.pins }),
      ),
    [],
  )
  // What 检查更新… found.
  React.useEffect(() => arbor.onNotice((n) => void (n.tone === "error" ? notify.error(n.text) : notify[n.tone](n.text))), [])

  // Menu items and shortcuts: ⌘Z undoes typing in a field, otherwise the last change to the part.
  const path = doc?.path
  React.useEffect(
    () =>
      arbor.onMenu((action) => {
        if (action === "agent-setup") return setSetupOpen(true)
        if (editing()) return void document.execCommand(action)
        if (path) void arbor.call(action, {}, path).then((r) => !r.ok && notify(r.text.replace(/^✗ /, "")))
      }),
    [path],
  )

  // The agent points something out: a feature lights up like a hover in the tree; faces or edges like a note.
  // Its highlight goes when it's cleared or replaced (only the one it set: the person's own stays).
  const { setFocus } = notes
  const shownByAgent = React.useRef(false)
  React.useEffect(() => {
    if (show && show.path === path && show.hashes?.length && show.kind) {
      setFocus({ kind: show.kind, hashes: show.hashes })
      shownByAgent.current = true
    } else if (shownByAgent.current) {
      setFocus(null)
      shownByAgent.current = false
    }
  }, [show, path, setFocus])
  const agentHover: Hover | null = show?.feature && show.path === path ? { ids: [show.feature], label: show.label ?? "Agent 指的特征" } : null
  const clearShow = () => setShow(null)
  // A pick request is answered only on the part it asks about.
  const pickHere = pick && pick.path === path ? pick : null

  return (
    <div className="flex h-dvh flex-col bg-background">
      <TitleBar snapshot={snapshot} doc={doc} pick={pick} onSetup={() => setSetupOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <PartsSidebar snapshot={snapshot} />
        <main className="relative min-h-0 min-w-0 flex-1">
          {doc ? (
            <>
              <StudioViewport
                studio={studio}
                hover={treeHover ?? agentHover}
                annotations={notes}
                busy={false}
                copy={{ hint: pick ? null : "单击模型上的面或边，给 agent 留一条备注", add: pickHere ? "就是这里" : "记下备注", next: notes.nextPin }}
                reselect={reselect}
                parts={partsView}
                onParts={setPartsView}
              />
              <TreeOverlay studio={studio} onHover={setTreeHover} reselect={reselect} annotations={notes} parts={partsView} onParts={setPartsView} />
              <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-56">
                {pick && <PickBanner request={pick} elsewhere={pick.path !== path} />}
                {show && show.path === path && !pick && <ShowBanner request={show} onClose={clearShow} />}
                {doc.error && (
                  <Banner tone="danger" icon={<CircleAlert />}>
                    {doc.error}
                  </Banner>
                )}
                {!pick && <AssemblyBanner doc={doc} />}
              </div>
            </>
          ) : (
            <Welcome onSetup={() => setSetupOpen(true)} />
          )}
        </main>
        {doc && (
          <Tabs value={tab} onValueChange={setTab} className="flex w-[380px] shrink-0 flex-col border-l max-xl:w-[340px]">
            <TabsList className="shrink-0 px-3">
              <TabsTrigger value="notes">
                备注{doc.notes.some((n) => n.status === "open") ? ` ${doc.notes.filter((n) => n.status === "open").length}` : ""}
              </TabsTrigger>
              <TabsTrigger value="activity">动态</TabsTrigger>
              <TabsTrigger value="params">参数</TabsTrigger>
              <TabsTrigger value="code">代码</TabsTrigger>
            </TabsList>
            <TabsContent value="notes" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <NotesPanel doc={doc} onLocate={(n) => onSpot(n) && void notes.show(asNote(n))} onWrite={() => notes.setCompose("")} />
            </TabsContent>
            <TabsContent value="activity" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <ActivityPanel doc={doc} snapshot={snapshot} />
            </TabsContent>
            <TabsContent value="params" className="min-h-0 flex-1 overflow-y-auto">
              {Object.keys(doc.tree.params).length || doc.tree.checks?.length ? (
                <ParamsPanel studio={studio} onHover={setTreeHover} annotations={notes} />
              ) : (
                <p className="px-4 py-4 text-body text-muted-foreground">还没有参数。Agent 会把关键尺寸定成参数，之后可以在这里直接改。</p>
              )}
            </TabsContent>
            <TabsContent value="code" className="min-h-0 flex-1 overflow-y-auto">
              <CodePanel studio={studio} />
            </TabsContent>
          </Tabs>
        )}
      </div>
      <AgentSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      <NoteComposer
        text={notes.compose}
        onClose={() => notes.setCompose(null)}
        onSave={async (text) => {
          if (!(await notes.addPartNote(text))) return false
          notes.setCompose(null)
          setTab("notes")
          return true
        }}
      />
    </div>
  )
}

/** `keep`: the text keeps its width (a short label beside several buttons) instead of wrapping. */
function Banner({ tone, icon, children, action, keep }: { tone: "info" | "warning" | "danger"; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; keep?: boolean }) {
  const color = { info: "border-info/40", warning: "border-warning/50", danger: "border-destructive/40" }[tone]
  const iconColor = { info: "text-info", warning: "text-warning", danger: "text-destructive" }[tone]
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`pointer-events-auto flex max-w-xl items-center gap-2.5 rounded-lg border bg-background py-1.5 pr-1.5 pl-3 shadow-popover ${color}`}>
      <span className={`shrink-0 [&_svg]:size-4 ${iconColor}`}>{icon}</span>
      <span className={`${keep ? "shrink-0" : "min-w-0 flex-1"} text-body`}>{children}</span>
      {action}
    </div>
  )
}

/**
 * Assemblies: inside one, say so and offer the way back; on one, offer to edit each part in place
 * (the others stay around it, see-through).
 */
function AssemblyBanner({ doc }: { doc: DocState }) {
  if (doc.context)
    return (
      <Banner
        tone="info"
        icon={<Boxes />}
        action={
          <Button size="sm" variant="secondary" onClick={() => void arbor.call("open_part", { path: doc.context!.assembly })}>
            回到装配
          </Button>
        }
      >
        在装配「{doc.context.name}」里编辑 · 其他零件半透明，只读
      </Banner>
    )
  if (doc.kind !== "assembly") return null
  const comps = doc.tree.features.flatMap((f) => (f.op === "component" ? [f] : []))
  if (!comps.length) return null
  const files = [...new Map(comps.filter((c) => !/\.(step|stp)$/i.test(c.file)).map((c) => [c.file, c])).values()]
  return (
    <Banner
      tone="info"
      icon={<Boxes />}
      keep
      action={
        <div className="flex flex-wrap justify-end gap-1">
          {files.slice(0, 6).map((c) => (
            <Button key={c.file} size="sm" variant="secondary" onClick={() => void arbor.call("open_part", { path: besides(doc.path, c.file), context: doc.path })}>
              改 {c.name ?? c.file.split("/").pop()}
            </Button>
          ))}
        </div>
      }
    >
      装配 · {comps.length} 个零件
    </Banner>
  )
}

/** The agent is waiting for a click: say what it asked, and let the person decline. */
function PickBanner({ request, elsewhere }: { request: PickRequest; elsewhere: boolean }) {
  const what = request.kind === "face" ? "一个面" : request.kind === "edge" ? "一条边" : "一个面或一条边"
  const part = request.path.split(/[\\/]/).pop()
  return (
    <Banner
      tone="warning"
      icon={<MousePointerClick />}
      action={
        <>
          {elsewhere && (
            <Button size="sm" variant="secondary" onClick={() => void arbor.call("open_part", { path: request.path })}>
              切到 {part}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void arbor.answerPick(request.id, null)}>
            不点了
          </Button>
        </>
      }
    >
      <span className="font-medium">Agent 请你{elsewhere ? `在 ${part} 上` : ""}点{what}：</span>
      {request.prompt}
    </Banner>
  )
}

function ShowBanner({ request, onClose }: { request: ShowRequest; onClose: () => void }) {
  return (
    <Banner
      tone="info"
      icon={<Sparkles />}
      action={
        <IconButton label="取消高亮" size="icon-sm" onClick={onClose}>
          <X />
        </IconButton>
      }
    >
      <span className="font-medium">Agent 指给你看：</span>
      {request.label ?? (request.hashes ? `${request.hashes.length} ${request.kind === "face" ? "个面" : "条边"}` : "")}
    </Banner>
  )
}
