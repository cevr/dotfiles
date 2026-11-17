import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Paid, Request } from "./request.ts"
import { label, Route, route } from "./route.ts"

const request = (overrides: Partial<Request>): Request => ({
  prompt: "a red cube",
  images: [],
  path: "/out/cube.png",
  size: "1536x1024",
  format: "png",
  models: ["gpt-6.1-sol", "gpt-6-sol"],
  paid: Option.none(),
  ...overrides,
})

const flare: Paid = { model: "flare", quality: Option.some("high"), background: Option.none(), n: Option.none(), mask: Option.none() }

describe("route", () => {
  test("a request without paid goes to the subscription, whatever else it holds", () => {
    const everything = request({ images: ["/a.png", "/b.png"], format: "webp", size: "1024x1024" })
    expect(route(everything)).toEqual(Route.Subscription({ models: ["gpt-6.1-sol", "gpt-6-sol"] }))
    expect(label(route(everything))).toBe("subscription")
  })

  test("a request with paid goes to the paid API: a generation without images, an edit with them", () => {
    expect(route(request({ paid: Option.some(flare) }))).toEqual(Route.Paid({ paid: flare, edit: false }))
    expect(route(request({ images: ["/a.png"], paid: Option.some(flare) }))).toEqual(Route.Paid({ paid: flare, edit: true }))
  })

  test("the label names the paid model, its quality and count", () => {
    expect(label(route(request({ paid: Option.some(flare) })))).toBe("paid: gpt-image-2.5-flare, quality high, n 1")
    const sunburst: Paid = { ...flare, model: "sunburst", quality: Option.none(), n: Option.some(3) }
    expect(label(route(request({ images: ["/a.png"], paid: Option.some(sunburst) })))).toBe("paid edit: gpt-image-2.5-sunburst, quality auto, n 3")
  })
})
