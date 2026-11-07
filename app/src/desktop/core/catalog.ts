// Every command the engine runs, registered once: name, description, zod
// input. The MCP server lists the agent's ones as tools, the CLI exposes them
// as `arbor call <name>`, and the window uses the user's ones over IPC.
import { z } from "zod"
import { EdgeSelector, FaceSelector, Num, Tree } from "../../studio/dsl"
import { SYSTEM_PROMPT } from "../../studio/prompt"
import { STARTERS } from "../../studio/starters"
import { DESKTOP_TOOLS, STUDIO_TOOLS } from "../../studio/tools"

/** agent: MCP / CLI; user: only the window; both: either. */
export type Audience = "agent" | "user" | "both"

export type CommandSpec = { name: string; description: string; input: z.ZodObject; audience: Audience }

const Target = z
  .object({
    face: FaceSelector.optional(),
    edge: EdgeSelector.optional(),
    feature: z.string().optional().describe("这个特征生成和修改的、现在仍存在的所有面（特征 id）"),
    part: z.string().optional().describe("一个零件、参考体，或在装配里改零件时上下文里的零件（名字）"),
  })
  .describe("量哪里：一个面（face）或一条边（edge，选择器要正好选中一个），一个特征的面（feature），或一个零件（part）")
const VIEWS = ["iso", "front", "top", "right", "back", "bottom", "left"] as const

/** Modelling tools of the web studio, as they are (look is replaced below: here it renders in the window). */
const studioTools: CommandSpec[] = Object.entries({ ...STUDIO_TOOLS, ...DESKTOP_TOOLS })
  .filter(([name]) => name !== "look")
  .map(([name, t]) => ({ name, description: typeof t.description === "string" ? t.description : "", input: t.inputSchema as z.ZodObject, audience: "both" as const }))

