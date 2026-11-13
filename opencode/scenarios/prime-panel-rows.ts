// The rows scenarios/prime-panel.ts waits for and tests/prime-panel.test.ts
// asserts, in one place: the scenario keeps a tab's frame only once its rows
// match these, so a frame is never kept on less than the test then asks of it
// (a wait on `serving` alone matched the command's own text before the row's
// output was read, and kept a frame that still said `no output yet`).

/** The panel in a frame: its tab bar, its rows and its footer, without the rail or what the screen draws beside it. */
export function panelOf(frame: string) {
  const lines = frame.split("\n")
  const bar = lines.findIndex((line) => line.includes("Subagents") && line.includes("Monitors"))
  const right = (lines[bar] ?? "").indexOf(" esc") + 4
  const footer = lines.findIndex((line, at) => at > bar && line.includes("←/→ tabs"))
  const clean = (line: string) => line.slice(0, right).replace(/^ ┃ {0,2}/, "").trimEnd()
  return {
    bar: clean(lines[bar] ?? ""),
    rows: lines
      .slice(bar + 1, Math.max(bar + 1, footer))
      .map(clean)
      .filter((line) => line !== ""),
    footer: clean(lines[footer] ?? ""),
  }
}

/** Each tab's rows as Prime draws them, in order, at 160 and at 80 columns alike. */
export const ROWS = {
  // The command, its last output line read from the shell, `running` and how long.
  shell: [
    /^[◆◇] printf 'serving on :4000\\n'; sl… {2}serving on :4000 +running +\d+s$/,
    /^[◆◇] printf 'watching src\\n'; sleep… {3}watching src +running +\d+s$/,
  ],
  // The terminal's title, what runs in front (`sleep`, once the PTY service names it; its command until then), its
  // state in the shell rows' words, the exit code with it; no time, as the PTY service keeps no start time.
  terminals: [/^\$ server {2}(?:sleep|sh -c sleep 600) +running$/, /^\$ failed {2}sh -c exit 3 +exited 3$/, /^\$ \+ New terminal$/],
  // The alarm's note, its mode and repeat, `pending` and how long until it is due.
  wakes: [/^◇ Check the deploy: the canary {2}wake · once +pending {2}in 9m \d\ds$/],
  // The monitor's command, its newest output, `watching`, how long, and when it last checked.
  monitors: [/^[◆◇] echo still-waiting {2}still-waiting +watching +\d+s {2}checked \d+s ago$/],
} as const

export type Tab = keyof typeof ROWS

/** Whether a frame's panel lists exactly the tab's rows. */
export function shows(tab: Tab, frame: string) {
  const { rows } = panelOf(frame)
  const want = ROWS[tab]
  return rows.length === want.length && want.every((pattern, at) => pattern.test(rows[at] ?? ""))
}
