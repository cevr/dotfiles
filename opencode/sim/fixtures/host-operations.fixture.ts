// Never loaded: law-check negative controls without argument facts.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export const planted = (ctx: Plugin.Context) => Effect.gen(function* () {
  const { list: allPlugins } = ctx.plugin
  const refresh = ctx.reference.reload
  const { transform: changeReference } = ctx.reference
  const editSkills = ctx.skill.transform
  yield* allPlugins()
  yield* refresh()
  yield* ctx["command"]["reload"]()
  yield* changeReference(() => Effect.void)
  yield* editSkills(() => Effect.void)
  yield* ctx.skill.list()
})
