import { z } from "zod"
import { SCREW_SIZES } from "./holes"

/**
 * The studio's model: a parameter table plus an ordered feature tree, as plain
 * JSON. The AI edits it only through tools whose inputs are these schemas; the
 * kernel rebuilds it deterministically.
 *
 * Conventions (also in the system prompt): Z up, millimetres, degrees, origin
 * at the centre of the part's base.
 */

/** A number (mm or degrees) or a parameter expression such as "L/2+3" (rule stated once in the system prompt). */
export const Num = z.union([z.number(), z.string()])
// Plain fixed-length arrays rather than tuples: simpler JSON Schema for every provider.
export const Vec2 = z.array(Num).length(2).describe("[x, y]")
export const Vec3 = z.array(Num).length(3).describe("[x, y, z]")
export const Axis = z.enum(["X", "Y", "Z"])
export const Dir = z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"])
export const SurfaceKind = z.enum(["plane", "cylinder", "cone", "sphere", "torus", "freeform"])
export const CurveKind = z.enum(["line", "circle", "freeform"])
export const PlaneName = z.enum(["XY", "XZ", "YZ"])

const AtCoord = z
  .object({ axis: Axis, value: Num })
  .describe('中心落在这个坐标上，例如 { "axis": "Z", "value": "H" }')

const faceFields = {
  of: z.string().optional().describe("只选这个特征生成、且现在仍存在的面（特征 id）"),
  normal: Dir.optional().describe("平面的外法向"),
  kind: SurfaceKind.optional(),
  extreme: Dir.optional().describe('沿这个方向最靠外的面，例如 "+Z" = 最上面的面'),
  at: AtCoord.optional(),
  radius: Num.optional().describe("圆柱面、圆锥面或球面的半径"),
  near: Vec3.optional().describe("只保留离这个点最近的一个"),
}
const FaceBase = z.object(faceFields)

export const FaceSelector = z
  .object({
    ...faceFields,
    not: FaceBase.optional().describe("从结果里去掉满足这些条件的面"),
    expect: z.number().int().positive().optional().describe("预期选中几个；数量不符时报错并列出候选"),
  })
  .describe("按语义选面：所有条件同时满足。每次重建都重新解析，不依赖编号")

const edgeFields = {
  of: z.string().optional().describe("只选这个特征生成的面上的边（特征 id）"),
  faces: FaceSelector.optional().describe("只选这些面的边界边"),
  parallel: Axis.optional().describe("平行于这个轴的直线边"),
  kind: CurveKind.optional(),
  extreme: Dir.optional().describe('沿这个方向最靠外的边，例如 "+Z" = 最上面一圈边'),
  at: AtCoord.optional(),
  radius: Num.optional().describe("圆弧边的半径"),
  near: Vec3.optional().describe("只保留离这个点最近的一条"),
}
const EdgeBase = z.object(edgeFields)

export const EdgeSelector = z
  .object({
    ...edgeFields,
    not: EdgeBase.optional().describe('从结果里去掉满足这些条件的边，例如 { "extreme": "+Z" } = 除了最上面一圈'),
    expect: z.number().int().positive().optional().describe("预期选中几条；数量不符时报错并列出候选"),
  })
  .describe("按语义选边：所有条件同时满足。每次重建都重新解析，不依赖编号")

export const PlaneRef = z
  .object({
    plane: PlaneName.describe(
      "XY = 上视基准面（草图 x→X, y→Y，法向 +Z）；XZ = 前视基准面（x→X, y→Z，法向 -Y）；YZ = 右视基准面（x→Y, y→Z，法向 +X）",
    ),
    offset: Num.optional().describe("沿该基准面的坐标轴平移：XY 为 Z 值、XZ 为 Y 值、YZ 为 X 值"),
    face: FaceSelector.optional().describe(
      "贴在这个平面上。与 plane 平行时坐标沿用基准面，offset 从该面再算；不平行（斜面）时草图原点在这个面的中心，x 沿面内的水平方向，y 沿面往上，法向朝外",
    ),
    tilt: z
      .object({ axis: Axis, angle: Num.describe("角度，右手定则") })
      .optional()
      .describe("斜的基准面：把（平移后的）基准面绕过原点的这根坐标轴转一个角度"),
  })
  .describe("草图平面")