const own: CommandSpec[] = [
  {
    name: "guide",
    audience: "agent",
    description: "Arbor 的建模说明：工作流程、坐标约定、选择器写法。第一次用 Arbor 时先读一遍。",
    input: z.object({}),
  },
  {
    name: "open_part",
    audience: "both",
    description:
      "打开一个零件文件（*.arbor.json，就是特征树 JSON）或装配文件（*.arbor-asm.json），之后的命令都作用在它上面；Arbor 窗口会切到它。文件不存在时要新建就设 create=true，可以用 template 从现成的特征树开始。写 context（装配文件）就是在装配里改这个零件：装配里的其他零件按相对位置半透明地显示在旁边，可以 look、measure、check 它们（只读）；不写 context 再打开一次就退出。",
    input: z.object({
      path: z.string().describe("零件文件路径，相对当前目录或绝对路径，例如 parts/box.arbor.json；装配用 .arbor-asm.json 结尾"),
      create: z.boolean().optional().describe("文件不存在时新建"),
      context: z.string().optional().describe("在这个装配（.arbor-asm.json）里改这个零件：装配里要有一个 component 的 file 是它"),
      template: z
        .enum(STARTERS.map((s) => s.id) as [string, ...string[]])
        .optional()
        .describe(`新建时用的现成特征树：${STARTERS.map((s) => `${s.id}（${s.title}）`).join("；")}`),
    }),
  },
  {
    name: "list_parts",
    audience: "both",
    description: "列出 Arbor 里打开的零件：路径、特征数、未处理的备注数，以及哪个是当前零件。",
    input: z.object({}),
  },
  {
    name: "get_state",
    audience: "both",
    description: "当前零件的完整状态：参数、特征树和每步结果、实体尺寸、未处理的备注、最近谁改了什么。",
    input: z.object({}),
  },
  {
    name: "set_tree",
    audience: "both",
    description: "整体替换特征树（批量改、从别处拿来一棵树时用）。一步可以撤销。小改动优先用对应的特征工具或 edit_feature。",
    input: z.object({
      tree: Tree.describe("完整的特征树：{ params, paramNotes?, features }"),
      base_rev: z.number().int().optional().describe("基于哪个版本改的；中间有人改过模型就拒绝，避免覆盖别人的改动"),
    }),
  },
  {
    name: "move_feature",
    audience: "both",
    description: "调整特征顺序：by 为负往前移，为正往后移。不会越过它用到的或用到它的特征。",
    input: z.object({ id: z.string(), by: z.number().int().describe("移动几位，-1 = 往前一位") }),
  },
  {
    name: "undo",
    audience: "both",
    description: "撤销当前零件的上一次改动（不管是谁改的）。",
    input: z.object({}),
  },
  {
    name: "redo",
    audience: "both",
    description: "重做刚撤销的改动。",
    input: z.object({}),
  },
  {
    name: "look",
    audience: "agent",
    description:
      "在 Arbor 窗口里渲染当前模型的视图图片给你看，检查形状、位置和方向。窗口里未处理的备注会画成编号圆点。建完一个零件、改完备注指的地方，都要看一次。小的细节用 focus 放大，里面的结构用 section 剖开看；最后一步改动很小时会自动加一张特写。结果里写着每张图 1 px 多少 mm。",
    input: z.object({
      views: z.array(z.enum(VIEWS)).optional().describe("缺省 iso、front、top、right；写了 section 时缺省是正对截面的那一张加 iso；写了 focus 时缺省 iso、front"),
      highlight: z.string().optional().describe("高亮这个特征生成的面"),
      at: z.string().optional().describe("回滚到这个特征那一步看（缺省最新一步）"),
      notes: z.boolean().optional().describe("画出未处理备注的编号，缺省 true"),
      focus: z
        .union([z.string().describe("特征 id：框住它生成和修改的面"), z.object({ part: z.string().describe("零件名或参考体的名字") }), z.object({ faces: FaceSelector })])
        .optional()
        .describe("特写：每张图只框住这里（特征 id、{ part } 或 { faces }），看小细节时用"),
      section: z
        .object({
          plane: z.enum(["XY", "XZ", "YZ"]).describe("剖切的基准面：XY 去掉上面（+Z）一侧，XZ 去掉前面（-Y）一侧，YZ 去掉右面（+X）一侧"),
          offset: Num.optional().describe("基准面的偏移（XY 是 Z 值，XZ 是 Y 值，YZ 是 X 值），缺省过整件中心"),
        })
        .optional()
        .describe("剖视：切开看里面，例如零件之间的间隙、壁厚、内腔"),
      dir: z.array(z.number()).length(3).optional().describe("再加一张从这个方向看的图，例如 [1, 1, 0.3]"),
      size: z.enum(["normal", "large"]).optional().describe("large = 896×672（缺省 448×336）"),
      hide: z.array(z.string()).optional().describe("不画这些零件或参考体（按名字），例如藏起笔帽看里面"),
    }),
  },
  {
    name: "measure",
    audience: "both",
    description:
      "测量：一个面或边的尺寸（直径、面积、长度）和坐标（平面的中心、圆心、轴线、直线的端点），两个之间的最短距离、夹角、平行面间距、圆心距、轴线间距。也能量两个特征（feature）或两个零件（part）之间的最短距离，0 = 接触，零件相交时给出重叠体积。由内核算，不要自己推算。",
    input: z.object({ a: Target, b: Target.optional() }),
  },
  {
    name: "export",
    audience: "both",
    description:
      "导出当前零件或装配：step（实体；多个零件时一个文件里多个带名字的零件）/ stl（多个零件时打包成 zip，每个零件一个文件）、py（等价的 build123d 代码，装配不能导出）、json（特征树）、bom（零件清单 Markdown：名称、文件、数量、体积、外形）。",
    input: z.object({
      path: z.string().describe("输出文件路径，相对当前目录；扩展名决定格式，除非写了 format"),
      format: z.enum(["step", "stl", "py", "json", "bom"]).optional(),
    }),
  },
  {
    name: "share_params",
    audience: "both",
    description:
      "让当前零件或装配用一个共享参数文件（*.params.json）：几个零件写同一个文件，就共用这些尺寸（例如笔杆内径和笔舌直径）。共享参数以文件为准；之后 set_params 改到它们时会写回这个文件，用到它的零件都会重建。move 把零件自己的参数移进共享文件；stop 停用（当前值抄回零件）。",
    input: z.object({
      file: z.string().optional().describe("共享参数文件，相对零件文件所在的文件夹，例如 pen.params.json"),
      create: z.boolean().optional().describe("文件不存在时新建"),
      move: z.array(z.string()).optional().describe("把零件自己的这些参数移进共享文件"),
      stop: z.boolean().optional().describe("不再用共享参数文件"),
    }),
  },
  {
    name: "get_notes",
    audience: "both",
    description:
      "读用户在 Arbor 窗口里点在面或边上的备注：编号、写了什么、选中的是什么、一个已验证只选中它的选择器、草图坐标。直接用备注给的选择器，不要自己另写。",
    input: z.object({ status: z.enum(["open", "all"]).optional().describe("缺省只看未处理的") }),
  },
  {
    name: "resolve_note",
    audience: "both",
    description: "处理完一条备注后标为已处理，并用一句话告诉用户做了什么（显示在窗口里）。",
    input: z.object({
      id: z.string().describe("备注 id，例如 n3"),
      reply: z.string().max(400).optional(),
      reopen: z.boolean().optional().describe("重新打开"),
    }),
  },
  {
    name: "request_pick",
    audience: "agent",
    description:
      "请用户在 Arbor 窗口里点一个面或一条边，等用户点完返回它是什么和一个已验证的选择器。说不清用户指的是哪里时用它，比自己猜准。",
    input: z.object({
      prompt: z.string().max(200).describe("显示给用户的一句话，例如「点一下要开孔的那个面」"),
      kind: z.enum(["face", "edge", "any"]).optional(),
      timeout_sec: z.number().int().min(5).max(280).optional().describe("最多等多久，缺省 120 秒；没点就返回，可以再调用一次接着等"),
    }),
  },
  {
    name: "show",
    audience: "agent",
    description: "在 Arbor 窗口里高亮一个特征、一组面或边，指给用户看（例如「我说的是这两条边」）。clear=true 取消高亮。",
    input: z.object({
      feature: z.string().optional().describe("高亮这个特征生成的面"),
      faces: FaceSelector.optional(),
      edges: EdgeSelector.optional(),
      label: z.string().max(80).optional().describe("窗口里显示的说明"),
      clear: z.boolean().optional(),
    }),
  },
  // ---- the window only
  {
    name: "add_note",
    audience: "user",
    description: "记一条备注：在点选的面或边上（pick），或者关于整个零件、某个特征（不带 pick）。",
    input: z.object({ pick: z.record(z.string(), z.unknown()).optional(), text: z.string().max(600) }),
  },
  {
    name: "update_note",
    audience: "user",
    description: "改备注的文字，或删除、重开、标为已处理。",
    input: z.object({ id: z.string(), text: z.string().max(600).optional(), status: z.enum(["open", "resolved"]).optional(), remove: z.boolean().optional() }),
  },
  {
    name: "close_part",
    audience: "user",
    description: "关闭一个零件（文件不动）。",
    input: z.object({ path: z.string() }),
  },
]

