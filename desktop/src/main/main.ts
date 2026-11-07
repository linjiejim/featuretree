// Arbor's main process: the engine (kernel thread, parts, notes), the local
// endpoint the MCP server and CLI talk to, and the window that shows it all.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, type MenuItemConstructorOptions } from "electron"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Screen } from "../../../app/src/desktop/core/engine"
import { PART_EXT, PRODUCT, type CallContext, type ExportFormat, type KernelCall, type LookRequest, type MenuAction, type PickInfo } from "../../../app/src/desktop/core/protocol"
import { clearEngineInfo, writeAppInfo, writeEngineInfo } from "../engine/home"
import { startEngine } from "../engine/host"
import { serveEngine } from "../engine/rpc"
import { agentSetup } from "./setup"
import { createUpdater } from "./updater"

declare const __ARBOR_VERSION__: string

const distDir = new URL("./", import.meta.url)
const DIST = fileURLToPath(distDir)
const RENDERER_DIR = path.join(DIST, "renderer")
/** Dev: the Vite server for the window (`npm run dev`). */
const RENDERER_URL = process.env.ARBOR_RENDERER_URL
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'"

app.setName(PRODUCT)
protocol.registerSchemesAsPrivileged([{ scheme: "arbor", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])

/** Files passed as `--open <path>` (the CLI, a second launch). */
function filesIn(argv: string[]) {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (argv[i - 1] === "--open") out.push(a)
  })
  return out
}

const pendingOpen: string[] = [...filesIn(process.argv)]
// Finder: double-clicking an .arbor.json, or dropping it on the dock icon. Can come before `ready`.
app.on("open-file", (e, file) => {
  e.preventDefault()
  if (engineReady) void openForUser(file)
  else pendingOpen.push(file)
})

let engineReady = false
let win: BrowserWindow | null = null
let markReady: () => void = () => {}
let rendererReady: Promise<void> = Promise.resolve()

const looks = new Map<number, { resolve: (images: string[]) => void; reject: (e: Error) => void }>()
let lookSeq = 0

const screen: Screen = {
  async look(req: LookRequest) {
    const w = await ensureWindow()
    const id = ++lookSeq
    return new Promise<string[]>((resolve, reject) => {
      looks.set(id, { resolve, reject })
      w.webContents.send("arbor:look", id, req)
      setTimeout(() => {
        if (looks.delete(id)) reject(new Error("窗口没有在 30 秒内画出视图"))
      }, 30_000)
    })
  },
}

const { engine, kernel } = startEngine({ distDir, screen: () => screen })

const updater = createUpdater({
  status: (s) => win?.webContents.send("arbor:update", s),
  // The answer to 检查更新…: in the window when there is one, otherwise a dialog.
  notice: (n) => {
    if (win) win.webContents.send("arbor:notice", n)
    else void dialog.showMessageBox({ type: n.tone === "error" ? "warning" : "info", message: n.text })
  },
})

