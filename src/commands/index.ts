import { Command } from "effect/cli"

export const command = Command.make("baton").pipe(
  Command.withDescription("Relay the baton between herdr agents: whoever holds it works next"),
)