export const COMMANDS: CommandSpec[] = [...own.slice(0, 2), ...studioTools, ...own.slice(2)]
export const COMMAND = new Map(COMMANDS.map((c) => [c.name, c]))

export const agentCommands = () => COMMANDS.filter((c) => c.audience !== "user")

/** JSON Schema of a command's input, for MCP `tools/list`. */
export function inputJsonSchema(spec: CommandSpec): Record<string, unknown> {
  const s = z.toJSONSchema(spec.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
  delete s.$schema
  return s
}

/** Inputs that name files: resolved against the caller's directory before they reach the engine. */
export const PATH_FIELDS: Record<string, string[]> = { open_part: ["path"], export: ["path"] }

/** The sections of the web studio's system prompt that are about modelling, not teaching. */
function promptSections(names: string[]) {
  const blocks = SYSTEM_PROMPT.split(/\n(?=## )/)
  return blocks.filter((b) => names.some((n) => b.startsWith(`## ${n}`))).join("\n\n")
}

export const AGENT_GUIDE = `# Arbor：用工具建参数化零件

零件是一棵特征树（JSON 文件 *.arbor.json）：参数表 + 有序的特征（草图、拉伸、旋转、圆角、抽壳、孔、阵列……），几何由 OpenCascade 内核算出。几个零件可以组成装配（*.arbor-asm.json），共用一个参数文件。用户在 Arbor 窗口里实时看到你的每一步，可以拖参数、改特征、在面或边上留备注。

这份说明较长；如果你看到的被截断了，先调用 guide 读全文（尤其是「零件和装配」「曲面和精细形状」两节）。

## 工作方式
0. 开建前先用一两句话说出：要建的是什么（例如「钢笔：有钢制笔尖的自来水笔」，不是圆珠笔）、由哪几个零件组成、做到什么程度、用单文件还是装配（见「零件和装配」）。拿不准是什么东西、要不要某个部件，先问用户。
1. 先 open_part（path 写零件文件，相对当前目录；新零件加 create: true）。窗口会切到这个零件。
2. set_params 把关键尺寸定成参数（短英文名），特征里用参数名或表达式引用；notes 给每个参数写一句说明。每个特征写 name（中文短名）和 intent（设计意图）。
3. 每次调用后读结果：✓ 继续；✗ 按提示用 edit_feature 修好，不要叠一个新特征绕开；⚠ 要处理。
4. 不确定选择器会选中什么时，先用 inspect（faces 或 edges，带同样的选择器）看一眼。
5. 需求里有具体数字时，建完调用 check：每个数值要求一项（外形 size、壁厚 thickness、孔 holes、距离 distance、节圆 pcd、角度 angle、体积 volume、坐标 position），said 写用户的原话，期望值写用户给的数字（不写参数名）。这些要求存进零件，之后每次重建都自动重算，窗口里也看得到。size 只量整个零件的外形；局部尺寸用 distance 或 thickness，让选择器正好选中要量的面。✗ 时先确认量的位置对不对；确实没做到再改模型，不要为了通过去改期望值。
   验证要看得到、量得出，不要只凭自己推算就说做好了：
   - 用 look 看外形和方向。结果里写着每张图 1 px 多少 mm：小于几个像素的细节看不清，用 focus（特征 id、{ part }、{ faces }）放大，用 section 剖开看里面（间隙、壁厚、内腔），用 hide 藏起挡住的零件。最后一步改动很小时会自动加一张特写，看它。不要说「请到窗口里放大看」就收尾。
   - 应该贴在一起的地方（笔尖压在笔舌上、盖子落在止口上），加一条 gap（a、b 写 face / edge / feature / part，max: 0 = 必须贴上；min = 至少隔多远）。
   - 两处之间的距离、某个面或孔在哪，用 measure（也能量两个特征或两个零件之间），不要自己算。
   - 每步结果里的 ⚠（没接上、只碰到边、极小碎面、零件重叠）要处理或说明。
6. 用户在窗口里留的备注用 get_notes 读，处理完用 resolve_note 写一句回复。说不清用户指的是哪个面时，用 request_pick 请用户在窗口里点一下；要指给用户看时用 show。
7. 结果开头写着「自你上次调用以来……」时，说明用户或文件改过模型：以最新状态为准，不要把用户的改动改回去。
8. 交付用 export（step / stl / py / json）。特征树文件也可以直接读写，保存后窗口会自动重建；改完文件用 get_state 看重建结果。

${promptSections(["数值", "坐标与基准面", "扫掠、放样、拔模", "建模习惯", "文字", "选择器"])}

## 零件和装配
| 情况 | 用什么 |
| --- | --- |
| 一个实体切开（外壳的底壳和上盖、超长的杆分段打印） | 单文件 + split |
| 最多 3 件紧密配合、共用很多尺寸的零件（笔尖和笔舌、盒子和盖板） | 单文件：加料时 part 写一个新名字 |
| 要复用的零件、标准件、外购件（STEP）、超过 3 件，或者体积大、要分开维护 | 多文件装配 |
- 单文件新建零件：加料（拉伸、旋转、扫掠、放样）写 part: "笔尖"，名字还不存在就新建一个零件，不和别的料合并（重叠会给 ⚠）。第一次加料写的 part 就是主体的名字；没写的话，主体叫「主体」。之后写 part 只改那个零件；修形、刻字只切它自己。
- 装配：每个零件一个文件（*.arbor.json），装配是 *.arbor-asm.json（open_part create: true 新建）。装配里只放 component：file 写零件文件、子装配或 .step 外购件，name 是它在装配里的名字，rotate、at 摆位置（先转后移，可以写参数）。装配不能放几何特征：要改形状就 open_part 打开那个零件。
- 共用尺寸：share_params 让零件和装配用同一个共享参数文件（*.params.json，move 把已有参数移进去）。共享参数以文件为准，set_params 改到它们会写回文件，用到它的零件一起重建。
- 在装配里改零件：open_part 带 context: "pen.arbor-asm.json"，装配里的其他零件按相对位置半透明地显示在旁边；look 能看到它们，measure 的 part、check 的 gap / clearance / interference 能写它们的名字。不带 context 再打开一次就退出。
- 装配建好后：check 用 gap 核对该贴上的地方、interference 核对不该相交的地方；look 用 hide 和 section 看里面；export 出 step、stl（多零件打包成 zip）和 bom（零件清单）。

## 曲面和精细形状
- 求交：拉伸、旋转、扫掠、放样写 mode: "intersect"，只留下和工具体重叠的部分（例如笔尖 = 半圆锥薄壳 ∩ 盾形轮廓）。有多个零件时写 part。
- 旋转：start 是起始角（从草图所在的位置按右手定则先转），symmetric: true 以草图为中线两侧各转一半。转一部分的回转面（例如只要朝 -Y 的半圈）用它们，不要把截面画到另一侧去凑。
- 草图点：{ "spline": [[x, y], …] } 是光滑样条（依次经过这些点），{ "to": [x, y], "r": 2 } 是倒 R2 圆角的拐角。笔尖肩部、笔夹末端这类有机曲线用它们，不要用三点圆弧拼。
- 沿面等深：拉伸写 onto（选中一个平面或圆柱面），草图投影到面上，切除时从面往里切 distance 深，加料时往外长 distance 高。圆柱面上刻字、凸字用它，各处深度一样；草图放在要刻的那一侧。

## 导入 STEP（开发板、元件的官方模型）
- import 读一个 STEP 文件，路径相对零件文件所在的文件夹（可以是子文件夹，如 "vendor/board.step"）。先用 import 把它放进来（缺省是参考体），再用 inspect body 或 get_state 看它的尺寸，用 rotate、at 摆到要的位置（先旋转后平移，单位 mm）。
- 参考体半透明显示，不并入零件、不导出，选择器也选不到它的面。围着它建外壳：用它的包围盒定尺寸，再把间隙做成参数。
- 核对配合用 check：clearance（ref 写 import 的 id，min 写最小间隙）和 interference（不能相交）。改了参数或外壳以后，它们每次重建都会重算。
- mode=cut 从实体里减去整个导入体（给元件挖让位槽，通常先把元件的外形放大一点更合适）；mode=add 并入实体。
- 文件换了新版本，窗口会自动重建。

## 做不到的
目前不支持真实的螺纹几何（螺纹孔只标装饰螺纹）、钣金、曲面加厚。装配只能用平移和旋转摆放，没有约束和运动。做不到就直说，并给出最接近的做法。不要编造工具没有的参数。`
