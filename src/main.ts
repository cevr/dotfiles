import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/cli"
import packageJson from "../package.json" with { type: "json" }
import { command } from "./commands/index.js"

Command.run(command, { version: packageJson.version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
