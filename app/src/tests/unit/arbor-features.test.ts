// Arbor, part three of the agent-modelling spec (docs/specs/2026-11-07-arbor-agent-modeling.md):
// intersect, revolve start / symmetric, spline and rounded-corner sketch points, and cutting or
// adding at an even depth along a face (`onto`).
import { beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { toBuild123d } from "@/studio/codegen"
import type { Feature, Tree } from "@/studio/dsl"
import { Kernel } from "@/studio/kernel/build"
import { initNodeKernel } from "@/studio/kernel/node"
import { DESKTOP_TOOLS, STUDIO_TOOLS } from "@/studio/tools"

let k: Kernel
beforeAll(async () => {
  await initNodeKernel()
  k = new Kernel()
}, 60_000)

const build = (features: Feature[], params: Tree["params"] = {}) => k.rebuild({ params, features })
const states = (r: ReturnType<typeof build>) => r.features.map((f) => `${f.id}:${f.state}${f.message ? ` ${f.message}` : ""}`)

describe("intersect", () => {
  it("keeps only what the tool and the body share", () => {
    const r = build([
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "rect", w: 20, h: 20 }] },
      { id: "box", op: "extrude", sketch: "s", distance: 20 },
      { id: "c", op: "sketch", on: { plane: "XY", offset: -10 }, shapes: [{ type: "circle", d: 20 }] },
      { id: "cyl", op: "extrude", sketch: "c", distance: 40, mode: "intersect" },
    ])
    expect(states(r)).toEqual(["s:ok", "box:ok", "c:ok", "cyl:ok"])
    expect(r.body?.volume).toBeCloseTo(Math.PI * 100 * 20, 0)
    expect(r.features[3].summary).toMatch(/^求交/)
  })

  it("says so when nothing is left, and won't pattern an intersection", () => {
    const base: Feature[] = [
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "rect", w: 20, h: 20 }] },
      { id: "box", op: "extrude", sketch: "s", distance: 20 },
    ]
    let r = build([...base, { id: "c", op: "sketch", on: { plane: "XY", offset: 50 }, shapes: [{ type: "circle", d: 5 }] }, { id: "x", op: "extrude", sketch: "c", distance: 5, mode: "intersect" }])
    expect(r.features[3].message).toMatch(/求交后什么都没剩下/)
    r = build([
      ...base,
      { id: "c", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: 15 }] },
      { id: "x", op: "extrude", sketch: "c", distance: 20, mode: "intersect" },
      { id: "p", op: "linear_pattern", features: ["x"], dir: "+X", count: 2, spacing: 5 },
    ])
    expect(r.features[4].message).toMatch(/求交的特征不能阵列或镜像/)
  })
})

describe("revolve start and symmetric", () => {
  const ring = (extra: Record<string, unknown>) =>
    build([
      { id: "s", op: "sketch", on: { plane: "XZ" }, shapes: [{ type: "rect", w: 5, h: 4, center: [7.5, 2] }] },
      { id: "r", op: "revolve", sketch: "s", axis: "Z", angle: 180, ...extra } as Feature,
    ])

  it("turns the start of a partial revolve", () => {
    const plain = ring({})
    expect(plain.body?.bbox[0][1]).toBeCloseTo(0, 3)
    expect(plain.body?.bbox[1][1]).toBeCloseTo(10, 3)
    const turned = ring({ start: 90 })
    expect(turned.body?.bbox[1][0]).toBeCloseTo(0, 3)
    expect(turned.body?.bbox[0][0]).toBeCloseTo(-10, 3)
    expect(turned.features[1].summary).toMatch(/从 90° 起/)
    const sym = ring({ symmetric: true })
    expect(sym.body?.bbox[0][0]).toBeCloseTo(0, 3)
    expect(sym.body?.bbox[0][1]).toBeCloseTo(-10, 3)
    expect(sym.body?.bbox[1][1]).toBeCloseTo(10, 3)
    expect(ring({ start: 10, symmetric: true }).features[1].message).toMatch(/start 和 symmetric 只写一个/)
  })
})

