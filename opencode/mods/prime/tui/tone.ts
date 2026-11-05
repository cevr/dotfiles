// The colour of each tone the domain names, in the theme in use: hue only
// where the reader must look.
import type { RGBA } from "@opentui/core"
import type { Palette } from "./host.ts"

/** A failure in the error colour, a cancel or warning in the warning colour, a good end in the success colour, `base` in the normal text colour, the rest muted. */
export function toneColor(
  theme: Palette,
  tone: "base" | "muted" | "error" | "warning" | "success" | "info" | "accent",
): RGBA {
  if (tone === "base") return theme.text.base
  if (tone === "error") return theme.text.feedback.error.base
  if (tone === "warning") return theme.text.feedback.warning.base
  if (tone === "success") return theme.text.feedback.success.base
  if (tone === "info") return theme.text.feedback.info.base
  if (tone === "accent") return theme.hue.accent[300]
  return theme.text.muted
}
