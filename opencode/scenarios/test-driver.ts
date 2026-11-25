import { OpenCodeDriver as NativeDriver } from "opencode-drive"
import type { Effect } from "effect"
import { testHostEnv } from "../scripts/test-host.ts"

export { Llm } from "opencode-drive"
export type Driver = NativeDriver.Driver

/** Library scenarios use the same host policy whether run alone or through accept. */
export const OpenCodeDriver = {
  use: <A, E, R>(
    options: NativeDriver.Options,
    run: (driver: Driver) => Effect.Effect<A, E, R>,
    watching?: Parameters<typeof testHostEnv>[0],
  ) => NativeDriver.use({
    ...options,
    opencode: { ...options.opencode, env: { ...options.opencode?.env, ...testHostEnv(watching) } },
  }, run),
}