describe("spline and rounded-corner points", () => {
  it("draws a smooth bulge and a rounded corner in a closed outline", () => {
    const plate = (points: unknown[]) =>
      build([
        { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "polyline", points } as never] },
        { id: "e", op: "extrude", sketch: "s", distance: 1 },
      ])
    const square = plate([[0, 0], [20, 0], [20, 20], [0, 20]])
    expect(square.body?.volume).toBeCloseTo(400, 3)
    const bulge = plate([[0, 0], [20, 0], { spline: [[25, 10], [20, 20]] }, [0, 20]])
    expect(states(bulge)).toEqual(["s:ok", "e:ok"])
    expect(bulge.body!.bbox[1][0]).toBeGreaterThan(25)
    expect(k.inspect("faces", undefined, { kind: "freeform" })).toMatch(/自由曲面/)
    const round = plate([[0, 0], { to: [20, 0], r: 3 }, [20, 20], [0, 20]])
    expect(states(round)).toEqual(["s:ok", "e:ok"])
    // A corner rounded by R3 loses 9 − 9π/4 ≈ 1.93 mm².
    expect(round.body!.volume).toBeCloseTo(400 - (9 - (9 * Math.PI) / 4), 1)
  })

  it("follows a spline in an open path (thin walls) and a sweep path", () => {
    const r = build([
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "path", points: [[0, 0], { spline: [[10, 5], [20, 0]] }] }] },
      { id: "w", op: "extrude", sketch: "s", distance: 5, thin: { t: 1 } },
      { id: "sw", op: "sweep", path: { on: { plane: "XZ" }, points: [[30, 0], { spline: [[35, 10], [30, 20]] }] }, profile: { type: "circle", d: 2 } },
    ])
    expect(states(r)).toEqual(["s:ok", "w:ok", "sw:ok"])
    expect(r.body!.bbox[1][1]).toBeGreaterThan(4)
  })
})

describe("onto: an even depth along a face", () => {
  const capWithRect = (mode: "cut" | "add") =>
    build([
      { id: "c", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: 20 }] },
      { id: "cap", op: "extrude", sketch: "c", distance: 40 },
      { id: "t", op: "sketch", on: { plane: "XZ", offset: -20 }, shapes: [{ type: "rect", w: 10, h: 10, center: [0, 20] }] },
      { id: "mark", op: "extrude", sketch: "t", distance: 1, mode, direction: "reverse", onto: { of: "cap", kind: "cylinder" } },
    ])

  it("cuts into a cylinder so the floor is a cylinder 1 mm in (not a flat cut)", () => {
    const r = capWithRect("cut")
    expect(states(r)).toEqual(["c:ok", "cap:ok", "t:ok", "mark:ok"])
    expect(r.features[3].summary).toMatch(/沿圆柱面（R10）等深 1 mm/)
    expect(k.inspect("faces", undefined, { of: "mark", kind: "cylinder" })).toMatch(/R9\b/)
    expect(k.inspect("faces", undefined, { of: "mark", kind: "plane", normal: "-Y" })).toMatch(/没有面满足/)
    // Only the side the sketch faces (y < 0), not the back of the cap too.
    expect(k.inspect("faces", undefined, { of: "mark", kind: "cylinder" })).not.toMatch(/中心\([^)]*, [0-9.]+, /)
  })

  it("raises lettering off a cylinder the same height everywhere", () => {
    const r = capWithRect("add")
    expect(states(r)).toEqual(["c:ok", "cap:ok", "t:ok", "mark:ok"])
    expect(k.inspect("faces", undefined, { of: "mark", kind: "cylinder" })).toMatch(/R11\b/)
    expect(r.body?.size[1]).toBeCloseTo(21, 3)
  })

  it("goes outward into the material round a bore, and refuses other surfaces", () => {
    const r = build([
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "rect", w: 40, h: 40 }] },
      { id: "b", op: "extrude", sketch: "s", distance: 20 },
      { id: "h", op: "hole", on: { plane: "XY", offset: 20 }, at: [[0, 0]], d: 10 },
      { id: "t", op: "sketch", on: { plane: "XZ" }, shapes: [{ type: "rect", w: 4, h: 4, center: [0, 10] }] },
      { id: "g", op: "extrude", sketch: "t", distance: 1, mode: "cut", direction: "both", onto: { of: "h", kind: "cylinder" } },
    ])
    expect(states(r)).toEqual(["s:ok", "b:ok", "h:ok", "t:ok", "g:ok"])
    expect(k.inspect("faces", undefined, { of: "g", kind: "cylinder" })).toMatch(/R6\b/)
    const bad = build([
      { id: "s", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: 20 }] },
      { id: "b", op: "extrude", sketch: "s", distance: 20 },
      { id: "f", op: "fillet", edges: { kind: "circle", extreme: "+Z" }, r: 3 },
      { id: "t", op: "sketch", on: { plane: "XZ", offset: -20 }, shapes: [{ type: "rect", w: 2, h: 2, center: [0, 19] }] },
      { id: "g", op: "extrude", sketch: "t", distance: 0.5, mode: "cut", direction: "reverse", onto: { of: "f" } },
    ])
    expect(bad.features[4].message).toMatch(/onto 只支持平面和圆柱面/)
  })
})

