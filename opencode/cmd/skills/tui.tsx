/**
 * `$<skill>`'s TUI plugin: the composer's `$` popup. The composition root of
 * the TUI half: it registers the popup (`@dotfiles/opencode-skills/tui/popup`)
 * on the host's plugin autocomplete. Typing `$` at a word start lists the
 * skills with their tiers; selecting one inserts `$<id>` and attaches it.
 *
 * A host without plugin autocomplete (`ui.autocomplete`, the fork's
 * `feat(tui): plugin autocomplete triggers`) gets no popup; a typed `$<id>`
 * still loads its skill through the server half.
 */
import { Plugin } from "@opencode/plugin/tui"
import { popup, type Source } from "@dotfiles/opencode-skills/tui/popup"

/**
 * The host's UI as far as this plugin needs it: the popup registration, where
 * it has one. `toast`, which every host has, keeps the type from being all
 * optional, which TypeScript would refuse to match a host without it against.
 */
interface Host {
  readonly toast: unknown
  readonly autocomplete?: (source: Source) => () => void
}

export default Plugin.define({
  id: "dotfiles-opencode.skills",
  setup(ctx) {
    const ui: Host = ctx.ui
    if (!ui.autocomplete) return
    const { source, stop } = popup(ctx)
    const remove = ui.autocomplete(source)
    return () => {
      remove()
      stop()
    }
  },
})
