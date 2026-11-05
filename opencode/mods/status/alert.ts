// What the TUI tells the owner from the pool's `alerts` answer
// (dotfiles-opencode.pool): the sidebar's warning lines while a login needs a
// sign-in again or the token endpoint keeps failing, and one toast for each
// occurrence of either. tui/alerts.ts asks the pool and shows these.
import { Schema } from "effect"
import type { SidebarLine } from "./sidebar.ts"

/**
 * The pool's `alerts` answer as the TUI reads it. The pool's `Alerts`
 * (`@dotfiles/opencode-pool/status`) carries these fields and more; the TUI
 * reads only these, so it needs no import of the pool's model.
 */
export const AlertsAnswer = Schema.Struct({
  lost: Schema.Array(
    Schema.Struct({
      credentialID: Schema.String,
      label: Schema.String,
      since: Schema.Number,
      command: Schema.String,
    }),
  ),
  outages: Schema.Array(
    Schema.Struct({
      pool: Schema.String,
      dir: Schema.String,
      since: Schema.Number,
      lastAt: Schema.Number,
      failures: Schema.Number,
      cause: Schema.optionalKey(
        Schema.Struct({
          status: Schema.optionalKey(Schema.Number),
          server: Schema.optionalKey(Schema.String),
          retryAfter: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
})
export type AlertsAnswer = typeof AlertsAnswer.Type
type Outage = AlertsAnswer["outages"][number]

/** An answer with nothing to tell. */
export const NO_ALERTS: AlertsAnswer = { lost: [], outages: [] }

/** One toast: a warning the owner reads once. */
export interface AlertToast {
  readonly key: string
  readonly title: string
  readonly message: string
}

const MINUTE = 60_000

/** How long a run has lasted, to the minute: `12m`, `1h 5m`. */
export const lasted = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** What the endpoint last said: `429 from cloudflare, retry-after 600`, or that it did not answer. */
export const causeText = (cause: Outage["cause"]) => {
  if (cause?.status === undefined) return "the token endpoint did not answer"
  const server = cause.server === undefined ? "" : ` from ${cause.server}`
  const retry = cause.retryAfter === undefined ? "" : `, retry-after ${cause.retryAfter}`
  return `${cause.status}${server}${retry}`
}

const lostKey = (login: AlertsAnswer["lost"][number]) => `lost:${login.credentialID}:${login.since}`
const outageKey = (outage: Outage) => `outage:${outage.pool}:${outage.dir}:${outage.since}`

/**
 * The lines the sidebar's Pool section draws first: for each lost login its
 * label and the command that signs it in again, for each outage how long it
 * has lasted and the cause. Nothing when the pool has no alert.
 */
export const alertLines = (answer: AlertsAnswer, now: number): ReadonlyArray<SidebarLine> => [
  ...answer.lost.flatMap((login): ReadonlyArray<SidebarLine> => [
    { text: `${login.label} · signed out`, tone: "error" },
    { text: `sign in again in gent: ${login.command}`, tone: "warning" },
  ]),
  ...answer.outages.map(
    (outage): SidebarLine => ({ text: `refresh failing ${lasted(now - outage.since)} · ${causeText(outage.cause)}`, tone: "error" }),
  ),
]

/** The toast for each alert: its key names the occurrence, so a new loss of the same login toasts again. */
export const alertToasts = (answer: AlertsAnswer, now: number): ReadonlyArray<AlertToast> => [
  ...answer.lost.map((login) => ({
    key: lostKey(login),
    title: `Pool login ${login.label} is signed out`,
    message: `The token endpoint refused its refresh token. Sign in again in gent: ${login.command}`,
  })),
  ...answer.outages.map((outage) => ({
    key: outageKey(outage),
    title: "Pool refreshes are failing",
    message: `Every refresh from ${outage.dir} has failed for ${lasted(now - outage.since)} (${outage.failures} ${outage.failures === 1 ? "try" : "tries"}); last: ${causeText(outage.cause)}.`,
  })),
]

/**
 * gent's login alert's rule: toast each alert the owner has not seen, and
 * forget the ones no longer listed, so one that clears and comes back toasts
 * again. `seen` is the keys toasted so far; the answer's `seen` replaces it.
 */
export const fresh = (
  seen: ReadonlySet<string>,
  answer: AlertsAnswer,
  now: number,
): { readonly toasts: ReadonlyArray<AlertToast>; readonly seen: ReadonlySet<string> } => {
  const toasts = alertToasts(answer, now)
  return { toasts: toasts.filter((toast) => !seen.has(toast.key)), seen: new Set(toasts.map((toast) => toast.key)) }
}
