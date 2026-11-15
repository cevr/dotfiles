// One way to say usage, everywhere the owner or an agent reads it: the share
// of a window USED, out of 100%. Never a bare "X%", and never room, left or
// remaining as a percent; a threshold and a rate say the same. The status
// mod's pane and sidebar, fenced off from the pool, write the short form
// `23%/100% used` themselves (mods/status/pane.ts `usedShort`).
import { DateTime, Match } from "effect"

/** A share (0 to 1) as whole percent: `0.23` → `23%`. */
export const percent = (share: number) => `${Math.round(share * 100)}%`

/** A window's use: `23% used of 100%`. */
export const used = (share: number) => `${percent(share)} used of 100%`

/** A threshold a start holds at: `holds at 90% used of 100%`. */
export const holdsAt = (share: number) => `holds at ${used(share)}`

/** A burn, as use, after a verb (`it uses …`, `they use …`): `0.85% of a week per hour`. */
export const perHour = (share: number, of: string, digits = 2) => `${(share * 100).toFixed(digits)}% of ${of} per hour`

/** A time as the owner reads it: `2026-11-15 18:00Z`. */
export const iso = (at: number) => `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 16).replace("T", " ")}Z`

/** A word by count: `one` for exactly 1, else `many`. */
export const byCount = (count: number, one: string, many: string) =>
  Match.value(count).pipe(
    Match.when(1, () => one),
    Match.orElse(() => many),
  )
