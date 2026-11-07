import { tool, type ToolSet } from "ai"
import { z } from "zod"
import { Check, DESKTOP_CHECKS, EdgeSelector, FaceSelector, Feature, Num, SketchShape, WebMode, WebPoint, type FeatureOp } from "./dsl"

/**
 * The tools the model may call. Shared by the server (schemas + how results
 * are shown to the model) and the browser, which executes them against the
 * kernel (client-side tools: no `execute` here).
 */

const OP_DOCS: Record<FeatureOp, string> = {
  component:
    "装配里放一个零件：file 写零件文件（.arbor.json）、子装配（.arbor-asm.json）或外购件（.step），name 是它在装配里的名字，用 rotate、at 摆到位置（先旋转后平移）。只能用在装配文件（.arbor-asm.json）里；要改零件的形状，用 open_part 打开它的文件（加 context 写装配文件，就能看着其他零件改）。",
  sketch: "在基准面（或贴在某个平面上）画一个闭合草图，可以由多个图形组合，cut=true 的图形挖掉前面的图形；图形也可以是文字（刻字、凸字）。草图本身不改变实体。",
  extrude: "把草图沿法向拉伸成实体：mode=add 加料、mode=cut 切除；direction=both 两侧对称（distance 是两侧加起来的总长）；through=true 切除贯穿；until 成形到下一面或某个面（柱子要长到上面的板时用 until: \"next\"，不要自己算距离）；thin 薄壁（等厚的壁，开放的线 path 也能用）；draft 拔模角（锥形凸台、带斜度的槽）。",
  revolve: "把草图绕过原点的一根坐标轴旋转成回转体。轮廓只能在轴的一侧（可以贴着轴）。",
  fillet: "对选中的边做圆角。用语义选择器选边；半径不能大于相邻面的宽度或壁厚。外观圆角通常放在最后。",
  chamfer: "对选中的边做倒角（等距）。",
  shell: "抽壳：去掉 open 选中的面作为开口，向内留壁厚 t。注意抽壳前的外圆角半径要大于壁厚，内侧才有圆角。",
  hole: "在平面上打孔（简单孔 / 沉头孔 / 埋头孔），孔沿平面法向的反方向钻入；reverse=true 反过来。",
  linear_pattern: "把加料、切除或孔特征沿方向复制成一排（可选第二方向成阵列）。",
  circular_pattern: "把加料、切除或孔特征绕过原点的坐标轴等分复制一圈（或指定总角度）。",
  mirror: "关于基准面镜像：给 features 时镜像这些特征，不给时镜像整个实体并合并。",
  sweep: "扫掠：圆形或矩形截面沿一条平面路径走一遍（把手、管子、线槽）。路径拐弯要圆滑，拐弯半径要大于截面半宽。",
  loft: "放样：在两个以上的截面草图之间生成过渡实体（例如方变圆、键帽）。截面画在平行的偏移平面上。",
  draft: "拔模：给侧壁加脱模斜度（注塑件常用 1–3°），中性面上的尺寸不变。先拔模、后倒圆角。",
  split: "拆件：用一个平面把实体切成两个有名字的零件（例如外壳拆成底壳和上盖、太长的杆切成两段打印）。之后的特征可以写 part 只改一个零件；切除和孔不写 part 时作用在碰到的所有零件上（螺丝孔穿过两件）。",
  rib: "筋（加强筋）：草图里画一条开放的线（path），在线所在的平面上长出厚 t 的筋，线的两端会自动延长到墙，材料长在被实体围住的那一侧（例如 L 形支架的三角筋）。",
  import:
    "导入一个 STEP 文件（例如开发板、元件的官方模型）。缺省作参考体：半透明显示，用来对齐尺寸、核对间隙（check 的 clearance）和干涉（interference），不并入零件也不导出；mode=add 并入实体，mode=cut 从实体里减去（按元件挖让位槽）。用 rotate、at 摆到位置上。",
}

/** Ops only the desktop app (Arbor) runs: they read files next to the part. Not offered to the site's assistant. */
export const DESKTOP_OPS = new Set<FeatureOp>(["import", "component"])

