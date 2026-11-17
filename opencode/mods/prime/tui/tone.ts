// The colour of each tone the domain names, in the theme in use: hue only
// where the reader must look.
import { RGBA, TextAttributes } from "@opentui/core"
import type { Form } from "../emphasis.ts"
import type { Palette } from "./host.ts"

/** How far a soft chip's ground leans from the background toward its tone. */
export const CHIP_TINT = 0.22

/** A chip's colours and attributes: one cell style for its whole width. */
export interface ChipColors {
  readonly fg: RGBA
  readonly bg: RGBA
  readonly attributes: number
}

/** The ground a tint leans from: the theme's background when it is opaque, else black (Prime's is the terminal's own). */
function ground(theme: Palette) {
  if (theme.background.base.a >= 1) return theme.background.base
  return RGBA.fromValues(0, 0, 0, 1)
}

const mix = (from: RGBA, to: RGBA, amount: number) =>
  RGBA.fromValues(from.r + (to.r - from.r) * amount, from.g + (to.g - from.g) * amount, from.b + (to.b - from.b) * amount, 1)

/**
 * A chip in a reply (emphasis.ts): `soft`, its tone on a ground the tone
 * tints `CHIP_TINT` of the way; `solid`, the ground's colour, bold, on the
 * tone itself.
 */
export function chipColors(theme: Palette, tone: "success" | "warning" | "error" | "info" | "muted", form: Form): ChipColors {
  const color = toneColor(theme, tone)
  if (form === "solid") return { fg: ground(theme), bg: color, attributes: TextAttributes.BOLD }
  return { fg: color, bg: mix(ground(theme), color, CHIP_TINT), attributes: 0 }
}

/** A subagent role's colour: each orchestrate role its own, a worker the success colour, other agents muted or plain. */
export function roleColor(theme: Palette, tone: "planner" | "implementor" | "verifier" | "worker" | "general" | "other"): RGBA {
  if (tone === "planner") return theme.hue.interactive[300]
  if (tone === "implementor") return theme.hue.accent[300]
  if (tone === "verifier") return theme.text.feedback.info.base
  if (tone === "worker") return theme.text.feedback.success.base
  if (tone === "general") return theme.text.muted
  return theme.text.base
}

/** A failure in the error colour, a cancel or warning in the warning colour, a good end in the success colour, `base` in the normal text colour, `faint` the dimmest, the rest muted. */
export function toneColor(
  theme: Palette,
  tone: "base" | "muted" | "faint" | "error" | "warning" | "success" | "info" | "accent",
): RGBA {
  if (tone === "base") return theme.text.base
  if (tone === "faint") return theme.text.faint
  if (tone === "error") return theme.text.feedback.error.base
  if (tone === "warning") return theme.text.feedback.warning.base
  if (tone === "success") return theme.text.feedback.success.base
  if (tone === "info") return theme.text.feedback.info.base
  if (tone === "accent") return theme.hue.accent[300]
  return theme.text.muted
}
