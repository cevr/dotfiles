import type { On, ToolGroupCall } from "claude-code";
import { activityDocument, describeActivity } from "./activity";
import { inspectPane, type Inspector } from "./inspector";
import { box, column, text, transcriptIndent } from "./render";

export function registerTools(on: On, inspector: Inspector) {
  let details = false;
  const calls = new Map<string, { call: ToolGroupCall; cwd: string }>();

  function document(id: string) {
    const captured = calls.get(id);
    if (!captured)
      return {
        title: "Tool details",
        sections: [{ label: "Result", source: "This tool call is no longer available." }],
      };
    return activityDocument(captured.call, captured.cwd);
  }

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
  on("command.run", { command: "fx-tool" }, async ($, e) => {
    const id = e.args.trim();
    if (id) {
      if (!calls.has(id))
        return { text: "Unknown tool call. Run /fx-tool to choose rendered activity." };
      await inspector.prepare(() => document(id));
    } else {
      inspector.choose(
        [...calls.entries()].reverse().map(([key, captured]) => ({
          label: describeActivity(captured.call, captured.cwd)?.label ?? captured.call.tool,
          load: () => document(key),
        })),
      );
    }
    await $.ui.open(inspectPane);
    $.ui.invalidate("ui.render");
    return {};
  });

  function row(
    id: string,
    call: ToolGroupCall,
    cwd: string,
    open: () => Promise<void>,
    prefix?: string,
  ) {
    calls.set(id, { call, cwd });
    const activity = describeActivity(call, cwd);
    if (!activity)
      return {
        key: `tool-${id}`,
        label: `${prefix ?? "●"} ${call.tool}`,
        plain: true as const,
        dimColor: true,
        onPress: open,
      };
    const marker =
      prefix ?? (call.isRunning ? "⋯" : call.isInterrupted ? "■" : call.isErrored ? "✕" : "●");
    return {
      key: `tool-${id}`,
      label: `${marker} ${activity.label}`,
      plain: true as const,
      dimColor: !call.isErrored,
      onPress: open,
    };
  }

  on("ui.render", { surface: "terminal", component: "ToolUse" }, async ($, e, next) => {
    const cwd = await $.session.cwd();
    calls.set(e.props.tool_use_id, { call: e.props, cwd });
    const activity = describeActivity(e.props, cwd);
    if (
      details ||
      !activity ||
      e.props.isErrored ||
      e.props.isInterrupted ||
      (e.props.output !== undefined && !activity.collapse)
    )
      return next(e);
    const { Button } = $.ui.resolve(e);
    return box(
      [
        Button(
          row(e.props.tool_use_id, e.props, cwd, async () => {
            await inspector.prepare(() => document(e.props.tool_use_id));
            await $.ui.open(inspectPane);
            $.ui.invalidate("ui.render");
          }),
        ),
      ],
      { marginLeft: transcriptIndent },
    );
  });

  on("ui.render", { surface: "terminal", component: "ToolGroup" }, async ($, e, next) => {
    const cwd = await $.session.cwd();
    const activities = e.props.calls.map((call) => describeActivity(call, cwd));
    e.props.calls.forEach((call, i) =>
      calls.set(call.tool_use_id ?? `${e.requestId}-${i}`, { call, cwd }),
    );
    if (
      details ||
      e.props.isExpanded ||
      !e.props.calls.length ||
      e.props.calls.length > 100 ||
      e.props.calls.some((call, i) => call.output !== undefined && !activities[i]?.collapse)
    )
      return next(e);
    const counts = new Map<string, number>();
    e.props.calls.forEach((call, i) => {
      const category = activities[i]?.category ?? call.tool;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    });
    const failed = e.props.calls.filter((call) => call.isErrored && !call.isInterrupted).length;
    const stopped = e.props.calls.filter((call) => call.isInterrupted).length;
    const running = e.props.calls.some((call) => call.isRunning);
    const summary = box([
      text(`${running ? "⋯" : failed ? "✕" : stopped ? "■" : "●"} `, {
        color: failed ? "error" : "inactive",
      }),
      text(
        `${e.props.calls.length} tool ${e.props.calls.length === 1 ? "call" : "calls"} · ${[...counts].map(([name, n]) => `${n} ${name}`).join(" · ")}`,
        { dimColor: true },
      ),
      ...(failed ? [text(` · ${failed} failed`, { color: "error" })] : []),
      ...(stopped ? [text(` · ${stopped} interrupted`, { dimColor: true })] : []),
    ]);
    const { Button } = $.ui.resolve(e);
    return column(
      [
        summary,
        ...e.props.calls.map((call, i) => {
          const id = call.tool_use_id ?? `${e.requestId}-${i}`;
          return Button(
            row(
              id,
              call,
              cwd,
              async () => {
                await inspector.prepare(() => document(id));
                await $.ui.open(inspectPane);
                $.ui.invalidate("ui.render");
              },
              i === e.props.calls.length - 1 ? "└" : "├",
            ),
          );
        }),
      ],
      { marginLeft: transcriptIndent },
    );
  });

  on("ui.render", { surface: "terminal", component: "ToolResult" }, (_$, e, next) => {
    const captured = calls.get(e.props.tool_use_id);
    if (captured)
      calls.set(e.props.tool_use_id, {
        ...captured,
        call: { ...captured.call, output: e.props.output, isErrored: e.props.isErrored },
      });
    const activity = captured
      ? describeActivity(
          { ...captured.call, output: e.props.output, isErrored: e.props.isErrored },
          captured.cwd,
        )
      : undefined;
    if (details || e.props.isErrored || !activity?.collapse) return next(e);
    return box([]);
  });
}