const Center = Vec2.optional().describe("中心，草图坐标，缺省 [0, 0]")

/** A point of a polyline or path as the site's assistant writes it: a corner, or a three-point arc. */
export const WebPoint = z.union([Vec2, z.object({ to: Vec2, via: Vec2.describe("圆弧经过的中间点") })])
/** Every point form (desktop agents): also a rounded corner and a smooth spline. */
export const Point = z.union([
  Vec2,
  z.object({ to: Vec2, via: Vec2.describe("圆弧经过的中间点") }),
  z.object({ to: Vec2, r: Num.describe("这个拐角倒的圆角半径") }).describe("走到 to，这个拐角倒 R 圆角"),
  z.object({ spline: z.array(Vec2).min(1).describe("依次光滑经过这些点，最后一个是终点") }).describe("从上一个点出发的光滑样条"),
])
export type Point = z.infer<typeof Point>
const Cut = z.boolean().optional().describe("从本草图前面的图形里挖掉（做出内孔）")

export const SketchShape = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rect"),
    w: Num.describe("宽（草图 x 方向）"),
    h: Num.describe("高（草图 y 方向）"),
    center: Center,
    r: Num.optional().describe("四角圆角半径"),
    cut: Cut,
  }),
  z.object({ type: z.literal("circle"), d: Num.describe("直径"), center: Center, cut: Cut }),
  z.object({
    type: z.literal("polygon"),
    sides: Num.describe("边数（≥3 的整数，可以写参数）"),
    d: Num.describe("外接圆直径"),
    center: Center,
    rotate: Num.optional(),
    cut: Cut,
  }),
  z.object({
    type: z.literal("slot"),
    length: Num.describe("总长（两端圆弧外缘之间）"),
    width: Num.describe("宽 = 两端圆弧直径"),
    center: Center,
    angle: Num.optional().describe("相对草图 x 轴的角度"),
    cut: Cut,
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(60).describe("文字内容（常用汉字、英文、数字和常用符号；\\n 换行）"),
    size: Num.describe("字号 mm：汉字高度约等于它，大写字母约 0.73 倍"),
    center: Vec2.optional().describe("文字外框的中心，草图坐标，缺省 [0, 0]"),
    angle: Num.optional().describe("相对草图 x 轴旋转的角度"),
    cut: Cut,
  }),
  z.object({
    type: z.literal("path"),
    points: z.array(Point).min(2).describe("开放的线，依次连接，不自动闭合；只能用于薄壁拉伸（thin）和筋（rib）"),
  }),
  z.object({
    type: z.literal("polyline"),
    points: z.array(Point).min(2).describe("依次连接并自动闭合；{to, via} 表示三点圆弧，{to, r} 是倒圆角的拐角，{spline: [...]} 是光滑样条"),
    cut: Cut,
  }),
])

const Base = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe('特征 id，英文，例如 "base", "pocket1"'),
  name: z.string().optional().describe('中文显示名，例如 "底座拉伸"'),
  intent: z.string().optional().describe("一句话设计意图：为什么这样做"),
  suppressed: z.boolean().optional().describe("压缩：暂时不参与重建（学习者在特征树里设置）"),
  part: z
    .string()
    .optional()
    .describe("零件名：只作用在这个零件上。加料时写一个还没有的名字，就新建一个零件（不和别的料合并）。有多个零件时不写：切除和孔作用在碰到的所有零件上，加料要正好接上一个零件"),
}
const Mode = z.enum(["add", "cut", "intersect"]).optional().describe("add = 加料（默认），cut = 切除，intersect = 求交（只留下和工具体重叠的部分）")
/** The site assistant's modes (intersect is desktop-only for now). */
export const WebMode = z.enum(["add", "cut"]).optional().describe("add = 加料（默认），cut = 切除")

