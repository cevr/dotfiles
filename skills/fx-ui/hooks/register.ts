import type { On } from "claude-code";
import { register as registerComposer } from "./composer";
import { createInspector, registerInspector } from "./inspector";
import { registerTools } from "./tools";
import { box, text, duration, transcriptIndent } from "./render";

export function register(on: On) {
  const inspector = createInspector();
  registerInspector(on, inspector);
  registerTools(on, inspector);
  registerComposer(on, inspector);

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "fx-details",
      description: "Toggle full native tool rows",
      argumentHint: "[on|off]",
      immediate: true,
    });
    await $.command.register({
      name: "fx-tool",
      description: "Inspect one tool call",
      argumentHint: "[tool-id]",
      immediate: true,
    });
    await $.command.register({
      name: "fx-status",
      description: "Inspect session status",
      immediate: true,
    });
    return next(e);
  });

  on("ui.render", { surface: "terminal", component: "UserMessage" }, (_$, e, next) => {
    // Other people's messages keep their sender labels and native framing.
    if (
      e.props.from ||
      e.props.task ||
      !["composer", "bridge", "sdk", "unclassified"].includes(e.props.origin.kind) ||
      e.props.text.length > 10000 ||
      e.props.text.split("\n").length > 100
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
    if (e.props.text.length > 10000 || e.props.text.split("\n").length > 100) return next(e);
    return box([{ type: "Markdown", props: { text: e.props.text } }], {
      flexDirection: "column",
      marginTop: e.props.isFirstOfReply ? 1 : 0,
      paddingLeft: transcriptIndent,
    });
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
    box([text(`· ${duration(e.props.durationMs)}`, { dimColor: true })], {
      marginLeft: transcriptIndent,
    }),
  );
}
