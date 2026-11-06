// OpenCode's Subagents over a stand-in for the host's `session.get`, which
// fails for a session it does not know.
import { Effect } from "effect"
import { subagentsLaws } from "../laws.ts"
import * as OpenCodeSubagents from "./subagents.ts"

subagentsLaws("OpenCode's Subagents", (world) =>
  OpenCodeSubagents.layer((sessionID) =>
    Object.hasOwn(world, sessionID) ? Effect.succeed(world[sessionID]) : Effect.fail(new Error(`Session not found: ${sessionID}`)),
  ),
)