export const Feature = z.discriminatedUnion("op", [
  z.object({ ...Base, op: z.literal("sketch"), on: PlaneRef, shapes: z.array(SketchShape).min(1) }),
  z.object({
    ...Base,
    op: z.literal("extrude"),
    sketch: z.string().describe("草图特征 id"),
    distance: Num.optional().describe("拉伸距离；用 until 或 through 时不写"),
    mode: Mode,
    direction: z.enum(["normal", "reverse", "both"]).optional().describe("normal = 沿草图法向（默认），reverse = 反向，both = 两侧对称"),
    through: z.boolean().optional().describe("切除时贯穿全部（不写 distance）"),
    until: z
      .union([
        z.literal("next").describe("成形到下一面：加料时一直长到碰到实体为止，切除时切到这段材料穿出为止"),
        z.object({ face: FaceSelector.describe("成形到这个面（要正好选中一个）"), offset: Num.optional().describe("停在离这个面多远的地方，正值 = 还没到") }),
      ])
      .optional()
      .describe("成形到：设计意图是「到那个面为止」，不用自己算距离（不写 distance）。不需要就不要写这个字段"),
    thin: z
      .object({
        t: Num.describe("壁厚"),
        side: z.enum(["center", "inside", "outside"]).optional().describe("厚度加在线的哪一侧：center = 两侧各一半（缺省）；inside = 向里（封闭轮廓向内，开放的线向拐弯的那一侧）"),
      })
      .optional()
      .describe("薄壁拉伸：只沿着轮廓线长出一圈等厚的壁；草图可以是开放的线（path）。普通的实心拉伸不要写这个字段"),
    draft: Num.optional().describe("拔模角（度）：正值让侧壁沿拉伸方向向内收，一步拉出锥形凸台或带斜度的槽。不需要斜度就不要写"),
    onto: FaceSelector.optional().describe(
      "沿这个面（平面或圆柱面，正好选中一个）的法向等深：草图沿草图法向投影到面上，切除时从面往里切 distance 深，加料时从面往外长 distance 高。圆柱面上刻字、凸字用它，各处深度一样。不需要就不要写",
    ),
  }),
  z.object({
    ...Base,
    op: z.literal("revolve"),
    sketch: z.string(),
    axis: Axis.describe("绕过原点的这根坐标轴旋转"),
    angle: Num.optional().describe("角度，缺省 360"),
    start: Num.optional().describe("起始角（度）：从草图所在的位置，绕轴按右手定则先转这么多再开始旋转"),
    symmetric: z.boolean().optional().describe("以草图所在的位置为中线，两侧各转 angle/2"),
    mode: Mode,
  }),
  z.object({ ...Base, op: z.literal("fillet"), edges: EdgeSelector, r: Num.describe("圆角半径") }),
  z.object({ ...Base, op: z.literal("chamfer"), edges: EdgeSelector, d: Num.describe("倒角距离") }),
  z.object({
    ...Base,
    op: z.literal("shell"),
    open: FaceSelector.describe("要去掉（开口）的面"),
    t: Num.describe("壁厚，向内"),
  }),
  z.object({
    ...Base,
    op: z.literal("hole"),
    on: PlaneRef.describe("孔口所在平面，孔沿法向的反方向钻进去"),
    at: z.array(Vec2).min(1).describe("孔中心，草图坐标"),
    d: Num.optional().describe("孔径；用 standard 时不填"),
    standard: z
      .object({
        size: z.enum(SCREW_SIZES).describe("公制螺纹规格"),
        fit: z.enum(["clearance", "close", "tap"]).optional().describe("clearance = 普通过孔（缺省），close = 精配过孔，tap = 螺纹孔：钻攻丝底孔并标出装饰螺纹"),
        head: z.enum(["cbore", "csink"]).optional().describe("过孔加沉头：cbore = 内六角圆柱头螺钉的沉孔，csink = 沉头螺钉的锥口"),
      })
      .optional()
      .describe("标准孔：按 ISO 公制螺钉自动定孔径、沉孔和螺纹，不用自己查表"),
    depth: Num.optional().describe("孔深，缺省贯穿"),
    cbore: z.object({ d: Num, depth: Num }).optional().describe("沉头孔（柱形沉孔）"),
    csink: z.object({ d: Num, angle: Num.optional() }).optional().describe("埋头孔（锥形，缺省 90°）"),
    reverse: z.boolean().optional().describe("沿法向钻（反过来）"),
  }),
  z.object({
    ...Base,
    op: z.literal("linear_pattern"),
    features: z.array(z.string()).min(1).describe("要复制的加料/切除/孔特征 id"),
    dir: Dir,
    count: Num.describe("总个数（含原来那个），≥2 的整数，可以写参数"),
    spacing: Num,
    dir2: Dir.optional(),
    count2: Num.optional().describe("第二方向的个数"),
    spacing2: Num.optional(),
  }),
  z.object({
    ...Base,
    op: z.literal("circular_pattern"),
    features: z.array(z.string()).min(1),
    axis: Axis.describe("绕过原点的这根轴"),
    count: Num.describe("总个数（含原来那个），≥2 的整数，可以写参数"),
    angle: Num.optional().describe("总角度，缺省 360（等分整圈）"),
  }),
  z.object({
    ...Base,
    op: z.literal("sweep"),
    path: z
      .object({
        on: PlaneRef.describe("路径所在的平面"),
        points: z.array(Point).min(2).describe("路径点（不闭合）；{to, via} 是三点圆弧，{spline: [...]} 是光滑样条"),
        corner: Num.optional().describe("直线拐角处自动倒的圆角半径（路径不能有尖角，否则截面会自交）"),
      })
      .describe("扫掠路径"),
    profile: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("circle"), d: Num }),
        z.object({ type: z.literal("rect"), w: Num.describe("在路径平面内的宽"), h: Num.describe("垂直于路径平面的高") }),
      ])
      .describe("截面：放在路径起点、垂直于路径"),
    mode: Mode,
  }),
  z.object({
    ...Base,
    op: z.literal("loft"),
    sketches: z.array(z.string()).min(2).describe("按顺序连接的草图（每个只能有一个闭合轮廓，通常画在一组平行的偏移平面上）"),
    ruled: z.boolean().optional().describe("true = 截面之间用直纹面（棱角分明），缺省光滑过渡"),
    mode: Mode,
  }),
  z.object({
    ...Base,
    op: z.literal("draft"),
    faces: FaceSelector.describe("要加拔模角的面（通常是侧壁）"),
    angle: Num.describe("拔模角，度；正值让侧壁朝开模方向向内收"),
    neutral: z
      .object({ plane: PlaneName, offset: Num.optional(), face: FaceSelector.optional().describe("用这个平面作中性面（例如不在基准面上的分型面）；写了它时 plane、offset 不用") })
      .describe("中性面：这里的尺寸保持不变，通常是分型面或底面"),
  }),
  z.object({
    ...Base,
    op: z.literal("split"),
    by: PlaneRef.describe("切面：写法和草图平面一样（基准面加偏移，或贴在一个平面上）"),
    parts: z.array(z.string().min(1).max(20)).length(2).describe("切开后两侧的零件名：先写切面法向背面一侧的，再写法向一侧的（XY 的法向是 +Z：先下后上）"),
    of: z.string().optional().describe("已经有多个零件时，要拆哪一个"),
  }),
  z.object({
    ...Base,
    op: z.literal("import"),
    file: z.string().min(1).max(200).describe("STEP 文件，相对零件文件所在的文件夹，例如 \"board.step\"。只在桌面版 Arbor 里能读文件"),
    mode: z
      .enum(["reference", "add", "cut"])
      .optional()
      .describe("reference = 参考体（缺省）：只显示、用来对齐和核对间隙、干涉，不并入零件也不导出；add = 并入实体；cut = 从实体里减去（按元件挖让位槽）"),
    rotate: z
      .array(z.object({ axis: Axis, angle: Num }))
      .max(3)
      .optional()
      .describe("依次绕过原点的坐标轴旋转，角度用度；先旋转、后平移"),
    at: Vec3.optional().describe("平移 [x, y, z]"),
  }),
  // Desktop (Arbor) only: an assembly (*.arbor-asm.json) is a tree of these, each a part file placed in it.
  z.object({
    ...Base,
    op: z.literal("component"),
    file: z
      .string()
      .min(1)
      .max(200)
      .describe("零件文件（.arbor.json）、子装配（.arbor-asm.json）或外购件（.step），相对装配文件所在的文件夹"),
    rotate: z
      .array(z.object({ axis: Axis, angle: Num }))
      .max(3)
      .optional()
      .describe("依次绕过原点的坐标轴旋转，角度用度；先旋转、后平移"),
    at: Vec3.optional().describe("平移 [x, y, z]，零件自己的原点放到这里"),
    hidden: z.boolean().optional().describe("先不显示（还在装配里，导出、核对照常）"),
  }),
  z.object({
    ...Base,
    op: z.literal("rib"),
    sketch: z.string().describe("只含一条开放的线（path）的草图，画在筋所在的平面上；线的两端可以不碰到实体，会自动延长到墙"),
    t: Num.describe("筋厚，在草图平面两侧各一半"),
    flip: z.boolean().optional().describe("材料长在线的另一侧（两侧都被实体围住、自动判断不明确时才用）"),
  }),
  z.object({
    ...Base,
    op: z.literal("mirror"),
    plane: PlaneName,
    offset: Num.optional(),
    features: z.array(z.string()).optional().describe("要镜像的加料/切除/孔特征；缺省镜像整个实体"),
  }),
])

