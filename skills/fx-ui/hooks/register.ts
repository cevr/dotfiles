import type { On, RenderElement, RenderNode, ToolGroupCall } from "claude-code";

const text = (
  value: string,
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Text", props, children: [value] });

const box = (
  children: RenderNode[],
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Box", props, children });

const labels = new Map<string, string>([
  ["Bash", "command"],
  ["Read", "read"],
  ["Grep", "search"],
  ["Glob", "list"],
  ["Edit", "edit"],
  ["Write", "write"],
]);

function activity(calls: readonly ToolGroupCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = labels.get(call.tool) ?? call.tool;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(" · ");
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const fileTools = new Set(["Read", "Write", "Edit"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function compactOutput(tool: string, output: unknown): boolean {
  const result = record(output);
  if (!result || result.staged || result.userModified) return false;
  if (tool === "Read") {
    const file = record(result.file);
    return (
      result.type === "text" && typeof file?.filePath === "string" && !file.truncatedByTokenCap
    );
  }
  return (tool === "Write" || tool === "Edit") && typeof result.filePath === "string";
}

function fileRow(call: ToolGroupCall): string | undefined {
  if (call.isErrored || call.isInterrupted) return undefined;
  if (!fileTools.has(call.tool) || !call.input || typeof call.input !== "object") return undefined;
  const input = call.input as Record<string, unknown>;
  if (typeof input.file_path !== "string" || input.file_path.length > 9000) return undefined;
  const verb = call.tool === "Write" ? "Wrote" : call.tool === "Edit" ? "Edited" : "Read";
  let count = "";
  const result = record(call.output);
  if (
    call.tool === "Write" &&
    !call.isRunning &&
    result?.type === "update" &&
    typeof result.content === "string" &&
    result.originalFile === result.content
  )
    return `No changes to ${input.file_path}`;
  if (
    call.tool === "Write" &&
    !call.isRunning &&
    !call.isErrored &&
    !call.isInterrupted &&
    typeof result?.content === "string"
  ) {
    const lines =
      result.content === ""
        ? 0
        : result.content.split("\n").length - Number(result.content.endsWith("\n"));
    count = ` · ${lines} ${lines === 1 ? "line" : "lines"}`;
  }
  return `${call.isRunning ? call.tool : verb} ${input.file_path}${count}`;
}

export function register(on: On) {
  let details = false;
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "fx-details",
      description: "Toggle full tool arguments and output",
      argumentHint: "[on|off]",
      immediate: true,
    });
    return next(e);
  });
  on("command.run", { command: "fx-details" }, ($, e) => {
    const mode = e.args.trim();
    if (mode && mode !== "on" && mode !== "off") return { text: "Usage: /fx-details [on|off]" };
    details = mode ? mode === "on" : !details;
    $.ui.invalidate("ui.render");
    return {
      text: details
        ? "Full tool details · /fx-details off for compact rows"
        : "Compact tool rows · /fx-details on for full details",
    };
  });

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
    if (
      details ||
      e.props.isExpanded ||
      e.props.calls.length === 0 ||
      e.props.calls.some(
        (call) =>
          fileTools.has(call.tool) &&
          call.output !== undefined &&
          !compactOutput(call.tool, call.output),
      )
    )
      return next(e);
    const calls = e.props.calls;
    const failed = calls.filter((call) => call.isErrored && !call.isInterrupted).length;
    const stopped = calls.filter((call) => call.isInterrupted).length;
    const running = calls.some((call) => call.isRunning);
    const summary = box([
      text(`${running ? "⋯" : failed ? "✕" : stopped ? "■" : "●"} `, {
        color: failed ? "error" : "inactive",
      }),
      text(`${calls.length} tool ${calls.length === 1 ? "call" : "calls"} · ${activity(calls)}`, {
        dimColor: true,
      }),
      ...(failed ? [text(` · ${failed} failed`, { color: "error" })] : []),
      ...(stopped ? [text(` · ${stopped} interrupted`, { dimColor: true })] : []),
    ]);
    const files = calls.flatMap((call) => {
      const row = fileRow(call);
      return row ? [row] : [];
    });
    return box(
      [
        summary,
        ...files.map((row, i) =>
          text(`${i === files.length - 1 ? "└" : "├"} ${row}`, { dimColor: true }),
        ),
      ],
      { flexDirection: "column", marginLeft: 2 },
    );
  });

  on("ui.render", { surface: "terminal", component: "ToolUse" }, (_$, e, next) => {
    // The API exposes no standalone detail flag; /fx-details restores native rows.
    if (
      details ||
      e.props.isErrored ||
      e.props.isInterrupted ||
      (e.props.output !== undefined && !compactOutput(e.props.tool, e.props.output))
    )
      return next(e);
    const row = fileRow(e.props);
    if (!row) return next(e);
    return box([text(`${e.props.isRunning ? "⋯" : "●"} ${row}`, { dimColor: true })], {
      marginLeft: 2,
    });
  });

  on("ui.render", { surface: "terminal", component: "ToolResult" }, (_$, e, next) => {
    if (details || e.props.isErrored || !compactOutput(e.props.tool, e.props.output))
      return next(e);
    return box([]);
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
