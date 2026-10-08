import { describe, expect, test } from "claude-code/testing";
import type { ToolGroupCall } from "claude-code";

describe("register", () => {
  test("prompts keep multiline text and replies keep rich markdown without a bullet", async ($) => {
    const prompt = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "UserMessage",
      props: { text: "First line\nSecond line", origin: { kind: "composer" }, isExpanded: false },
    });
    expect((await prompt.findAll({ type: "Text" })).map((node) => node.text)).toEqual([
      "┃ ",
      "First line",
      "┃ ",
      "Second line",
    ]);
    const markdown = "# Heading\n\n[link](https://example.com)\n\n```ts\nconst n = 1\n```";
    const reply = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "AssistantMessage",
      props: { text: markdown, isFirstOfReply: true },
    });
    expect((await reply.find({ type: "Markdown" }))?.text).toBe(markdown);
    expect(await reply.findAll({ type: "Text" })).toHaveLength(0);
  });

  test("collapsed activity reports failures and interruptions; expansion keeps the full native rows", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    const calls: ToolGroupCall[] = [
      {
        tool: "Read",
        input: { file_path: "/work/app.ts" },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
      {
        tool: "Bash",
        input: { command: "bun test" },
        isRunning: false,
        isErrored: true,
        isInterrupted: false,
      },
      {
        tool: "Bash",
        input: { command: "bun dev" },
        isRunning: false,
        isErrored: true,
        isInterrupted: true,
      },
    ];
    const group = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolGroup",
      props: { calls, isActive: false, isExpanded: false },
    });
    const rows = await group.findAll({ type: "Text" });
    expect(rows.map((node) => node.text).join("")).toBe(
      "✕ Read 1 · Shell 2 · 1 failed · 1 interrupted",
    );
    expect(rows.find((node) => node.text.includes("failed"))?.props.color).toBe("error");
    await group.redraw({ calls, isActive: false, isExpanded: true });
    expect(await group.drawn()).toEqual(native);
    await group.redraw({
      calls: [{ ...calls[0]!, isRunning: true }],
      isActive: true,
      isExpanded: false,
    });
    expect((await group.findAll({ type: "Text" })).map((node) => node.text).join("")).toBe(
      "⋯ Read 1",
    );
  });

  test("sender framing, long replies and other surfaces stay with the native renderer", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    for (const surface of ["terminal", "mobile", "desktop", "vscode"] as const) {
      expect(
        await $.ui.render({
          surface,
          component: "UserMessage",
          requestId: "peer",
          props: {
            text: "Report from another session",
            origin: { kind: "peer" },
            isExpanded: false,
          },
        }),
      ).toEqual(native);
    }
    expect(
      await $.ui.render({
        surface: "terminal",
        component: "AssistantMessage",
        requestId: "long",
        props: { text: "x".repeat(10001), isFirstOfReply: true },
      }),
    ).toEqual(native);
    expect(
      await $.ui.render({
        surface: "mobile",
        component: "AssistantMessage",
        requestId: "mobile",
        props: { text: "Hello", isFirstOfReply: true },
      }),
    ).toEqual(native);
  });

  test("working state keeps native timing and overrides, and the completed turn shows its duration", async ($, on) => {
    on("ui.render", { component: "Spinner" }, (_$, e) => ({
      type: "Text",
      children: [e.props.message ?? e.props.word, e.props.suffix],
    }));
    expect(
      await $.ui.render({
        surface: "terminal",
        component: "Spinner",
        requestId: "spinner",
        props: { word: "Baking", message: "Waiting for permission", suffix: "…", mode: "tool-use" },
      }),
    ).toMatchObject({ children: ["Waiting for permission", "…"] });
    expect(
      await $.ui.render({
        surface: "terminal",
        component: "Spinner",
        requestId: "spinner",
        props: { word: "Baking", message: null, suffix: "…", mode: "thinking" },
      }),
    ).toMatchObject({ children: ["Thinking", "…"] });
    const footer = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "TurnDuration",
      props: { word: "Baked", durationMs: 64000 },
    });
    expect((await footer.find({ type: "Text" }))?.text).toBe("· 1m 4s");
  });
});