export type Feature = z.infer<typeof Feature>
export type FeatureOp = Feature["op"]
export type FaceSelector = z.infer<typeof FaceSelector>
export type EdgeSelector = z.infer<typeof EdgeSelector>
export type PlaneRef = z.infer<typeof PlaneRef>
export type SketchShape = z.infer<typeof SketchShape>

const Said = z.string().describe("学习者的原话片段，如「壁厚 2」")
const Pick = z.object({ face: FaceSelector.optional(), edge: EdgeSelector.optional() }).describe("量哪里：一个面（face）或一条边（edge），选择器要正好选中一个")
const Where = z
  .object({
    face: FaceSelector.optional(),
    edge: EdgeSelector.optional(),
    feature: z.string().optional().describe("这个特征生成和修改的、现在仍存在的所有面（特征 id）"),
    part: z.string().optional().describe("零件名，或参考体（import 的 id 或名字）"),
  })
  .describe("一处：face 或 edge（选择器正好选中一个）、feature 或 part，写一个")
const CheckBase = { id: z.string().describe("短英文 id，如 size、wall、holes；同 id 会覆盖原来那一项"), said: Said, tol: z.number().positive().optional().describe("容差，缺省长度 0.01 mm、角度 0.05°") }

/** A requirement the learner stated, measured by the kernel on every rebuild (expected values are plain numbers). */
export const Check = z.discriminatedUnion("kind", [
  z.object({ ...CheckBase, kind: z.literal("size"), expect: z.array(z.number()).length(3).describe("沿 X、Y、Z 的外形尺寸"), axes: z.enum(["xyz", "any"]).optional().describe("any = 不管方向，排序后比较") }),
  z.object({ ...CheckBase, kind: z.literal("thickness"), faces: FaceSelector.describe("壁的一侧的面（平面）"), expect: z.number() }),
  z.object({
    ...CheckBase,
    kind: z.literal("holes"),
    faces: FaceSelector.describe("孔壁的圆柱面，例如 { kind: \"cylinder\", of: \"h1\" }"),
    count: z.number().int().positive(),
    d: z.number().optional().describe("孔径"),
    thread: z.string().optional().describe("螺纹规格，如 M4：按攻丝底孔核对"),
  }),
  z.object({ ...CheckBase, kind: z.literal("distance"), a: Pick, b: Pick, expect: z.number() }),
  z.object({ ...CheckBase, kind: z.literal("pcd"), faces: FaceSelector.describe("各个孔的圆柱面"), count: z.number().int().positive(), expect: z.number().describe("节圆直径"), axis: z.enum(["X", "Y", "Z"]).optional() }),
  z.object({ ...CheckBase, kind: z.literal("angle"), a: FaceSelector, b: FaceSelector, expect: z.number() }),
  z.object({ ...CheckBase, kind: z.literal("volume"), min: z.number().optional(), max: z.number().optional() }),
  // Against a reference body brought in with `import` (desktop app): fit around a board, a part to mate with.
  z.object({ ...CheckBase, kind: z.literal("clearance"), ref: z.string().describe("参考体的特征 id（import），或一个零件的名字"), min: z.number().describe("和它之间最小的间隙，mm") }),
  z.object({ ...CheckBase, kind: z.literal("interference"), ref: z.string().describe("参考体的特征 id（import），或一个零件的名字：其余部分不能和它相交") }),
  // Desktop (Arbor) only for now: left out of the site assistant's `check` (tools.ts).
  z.object({
    ...CheckBase,
    kind: z.literal("position"),
    at: Pick,
    axis: z.enum(["X", "Y", "Z"]).optional().describe("只核对这一个坐标；不写时核对 [x, y, z]"),
    expect: z.union([z.number(), z.array(z.number()).length(3)]).describe("写了 axis 时是一个数，没写时是 [x, y, z]"),
  }),
  z.object({
    ...CheckBase,
    kind: z.literal("gap"),
    a: Where,
    b: Where,
    min: z.number().optional().describe("至少隔这么远（相交就不过）"),
    max: z.number().optional().describe("最多隔这么远；0 = 必须贴上"),
  }),
])

