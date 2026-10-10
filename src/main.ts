import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import packageJson from "../package.json" with { type: "json" }
import { Baton } from "./Baton.js"
import { command } from "./commands/index.js"
import { Herdr } from "./services/Herdr.js"
import { Journal } from "./services/Journal.js"
import { Shell } from "./services/Shell.js"

const ShellLive = Shell.layer.pipe(Layer.provide(BunServices.layer))

const MainLayer = Baton.layer.pipe(
  Layer.provide(Herdr.layer),
  Layer.provideMerge(ShellLive),
  Layer.provide(Journal.layer),
  Layer.provideMerge(BunServices.layer),
)

Command.run(command, { version: packageJson.version }).pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain,
)
