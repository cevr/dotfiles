import { Effect, Option } from "effect"
import { checkoutsLaws } from "../laws.ts"
import * as MemoryCheckouts from "./checkouts.ts"

const ORIGIN = "https://github.com/owner/app.git"
const SOURCES = [{ path: "/workspaces/app", origin: Option.some(ORIGIN) }]
const CHECKOUTS = [
  { root: "/work/app", filesystem: "ext4", origin: Option.some(ORIGIN) },
  { root: "/work/app/vendor/lib", filesystem: "ext4", origin: Option.none<string>() },
]

const bench = { repo: "/work/app", origin: ORIGIN, filesystem: "ext4", inside: "/work/app/src", bare: "/work/app/vendor/lib", plain: "/work/plain", missing: "/work/nowhere" }

checkoutsLaws("memory Checkouts", () =>
  Effect.succeed({ ...bench, layer: MemoryCheckouts.layer({ checkouts: CHECKOUTS, warmSources: SOURCES }), sources: SOURCES }),
)

checkoutsLaws("memory Checkouts whose warm sources cannot be listed", () =>
  Effect.succeed({ ...bench, layer: MemoryCheckouts.layer({ checkouts: CHECKOUTS, warmSources: SOURCES, sourcesFail: true }), sources: "unreadable" as const }),
)
