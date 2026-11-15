// Strobe bench: switching session tabs in the OpenCode TUI on big sessions.
//
// The variants are OpenCode fork checkouts (folders): the TUI runs from each one's source, on
// strobe's terminal, against one server both sides share (a fixture, from TAB_PERF_SERVER's
// checkout) on a clone of TAB_PERF_DB, a database `perf/tab-fixture.ts` built: four families the
// size of the workbox's biggest (55k, 53k, 11k and 450 messages, 1,037 sessions), content scrubbed.
// Each run presses next-tab (alt+down) once per tab, so it ends on the tab it started on, and waits
// for the switch's frame and then for the screen to settle after each press.
//
//   TAB_PERF_DB=<fixture .db> [TAB_PERF_SERVER=<fork checkout>] \
//     bunx @hona/strobe bench perf/tab-switch.bench.ts --base <fork checkout> --head <fork checkout>
//
// The server's checkout defaults to the prime-look Rift. The fixture's shell reads both variables, so
// the bench file itself reads no environment. The tabs are the fixture's four roots.
import { bench, fixture, tty } from "@hona/strobe"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { Array as Arr, Effect } from "effect"
import * as Strobe from "./strobe.ts"

const TABS = ["ses_e57343009ffebQR5YMhIizQp4p", "ses_e56d092fbffecuJAf4VA7aKc8I", "ses_e56d092fcffez3oEv21QWdVO8W", "ses_e56d56026ffeausgl0ycmBCr56"]
// The TUI plugins the workbox's cli.json loads, in its order.
const PLUGINS = ["prime", "status", "herdr", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]
const SERVER = `${homedir()}/Developer/personal/.rifts/opencode/prime-look`
// The scratch server's own password: a loopback server on a scrubbed copy, never a real one.
const PASSWORD = "tab-perf-scratch"
// strobe launches a copy of bun under its own name: macOS keys a bare executable's data
// (~/Library/Preferences/bun.plist) by its name, which a launch under a scratch HOME would still share.
// The fixture makes the copy before the first launch.
const TUI_BUN = `${tmpdir().replace(/\/$/, "")}/tab-perf-bun/opencode-tui-bun`

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
const PRELOAD = "packages/tui/node_modules/@opentui/solid/scripts/preload.js"
const ENTRY = "packages/cli/src/index.ts"

/** Next tab once per tab, one press after another; each press resolves on the frame and the quiet after it. */
const switchEach = (press: () => Promise<void>): Effect.Effect<void> => Effect.forEach(TABS, () => Strobe.page(press), { discard: true })

export default bench({
  // The server writes to its database (migrations, viewed times): each block gets its own clone
  // (copy-on-write where the file system has it).
  fixture: fixture(
    [
      `: "\${TAB_PERF_DB:?the fixture database perf/tab-fixture.ts built}"`,
      `server="\${TAB_PERF_SERVER:-${SERVER}}"`,
      `{ [ -x ${quote(TUI_BUN)} ] || { mkdir -p "$(dirname ${quote(TUI_BUN)})" && cp "$(command -v bun)" ${quote(TUI_BUN)}; }; }`,
      `(cp -c "$TAB_PERF_DB" {home}/tabs.db 2>/dev/null || cp --reflink=auto "$TAB_PERF_DB" {home}/tabs.db)`,
      `mkdir -p {home}/data {home}/config/opencode {home}/state {home}/cache`,
      `echo '{"autoupdate":false}' > {home}/config/opencode/opencode.json`,
      `XDG_DATA_HOME={home}/data XDG_CONFIG_HOME={home}/config XDG_STATE_HOME={home}/state XDG_CACHE_HOME={home}/cache` +
        ` OPENCODE_DB={home}/tabs.db OPENCODE_PASSWORD=${PASSWORD}` +
        ` exec bun --conditions=browser --preload="$server/${PRELOAD}" "$server/${ENTRY}" serve --port {port}`,
    ].join(" && "),
    // Ready once its port accepts a connection: its routes answer 401 without the password.
    { timeout: 120_000 },
  ),
  targets: {
    tui: tty([TUI_BUN, "--conditions=browser", `--preload=./${PRELOAD}`, `./${ENTRY}`, "-s", TABS[0], "--server", "{fixture.url}"], {
      cols: 160,
      rows: 45,
      unset: ["HERDR_*", "OPENCODE_*"],
      // The tab strip (row 0): its unread tabs' pulse dots blink, so a run's start may catch either phase.
      ignore: [[0, 0, 160, 1]],
      env: {
        OPENCODE_PASSWORD: PASSWORD,
        OPENCODE_TUI_CHANNEL: "bench",
        // Where `files` below put the config and the seeded tabs.
        XDG_CONFIG_HOME: "{home}/.config",
        XDG_STATE_HOME: "{home}/.local/state",
        XDG_DATA_HOME: "{home}/.local/share",
        XDG_CACHE_HOME: "{home}/.cache",
      },
      files: {
        // Mode on: "auto" turns tabs off inside herdr (HERDR_ENV), which a bench run from a herdr pane inherits.
        // The workbox's TUI config: our 11 TUI plugins (from this checkout), the sidebar hidden.
        ".config/opencode/cli.json": {
          autoupdate: false,
          tabs: { mode: "on", scope: "global" },
          session: { sidebar: "hide" },
          plugins: Arr.map(PLUGINS, (name) => fileURLToPath(new URL(`../cmd/${name}`, import.meta.url))),
        },
        ".local/state/opencode/bench/tui/tabs.json": {
          global: { tabs: Arr.map(TABS, (sessionID) => ({ sessionID })), unread: {} },
          cwd: {},
        },
      },
    }),
  },
  // The first tab's transcript, past the loader (scrubbed words read as runs of x); then each tab
  // once, so the runs switch between loaded tabs as the owner's TUIs do.
  setup: ({ page }) =>
    Strobe.step(
      Effect.gen(function* () {
        yield* Strobe.page(() => page.waitFor("text=xxxxx", { timeout: 120_000 }))
        yield* Strobe.page(() => page.idle())
        yield* switchEach(() => page.press("Alt+ArrowDown", { until: ["frame", "idle"], timeout: 30_000 }))
      }),
    ),
  cases: {
    "switch tabs": {
      // Keypress to the switched frame. Settle (the screen still for 50 ms) waits out the tab strip's
      // spring and the unread tabs' 20 fps pulse, about 800 ms either side: reported, not judged.
      primary: "tty.latency.p50",
      metrics: ["cpu.work", "tty.settle.p50", "tty.frames", "tty.updates"],
      timeout: 120_000,
      // The switch's frame first, then still: under load "idle" alone can end before the first frame,
      // and the next press would outrun it.
      run: ({ page }) => Strobe.step(switchEach(() => page.press("Alt+ArrowDown", { until: ["frame", "idle"], timeout: 30_000 }))),
    },
  },
})
