// The world settles explicit allow/deny rules. An interaction that needs a
// permission answer is unmodelled, never silently permitted.
import type { Plugin } from "@opencode/plugin/effect"
import { Permission } from "@opencode/schema/permission"
import { Tool } from "@opencode/schema/tool"
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { Host } from "./host.ts"

type Assert = Plugin.Context["permission"]["assert"]
export const Blocked = Schema.TaggedStruct("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
})

const matches = (value: string, pattern: string) => value === pattern || pattern === "*"
const unsupportedPattern = (pattern: string) => pattern !== "*" && (pattern.includes("*") || pattern.includes("?"))

export const permissionAssert = (host: Host, unmodelled: (path: string) => () => Effect.Effect<never>): Assert =>
  (input) => Effect.gen(function* () {
    const session = yield* host.sessionOr(input.sessionID).pipe(
      Effect.mapError((error) => new Tool.Error({ message: `Session not found: ${error.sessionID}`, error })),
    )
    const id = Option.getOrElse(Option.fromUndefinedOr(input.agent), () => session.agent)
    const rules = Option.match(Option.fromUndefinedOr(host.agentsOf(session.directory).get(id)), {
      onNone: (): Permission.Ruleset => [{ action: "*", resource: "*", effect: "deny" }],
      onSome: (agent) => agent.permissions,
    })
    if (rules.some((rule) => unsupportedPattern(rule.action))) {
      return yield* unmodelled("ctx.permission.assert: action wildcard pattern")()
    }
    const relevant = rules.filter((rule) => matches(input.action, rule.action))
    if (relevant.some((rule) => unsupportedPattern(rule.resource))) {
      return yield* unmodelled("ctx.permission.assert: resource wildcard pattern")()
    }
    const outcomes = input.resources.map((resource) =>
      Option.map(Arr.findLast(relevant, (rule) => matches(resource, rule.resource)), ({ effect }) => effect),
    )
    if (outcomes.some((outcome) => Option.contains(outcome, "deny"))) {
      return yield* new Tool.Error({
        message: `Permission denied: ${input.action}`,
        error: Blocked.make({ rules: relevant, permission: input.action, resources: input.resources }),
      })
    }
    if (!outcomes.every((outcome) => Option.contains(outcome, "allow"))) {
      return yield* unmodelled("ctx.permission.assert: interactive approval")()
    }
  })
