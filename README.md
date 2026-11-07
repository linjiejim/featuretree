# FeatureTree · 工业建模互动课

看懂每一个特征是怎么长出来的。

线上：<https://featuretree.linjiejim.com>（部署见 `docs/deploy.md`）

FeatureTree 是一个中文、讲概念、不绑定软件的 3D 工业建模学习网站。每个建模概念配一个能亲手操作的 3D 场景；真实零件按特征树一步步重建，几何由 OpenCascade 内核算出，每个面都标明是哪一步生成或修改的。

## 有什么

| 板块 | 内容 |
| --- | --- |
| 互动课 `/lesson/:id` | 21 节，覆盖坐标与视图、基准面、三视图、剖视、尺寸标注、公差与配合、GD&T、草图约束、旋转、阵列、圆角、扫掠放样、特征树、装配自由度、3D 打印、钣金、注塑拔模、曲率连续和斑马纹。一步一个概念：视角自动转到该看的地方，任务在 3D 里完成（点平面、拖角点、拉箭头、拖剖切面），关键处先猜再看，最后是带解释的小测。 |
| 图文卡 `/card/:code` | 17 张，覆盖 T0–T2 里不需要 3D 的课：文件格式、单位与材料、孔与螺纹、重建报错、配置、外部参考等。几段短文、一张示意图或对照表、2–3 道小测，每张卡列出参考来源。 |
| 案例拆解 `/teardown/:id` | 7 个零件（马克杯、积木砖、两种做法的小盒子、键帽、直齿轮、温湿度计底壳）和 2 个装配（桌面温湿度计、带铰链盒子）。零件按特征树回滚、播放；新生成的面蓝色、被修改的面橙色；每一步的 build123d 代码；参数沙盒里每组参数都在内核里算过，失败的组合不隐藏，并解释为什么失败。装配可以爆炸、按装配顺序播放、剖切，保留自由度的零件可以拖动。 |
| 学习路径 `/learn` | 6 条轨、96 节课的大纲，按人群给入口，已有互动课、拆解或图文卡的课可以直接进入；到期复习（1 天 / 1 周 / 3 周）。 |
| 工具图鉴 `/atlas` | 18 个建模命令：悬停回放生成过程，抽屉里调参数，8 个软件的官方中文叫法。 |
| 术语表 `/glossary` | 命令对照表和 28 张概念卡。 |
| AI 建模工作台 `/studio`（Beta） | 用中文描述零件，AI 助教（默认 DeepSeek `deepseek-flash`）调用 13 种建模特征和查询工具，一步步建出参数化特征树，并讲清每一步的设计意图。几何在浏览器里由 OpenCascade（replicad）算出：每一步可以回滚，面按「新生成 / 被修改」着色并能看出来自哪个特征，参数直接改，导出 STEP、STL 和等价的 build123d 代码。可以附参考图，也有「边做边学」模式（关键步骤先让你预测）。不用 AI 也能从现成的特征树开始。 |
| 桌面版 **Arbor**（`desktop/`） | 让本机的 coding agent（Claude Code、Codex……）通过 MCP 或命令行建模：38 个建模、观测、核对和协作工具，同一套特征树和内核；几个零件文件可以共用参数、组成装配一起看和核对；能导入开发板、元件的 STEP 模型，围着它建外壳并核对间隙和干涉。你在窗口里实时看每一步、拖参数、改特征，在面或边上留备注给 agent；agent 也能请你在模型上点一下。零件是可以进 git 的 `.arbor.json` 文件。macOS 版从 [Releases](https://github.com/linjiejim/featuretree/releases/latest) 下载，装好后会自动更新。见 [`desktop/README.md`](desktop/README.md)。 |

当前进度、验证结果、已知局限和开源前清单见 [`docs/report.md`](docs/report.md)。

## 目录

```
app/                 网站：React 19 + Vite 8 + TypeScript + Tailwind v4 + three.js r187
  src/three/         轻量 CAD 视口引擎：按需渲染、主题配色、视图方块、剖切、烘焙模型加载
  src/content/       课程（lessons/）、命令与术语、课程大纲
  src/studio/        AI 建模工作台：特征树格式、浏览器内核（Worker）、工具、提示词
  src/desktop/       桌面版 Arbor 的引擎核心（core/）和窗口
  server/            工作台的对话 API（Hono + AI SDK，只转发对话）
  e2e/               Playwright 冒烟测试
  public/models/     烘焙好的模型（manifest.json + 每组参数一个 GLB）
desktop/             桌面版 Arbor：Electron 主进程、MCP 服务和 arbor 命令行、打包
models/              build123d 模型源码和烘焙器 ftbake
docs/
  report.md          完成报告：做了什么、怎么验证、局限、下一步
  research/          调研报告和 6 份原始笔记
  proposal.md        原型方案
  DESIGN.md          设计规范（基于 jim-uiux）
  dev/               写课程、写模型的说明
  deploy.md          部署
spikes/              浏览器内 OCCT 内核（replicad）实测
```

## 开发

```bash
cd app
npm install --registry=https://registry.npmmirror.com   # 本机代理慢时 npmjs 会卡住
npm run dev        # http://localhost:5287
STUDIO_MOCK=1 npm run dev:api   # 工作台的对话 API（脚本模型，不需要 key；真模型见 docs/dev/studio.md）
npm run check      # 类型检查 + lint + 设计守卫 + 单元测试
npm run build
npm run e2e        # 冒烟测试：构建后在 http://127.0.0.1:4391 起 vite preview，用 Playwright 跑
```

冒烟测试（`app/e2e/`）走一遍每节课（逐步点「下一步」、交小测、完成本课）和每个拆解（逐步回滚、切参数、装配爆炸和播放），再看首页、学习路径、图鉴和术语表。课程从 `src/content/lessons/index.ts`、模型从 `public/models/index.json` 自动发现，新增内容不用改测试。任何页面报错、`console.error` 或画布空白都算失败，失败截图按路由命名，在 `test-results/` 和 `npx playwright show-report` 里看。

- 第一次跑先装浏览器：`npx playwright install chromium`。本机下载慢时加 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`；还是装不上，用本机的 Google Chrome：`E2E_CHANNEL=chrome npm run e2e`。
- 只跑一部分：`npx playwright test -g revolve`；看着跑：`npm run e2e:ui`。端口被占用时设 `E2E_PORT`。
- WebGL 用 SwiftShader 软件渲染，不需要显卡。
- CI（`.github/workflows/ci.yml`）在每个 PR 和非 main 分支的推送上跑 check、build 和 e2e；部署（`deploy.yml`）也先跑 e2e，不通过不发布。失败时报告作为 `playwright-report` 制品上传。

改了 `models/` 才需要 Python：

```bash
python3 -m venv .venv && .venv/bin/pip install -r models/requirements.txt
cd app && npm run bake
```

- 写一节课、一张图文卡：`docs/dev/lesson-authoring.md`
- 写一个拆解模型：`docs/dev/models.md`
- AI 建模工作台：`docs/dev/studio.md`

## 技术取舍

- **拆解的几何离线烘焙。** 实测 replicad（OpenCascade 的 WebAssembly 版）压缩后约 4.8 MB（brotli），内存会涨到约 1 GB，随机参数下约 30% 的组合会失败（`docs/research/notes/kernel_spike.md`）。所以拆解模型用 build123d 写一份，离线把每个特征、每组沙盒参数都算好，网页只下载看到的那一份 GLB。
- **只有工作台在浏览器里跑内核。** 对话建模需要即时重算，内核放在 Web Worker 里，只在 `/studio` 加载；服务器只转发对话，不碰几何。特征树是 JSON，AI 只能通过有 schema 的工具改它，不执行模型写的代码；选面选边用语义选择器，每次重建重新解析，避开拓扑命名问题。
- **课程里的示意几何是程序化的。** 拉伸、旋转、圆角这些演示用 three.js 直接生成，参数一拖就变；草图约束课用 FreeCAD 的求解器 planegcs（WebAssembly）。
- **设计系统** 基于 [jim-uiux](https://design.linjiejim.com)，强调色「工程蓝」，亮暗两套。

## 许可

- **代码**用 MIT，见 [`LICENSE`](LICENSE)：
  - 网站 `app/`
  - 桌面版 `desktop/`（含图标）
  - 模型与烘焙器 `models/`
  - 烘焙出的 GLB
  - `spikes/`
- **课程文字和文档**用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)，见 [`LICENSE-content`](LICENSE-content)：
  - 课程讲解和小测
  - 术语表和概念卡
  - 命令说明
  - 课程大纲
  - 拆解讲解
  - `docs/`，包括调研

同一个文件里两种都有时（例如课程的 `.tsx`），代码按 MIT，给学习者读的文字按 CC BY 4.0。转载课程文字请注明出处 FeatureTree 和许可协议。

## 第三方

完整清单、版本和链接见 [`THIRD_PARTY.md`](THIRD_PARTY.md)。要点：

- **随网站发布**：
  - three.js、React、React Router、Radix UI、Tailwind CSS：MIT。
  - Lucide：ISC。
  - Inter、JetBrains Mono：OFL 1.1。
  - @salusoft89/planegcs：LGPL-2.1。它是独立的 wasm 文件，只在约束课按需加载；源码见 <https://github.com/Salusoft89/planegcs>。
- **只在离线烘焙时用，不随网站发布**：
  - build123d：Apache-2.0。
  - OCP：Apache-2.0。
  - Open CASCADE Technology：LGPL-2.1，附 OCCT 例外条款。
- **`app/src/components/ui/`**：来自作者的 jim-uiux 设计系统（基于 shadcn/ui，MIT）。
