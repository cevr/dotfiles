import type { On, RenderElement, RenderNode, ToolGroupCall } from "claude-code";

const text = (
  value: string,
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Text", props, children: [value] });

const box = (
  children: RenderNode[],
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Box", props, children });

const labels: Record<string, string> = {
  Bash: "Shell",
  Read: "Read",
  Grep: "Search",
  Glob: "Find",
  Edit: "Edit",
  Write: "Write",
};

function activity(calls: readonly ToolGroupCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = labels[call.tool] ?? call.tool;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(" · ");
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function register(on: On) {
  on("ui.render", { surface: "terminal", component: "UserMessage" }, (_$, e, next) => {
    // Other people's messages keep their sender labels and native framing.
    if (
      e.props.from ||
      e.props.task ||
      !["composer", "bridge", "sdk", "unclassified"].includes(e.props.origin.kind) ||
      e.props.text.length > 10000
    )
      return next(e);

    return box(
      e.props.text
        .split("\n")
        .map((line) =>
          box([
            box([text("┃ ", { bold: true })], { flexShrink: 0 }),
            box([text(line, { bold: true })], { flexGrow: 1, flexShrink: 1 }),
          ]),
        ),
      { flexDirection: "column", marginTop: 1 },
    );
  });

  on("ui.render", { surface: "terminal", component: "AssistantMessage" }, (_$, e, next) => {
    // Markdown leaves are bounded by the mod API; the native row has no such limit.
    if (e.props.text.length > 10000) return next(e);
    return box([{ type: "Markdown", props: { text: e.props.text } }], {
      flexDirection: "column",
      marginTop: e.props.isFirstOfReply ? 1 : 0,
      paddingLeft: 2,
    });
  });

  on("ui.render", { surface: "terminal", component: "ToolGroup" }, (_$, e, next) => {
    // ctrl+o owns disclosure, including each tool's full arguments and output.
    if (e.props.isExpanded || e.props.calls.length === 0) return next(e);
    const calls = e.props.calls;
    const failed = calls.filter((call) => call.isErrored && !call.isInterrupted).length;
    const stopped = calls.filter((call) => call.isInterrupted).length;
    const running = calls.some((call) => call.isRunning);
    return box(
      [
        text(`${running ? "⋯" : failed ? "✕" : stopped ? "■" : "●"} `, {
          color: failed ? "error" : "inactive",
        }),
        text(activity(calls), { dimColor: true }),
        ...(failed ? [text(` · ${failed} failed`, { color: "error" })] : []),
        ...(stopped ? [text(` · ${stopped} interrupted`, { dimColor: true })] : []),
      ],
      { marginLeft: 2 },
    );
  });

  on("ui.render", { surface: "terminal", component: "Spinner" }, (_$, e, next) => {
    const words = {
      requesting: "Waiting",
      responding: "Writing",
      thinking: "Thinking",
      "tool-input": "Preparing",
      "tool-use": "Running",
    };
    // Keep the engine's animation, elapsed time, token count and state overrides.
    return next({ ...e, props: { ...e.props, word: words[e.props.mode], suffix: "…" } });
  });

  on("ui.render", { surface: "terminal", component: "TurnDuration" }, (_$, e) =>
    box([text(`· ${duration(e.props.durationMs)}`, { dimColor: true })], { marginLeft: 2 }),
  );
}
