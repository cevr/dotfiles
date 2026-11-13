// Run by sim/seed.test.ts as its own `bun test`, never by the gate: a seeded
// test that fails only on seed 77777, which sim/seeds.json lists for this file.
// The gate's run of it (no SIM_SEED, no swarm) must replay that seed and fail.
import { Effect } from "effect"
import * as Seed from "../seed.ts"

const { seeded } = Seed.runner("sim/fixtures/seeds-json.fixture.ts")

seeded("a seed sim/seeds.json lists is replayed", ({ seed, expect }) => Effect.sync(() => expect(seed).not.toBe(77777)))