describe("exports and the site assistant", () => {
  it("writes the new forms as build123d", () => {
    const code = toBuild123d({
      params: {},
      features: [
        { id: "s", op: "sketch", on: { plane: "XZ" }, shapes: [{ type: "polyline", points: [[0, 0], { to: [5, 0], r: 1 }, { spline: [[6, 5], [5, 10]] }, [0, 10]] }] },
        { id: "r", op: "revolve", sketch: "s", axis: "Z", angle: 180, symmetric: true },
        { id: "c", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: 8 }] },
        { id: "x", op: "extrude", sketch: "c", distance: 10, mode: "intersect" },
      ],
    })
    expect(code).toMatch(/Spline\(\(5, 0\), \(6, 5\), \(5, 10\)\)/)
    expect(code).toMatch(/\.rotate\(Axis\.Z, -\(180\) \/ 2\)/)
    expect(code).toMatch(/part = part & tool_x/)
    expect(code).toMatch(/round_corners\(make_face\(\[[^\n]*\]\), \[\(\(5, 0\), 1\)\]\)/)
    // An even-depth cut exports as the same intersection.
    const onto = toBuild123d({
      params: {},
      features: [
        { id: "c", op: "sketch", on: { plane: "XY" }, shapes: [{ type: "circle", d: 20 }] },
        { id: "cap", op: "extrude", sketch: "c", distance: 40 },
        { id: "t", op: "sketch", on: { plane: "XZ", offset: -20 }, shapes: [{ type: "text", text: "A", size: 5 }] },
        { id: "m", op: "extrude", sketch: "t", distance: 1, mode: "cut", onto: { kind: "cylinder" } },
      ],
    })
    expect(onto).toMatch(/^plane_t = Plane\.XZ/m)
    expect(onto).toMatch(/^sk_t = plane_t \* /m)
    expect(onto).toMatch(/tool_m = extrude\(sk_t, amount=1000, both=True\) & onto_band\(.*\[0\], 1, cut=True, plane=plane_t\)$/m)
    expect(onto).toMatch(/side = \(plane\.origin - axis\.position\)\.dot\(plane\.z_dir\)/)
  })

  it("keeps the new fields out of the site assistant's tools, and gives them to the desktop agents", () => {
    const json = (tools: Record<string, { inputSchema: unknown }>) =>
      JSON.stringify(Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, z.toJSONSchema(t.inputSchema as z.ZodType, { io: "input", unrepresentable: "any" })])))
    const web = json(STUDIO_TOOLS as unknown as Record<string, { inputSchema: unknown }>)
    const desk = json(DESKTOP_TOOLS as unknown as Record<string, { inputSchema: unknown }>)
    for (const word of ['"intersect"', '"onto"', '"symmetric"', '"spline"', '"component"']) {
      expect(web).not.toContain(word)
      expect(desk).toContain(word)
    }
    // Nor in the descriptions the site's assistant reads.
    expect(web).not.toMatch(/spline|样条|拐角倒|\{to, r\}|求交|等深/)
  })
})