/** The site assistant's check items: without the desktop-only kinds. */
const WebCheck = z.discriminatedUnion(
  "kind",
  Check.options.filter((o) => !DESKTOP_CHECKS.has(o.shape.kind.value)) as unknown as [(typeof Check.options)[number], ...(typeof Check.options)[number][]],
)

const checkTool = (items: z.ZodType) =>
  tool({
    description:
      "核对学习者提出的数值要求：每项由内核实际量出来，返回 ✓ / ✗，之后每次重建都会自动重算。学习者的话里有具体数值时，建模结束前必须调用一次。size 只量整个零件的外形（包围盒）；某一部分的尺寸（筋的高度、立板的厚度、孔距）用 distance 选两个面，或 thickness 选壁的一侧，选择器加 of、normal，正好选中要量的那个面。",
    inputSchema: z.object({
      items: z.array(items).max(20).optional().describe("要核对的项；期望值只写学习者给的数字，不写参数名"),
      remove: z.array(z.string()).optional().describe("学习者不再要求的项的 id"),
    }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  })

type FeatureSchema = (typeof Feature.options)[number]

/** Sketch shapes as the site's assistant writes them: polyline and path points without splines or rounded corners. */
const WebSketchShape = z.discriminatedUnion(
  "type",
  SketchShape.options.map((o) =>
    o.shape.type.value === "polyline" || o.shape.type.value === "path"
      ? (o as z.ZodObject).extend({
          points: z
            .array(WebPoint)
            .min(2)
            .describe(o.shape.type.value === "path" ? "开放的线，依次连接，不自动闭合；只能用于薄壁拉伸（thin）和筋（rib）" : "依次连接并自动闭合；{to, via} 表示三点圆弧"),
        })
      : o,
  ) as unknown as [(typeof SketchShape.options)[number], ...(typeof SketchShape.options)[number][]],
)

/**
 * A feature's input as the site's assistant sees it: without what only the desktop app's agents get so far
 * (intersect, revolve start / symmetric, extrude onto, spline and rounded-corner points). Its evals cover
 * the rest; these go to it once they're evaluated there.
 */
function webShape(schema: FeatureSchema): Record<string, z.ZodType> {
  const { op: _op, ...shape } = schema.shape as Record<string, z.ZodType>
  void _op
  const out: Record<string, z.ZodType> = { ...shape }
  if ("mode" in out && out.mode !== undefined && schema.shape.op.value !== "import") out.mode = WebMode
  delete out.onto
  delete out.start
  delete out.symmetric
  if (schema.shape.op.value === "sketch") out.shapes = z.array(WebSketchShape).min(1)
  if (schema.shape.op.value === "sweep") {
    const path = (schema.shape as { path: z.ZodObject }).path
    out.path = path.extend({ points: z.array(WebPoint).min(2).describe("路径点（不闭合）；{to, via} 是三点圆弧") }).describe(path.description ?? "")
  }
  return out
}

const AFTER = z.string().optional().describe("插到这个特征后面；缺省加在最后")

function featureTool(op: FeatureOp, shape: Record<string, z.ZodType>) {
  return tool({
    description: OP_DOCS[op],
    inputSchema: z.object({ ...shape, after: AFTER }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  })
}

/** Every feature with every field: the desktop app's agents. */
const featureTools = Object.fromEntries(
  Feature.options.map((schema) => {
    const { op: opField, ...shape } = schema.shape
    return [opField.value, featureTool(opField.value as FeatureOp, shape as Record<string, z.ZodType>)]
  }),
) as Record<FeatureOp, ReturnType<typeof tool>>

/** The site's assistant: without the desktop-only ops and fields. */
const webFeatureTools = Object.fromEntries(
  Feature.options.flatMap((schema) => {
    const op = schema.shape.op.value as FeatureOp
    return DESKTOP_OPS.has(op) ? [] : [[op, featureTool(op, webShape(schema))]]
  }),
) as Record<Exclude<FeatureOp, "import" | "component">, ReturnType<typeof tool>>

/** Tools of the desktop app's agents on top of STUDIO_TOOLS (see DESKTOP_OPS); `check` replaces the site's with every kind. */
export const DESKTOP_TOOLS = {
  ...featureTools,
  set_params: tool({
    description:
      "新建、修改或删除命名参数。值可以是数字或引用其他参数的表达式（如 \"L-2*t\"）。关键尺寸都应该做成参数，特征里用参数名引用。零件用了共享参数文件（share_params）时，共享参数文件里已有的名字会写回那个文件；shared: true 把这次 set 的参数都写进共享文件。",
    inputSchema: z.object({
      set: z.record(z.string(), Num).optional().describe("要新建或修改的参数"),
      remove: z.array(z.string()).optional().describe("要删除的参数名"),
      notes: z
        .record(z.string(), z.string())
        .optional()
        .describe('参数说明，给学习者看：每个新参数一句短中文，说清是什么尺寸、沿哪个方向，如 { "L": "总长，沿 X", "t": "壁厚" }'),
      shared: z.boolean().optional().describe("写进共享参数文件（零件要先用 share_params 指定共享参数文件）"),
    }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  }),
  check: checkTool(Check),
} satisfies ToolSet

export const STUDIO_TOOLS = {
  set_params: tool({
    description:
      "新建、修改或删除命名参数。值可以是数字或引用其他参数的表达式（如 \"L-2*t\"）。关键尺寸都应该做成参数，特征里用参数名引用。",
    inputSchema: z.object({
      set: z.record(z.string(), Num).optional().describe("要新建或修改的参数"),
      remove: z.array(z.string()).optional().describe("要删除的参数名"),
      notes: z
        .record(z.string(), z.string())
        .optional()
        .describe('参数说明，给学习者看：每个新参数一句短中文，说清是什么尺寸、沿哪个方向，如 { "L": "总长，沿 X", "t": "壁厚" }'),
    }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  }),
  ...webFeatureTools,
  edit_feature: tool({
    description: "修改已有特征的字段（只写要改的字段，嵌套对象整体替换）。修复失败的特征时优先用它，不要再加一个新特征。",
    inputSchema: z.object({
      id: z.string(),
      changes: z.record(z.string(), z.unknown()).describe("要改的字段，例如 { \"r\": 3 } 或 { \"edges\": { \"parallel\": \"Z\" } }；写 null 删掉一个字段，例如 { \"thin\": null }"),
    }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  }),
  delete_feature: tool({
    description: "删除一个特征。如果后面有特征引用它，会报错并列出这些特征；cascade=true 时一起删除。",
    inputSchema: z.object({ id: z.string(), cascade: z.boolean().optional() }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  }),
  check: checkTool(WebCheck),
  inspect: tool({
    description:
      "查看当前模型：tree = 特征树和每步结果；body = 包围盒、体积、质心；faces / edges = 列出面或边（可用选择器过滤），用来确认选择器会选中什么。",
    inputSchema: z.object({
      what: z.enum(["tree", "body", "faces", "edges"]),
      faces: FaceSelector.optional().describe("what=faces 时的过滤条件"),
      edges: EdgeSelector.optional().describe("what=edges 时的过滤条件"),
    }),
    toModelOutput: ({ output }) => ({ type: "text", value: textOf(output) }),
  }),
  look: tool({
    description: "渲染当前模型的视图图片给你看，用来检查形状、位置和方向是否符合预期。建完一个零件后至少看一次。",
    inputSchema: z.object({
      views: z.array(z.enum(["iso", "front", "top", "right"])).optional().describe("缺省四个视图都要"),
      highlight: z.string().optional().describe("高亮这个特征生成的面"),
    }),
    toModelOutput: ({ output }) => {
      const o = output as ToolOutput
      if (!o?.images?.length) return { type: "text", value: textOf(output) }
      return {
        type: "content",
        value: [
          { type: "text", text: textOf(output) },
          ...o.images.map((img) => ({ type: "file" as const, mediaType: "image/png", data: { type: "data" as const, data: img.split(",")[1] ?? img } })),
        ],
      }
    },
  }),
} satisfies ToolSet

export type StudioToolName = keyof typeof STUDIO_TOOLS

/** What the browser returns for every tool call. */
export type ToolOutput = {
  ok: boolean
  text: string
  /** look: PNG data URLs. Dropped from older turns before they reach the model. */
  images?: string[]
}

function textOf(output: unknown) {
  const o = output as ToolOutput
  return typeof o?.text === "string" ? o.text : JSON.stringify(output)
}