/** Check kinds only the desktop app's agents get (the site's assistant keeps its tested set). */
export const DESKTOP_CHECKS = new Set(["position", "gap"])
export type Check = z.infer<typeof Check>

export const Tree = z.object({
  /** Desktop (Arbor): a shared parameter file (*.params.json) next to the part; its parameters win over the part's own. */
  uses: z.string().min(1).max(200).optional(),
  params: z.record(z.string(), Num),
  /** One line per parameter for people (「总长，沿 X」); never used in calculations. */
  paramNotes: z.record(z.string(), z.string()).optional(),
  features: z.array(Feature),
  /** The learner's numeric requirements, re-measured on every rebuild. */
  checks: z.array(Check).optional(),
})
export type Tree = z.infer<typeof Tree>

export const EMPTY_TREE: Tree = { params: {}, features: [] }

/** Chinese op names as used across the site (ops.ts). */
export const OP_NAMES: Record<FeatureOp, string> = {
  sketch: "草图",
  extrude: "拉伸",
  revolve: "旋转",
  fillet: "圆角",
  chamfer: "倒角",
  shell: "抽壳",
  hole: "孔",
  linear_pattern: "线性阵列",
  circular_pattern: "圆周阵列",
  mirror: "镜像",
  sweep: "扫掠",
  loft: "放样",
  draft: "拔模",
  rib: "筋",
  split: "拆件",
  import: "导入",
  component: "零件",
}

/** Display name: the model's own name, else 「拉伸2」 style numbering. */
export function displayName(tree: Tree, f: Feature) {
  if (f.name) return f.name
  const same = tree.features.filter((x) => x.op === f.op)
  return `${OP_NAMES[f.op]}${same.indexOf(f) + 1}`
}

/** Features that add or remove material through a tool body (patternable). */
export const TOOL_OPS: FeatureOp[] = ["extrude", "revolve", "hole", "sweep", "loft"]