function createWindow(mode: "focus" | "inactive") {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    title: PRODUCT,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    // backgroundThrottling off: the agent changes the model while the window sits behind a terminal; keep it current.
    webPreferences: { preload: path.join(DIST, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  })
  win = w
  rendererReady = new Promise((r) => (markReady = r))
  w.once("ready-to-show", () => (mode === "inactive" ? w.showInactive() : w.show()))
  w.on("closed", () => {
    if (win === w) win = null
    for (const [id, l] of looks) {
      looks.delete(id)
      l.reject(new Error("窗口关掉了"))
    }
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  w.webContents.on("will-navigate", (e, url) => {
    const own = RENDERER_URL ? url.startsWith(new URL(RENDERER_URL).origin) : url.startsWith("arbor://app/")
    if (own) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  void w.loadURL(RENDERER_URL ?? "arbor://app/desktop.html")
  return w
}

/** The window, made (without taking focus) when an agent needs one and the person closed it. */
async function ensureWindow() {
  if (!win) createWindow("inactive")
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Arbor 窗口没有在 20 秒内准备好")), 20_000)
  })
  try {
    await Promise.race([rendererReady, late])
  } finally {
    clearTimeout(timer)
  }
  if (!win) throw new Error("Arbor 窗口刚被关掉了")
  return win
}

async function openForUser(file: string, create = false) {
  const res = await engine.openForUser(path.resolve(file), create)
  if (!res.ok) void dialog.showMessageBox({ type: "warning", message: "打不开这个零件", detail: res.text.replace(/^✗ /, "") })
  else if (win) win.show()
  refreshMenu()
  return res.ok
}

const userCtx = (part?: string): CallContext => ({ actor: "user", part })

function send(action: MenuAction) {
  if (win) win.webContents.send("arbor:menu", action)
}

async function newPartDialog() {
  const dir = path.join(app.getPath("documents"), PRODUCT)
  const res = await dialog.showSaveDialog({
    title: "新建零件",
    defaultPath: path.join(dir, `零件${PART_EXT}`),
    filters: [{ name: "Arbor 零件", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  })
  if (res.canceled || !res.filePath) return null
  const file = res.filePath.endsWith(".json") ? res.filePath : `${res.filePath}${PART_EXT}`
  return (await openForUser(file, true)) ? file : null
}

async function openPartDialog() {
  const res = await dialog.showOpenDialog({ title: "打开零件或装配", filters: [{ name: "Arbor 零件和装配", extensions: ["json"] }], properties: ["openFile"] })
  if (res.canceled || !res.filePaths[0]) return null
  return (await openForUser(res.filePaths[0])) ? res.filePaths[0] : null
}

const EXPORT_NAMES: Record<ExportFormat, string> = { step: "STEP", stl: "STL", py: "build123d 代码", json: "特征树 JSON" }

async function exportDialog(format: ExportFormat) {
  const doc = engine.docState()
  if (!doc) return
  const res = await dialog.showSaveDialog({
    title: `导出 ${EXPORT_NAMES[format]}`,
    defaultPath: path.join(path.dirname(doc.path), `${doc.name}${format === "json" ? "-export" : ""}.${format}`),
  })
  if (res.canceled || !res.filePath) return
  const out = await engine.run("export", { path: res.filePath, format }, userCtx(doc.path))
  if (!out.ok) void dialog.showMessageBox({ type: "warning", message: "导出失败", detail: out.text })
  else shell.showItemInFolder(res.filePath)
}

/** The `arbor` executable: inside the app bundle when packaged, the repo's bin/ in development. */
function arborBin() {
  return app.isPackaged ? path.join(process.resourcesPath, "bin", "arbor") : path.join(app.getAppPath(), "bin", "arbor")
}

let menuKey: string | null = null

/** The app menu; rebuilt only when the recent parts change (the engine sends snapshots on every agent call). */
function refreshMenu() {
  const mac = process.platform === "darwin"
  const paths = engine.recentParts.filter((p) => existsSync(p)).slice(0, 10)
  const key = paths.join("\n")
  if (key === menuKey) return
  menuKey = key
  const recent: MenuItemConstructorOptions[] = paths.map((p) => ({ label: p.replace(os.homedir(), "~"), click: () => void openForUser(p) }))
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: PRODUCT,
            submenu: [
              { role: "about" as const },
              { label: "检查更新…", click: () => void updater.check(true) },
              {
                label: "自动检查更新",
                type: "checkbox" as const,
                checked: updater.supported && updater.autoUpdate,
                enabled: updater.supported,
                click: (item: Electron.MenuItem) => updater.setAutoUpdate(item.checked),
              },
              { type: "separator" as const },
              { label: "接入 Agent…", click: () => send("agent-setup") },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建零件…", accelerator: "CmdOrCtrl+N", click: () => void newPartDialog() },
        { label: "打开零件…", accelerator: "CmdOrCtrl+O", click: () => void openPartDialog() },
        { label: "打开最近", enabled: recent.length > 0, submenu: recent },
        { type: "separator" },
        { label: "导出 STEP…", accelerator: "CmdOrCtrl+E", click: () => void exportDialog("step") },
        { label: "导出 STL…", accelerator: "CmdOrCtrl+Shift+E", click: () => void exportDialog("stl") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        // The window decides: undo typing in a field, or undo the last change to the model.
        { label: "撤销", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "重做", accelerator: "Shift+CmdOrCtrl+Z", click: () => send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        ...(app.isPackaged ? [] : [{ role: "reload" as const }, { role: "toggleDevTools" as const }, { type: "separator" as const }]),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "接入 Agent…", click: () => send("agent-setup") }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function wireIpc() {
  ipcMain.handle("arbor:state", () => ({ snapshot: engine.snapshot(), doc: engine.docState(), pick: engine.pickRequest() }))
  ipcMain.handle("arbor:call", (_e, command: string, input: Record<string, unknown>, part?: string) => engine.run(command, input, userCtx(part)))
  ipcMain.handle("arbor:kernel", (_e, p: string, call: KernelCall) => engine.kernelCall(p, call))
  ipcMain.handle("arbor:answer-pick", (_e, id: string, answer: { info: PickInfo; text?: string } | null) => engine.answerPick(id, answer))
  ipcMain.handle("arbor:open-part", () => openPartDialog())
  ipcMain.handle("arbor:new-part", () => newPartDialog())
  ipcMain.handle("arbor:reveal", (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle("arbor:export", (_e, format: ExportFormat) => exportDialog(format))
  ipcMain.handle("arbor:agent-setup", () => agentSetup(arborBin()))
  ipcMain.handle("arbor:copy", (_e, text: string) => clipboard.writeText(String(text)))
  ipcMain.handle("arbor:update", () => updater.status())
  ipcMain.handle("arbor:restart-to-update", () => updater.restart())
  ipcMain.on("arbor:renderer-ready", () => markReady())
  ipcMain.on("arbor:look-done", (_e, id: number, res: { images?: string[]; error?: string }) => {
    const l = looks.get(id)
    if (!l) return
    looks.delete(id)
    if (res.images) l.resolve(res.images)
    else l.reject(new Error(res.error ?? "窗口没有画出视图"))
  })
  engine.on((e) => {
    win?.webContents.send("arbor:event", e)
    // The agent waits for a click: bring the window up and ask for attention.
    if (e.type === "pick" && e.request) {
      void ensureWindow().then((w) => {
        w.show()
        if (process.platform === "darwin") app.dock?.bounce("informational")
      })
    }
    if (e.type === "snapshot") refreshMenu()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", (_e, argv) => {
    const files = filesIn(argv)
    if (files.length) for (const f of files) void openForUser(f)
    if (!win) createWindow("focus")
    else if (!argv.includes("--from-agent")) win.show()
  })

  void app.whenReady().then(async () => {
    protocol.handle("arbor", async (req) => {
      const url = new URL(req.url)
      const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(url.pathname)))
      if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response("not found", { status: 404 })
      const res = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(res.headers)
      headers.set("Content-Security-Policy", CSP)
      return new Response(res.body, { status: res.status, headers })
    })
    wireIpc()
    refreshMenu()
    void kernel.start().catch(() => {})
    const rpc = await serveEngine(engine, __ARBOR_VERSION__)
    writeEngineInfo({ port: rpc.port, token: rpc.token, pid: process.pid, version: __ARBOR_VERSION__, startedAt: Date.now() })
    writeAppInfo({ exec: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] })
    engineReady = true
    createWindow(process.argv.includes("--from-agent") ? "inactive" : "focus")
    for (const f of pendingOpen.splice(0)) await openForUser(f)
    if (!engine.docState()) {
      const last = engine.recentParts.find((p) => existsSync(p))
      if (last) await engine.openForUser(last)
    }

    app.on("activate", () => {
      if (!win) createWindow("focus")
    })
    updater.start()
    app.on("will-quit", () => {
      updater.installOnQuit()
      clearEngineInfo(process.pid)
      engine.dispose()
      void rpc.close()
      void kernel.dispose()
    })
  })

  // The engine keeps serving agents with the window closed (macOS convention); `look` opens a new one.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
