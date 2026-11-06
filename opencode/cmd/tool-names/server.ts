/**
 * Tool names as an OpenCode server plugin. The composition root: it answers
 * the tool registry's `execute.before` hook for a call of a tool that does not
 * exist. When the name is a case or one-edit miss of exactly one real tool, or
 * of that tool's provider alias (`@dotfiles/opencode-tool-names/near-miss`),
 * the call fails with the name to call instead; any other call is untouched,
 * and OpenCode answers an unknown name as before.
 *
 * It answers rather than runs the real tool: the other plugins' hooks have
 * already read the wrong name, so a renamed call would pass the guard and
 * orchestrate unseen. OpenCode's own `bash` → `shell` alias (its input-repair
 * plugin) runs before this hook and is left alone.
 *
 * No options.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { misnamed, nearest } from "@dotfiles/opencode-tool-names/near-miss"

export default Plugin.define({
  id: "dotfiles-opencode.tool-names",
  effect: Effect.fn("ToolNames.plugin")(function* (ctx) {
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        // Code Mode's outer tool is built per request, not registered, so it is never in the list.
        if (event.tool === "execute") return
        const tools = (yield* ctx.tool.list()).map((tool) => tool.id)
        const match = nearest(event.tool, tools)
        if (match === undefined) return
        return yield* new Tool.Error({ message: misnamed(event.tool, match) })
      }),
    )
  }),
})
