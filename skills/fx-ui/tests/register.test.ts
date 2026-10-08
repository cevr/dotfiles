import { describe, expect, test } from "claude-code/testing";
import type { ToolGroupCall } from "claude-code";

describe("register", () => {
  test("a write that leaves the content unchanged is identified as a no-op", async ($) => {
    const row = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolUse",
      props: {
        tool_use_id: "unchanged",
        tool: "Write",
        input: { file_path: "/work/app.ts" },
        output: {
          type: "update",
          filePath: "/work/app.ts",
          content: "const n = 1\n",
          originalFile: "const n = 1\n",
          structuredPatch: [],
        },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    });
    expect((await row.find({ type: "Text" }))?.text).toBe("● No changes to /work/app.ts");
  });
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

  test("collapsed activity reports failures and interruptions; expanded groups delegate to the engine", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    const calls: ToolGroupCall[] = [
      {
        tool: "constructor",
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
      "✕ 3 tool calls · 1 constructor · 2 command · 1 failed · 1 interrupted",
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
      "⋯ 1 tool call · 1 constructor",
    );
  });

  test("standalone reads and writes use compact file rows instead of native tool chrome", async ($, on) => {
    on("ui.render", () => ({ type: "engine", ref: 0 }));
    for (const tool of ["Read", "Write", "Edit"] as const) {
      const row = await $.ui.mount({
        plugin: "fx-ui",
        surface: "terminal",
        component: "ToolUse",
        props: {
          tool_use_id: tool,
          tool,
          input: { file_path: "/work/app.ts", content: "const n = 1" },
          isRunning: false,
          isErrored: false,
          isInterrupted: false,
        },
      });
      expect((await row.findAll({ type: "Text" })).map((node) => node.text).join("")).toBe(
        `● ${tool === "Write" ? "Wrote" : tool === "Edit" ? "Edited" : "Read"} /work/app.ts`,
      );
    }
  });

  test("file output collapses and detail mode restores native headers and results", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    const output = {
      type: "create",
      filePath: "/work/app.ts",
      content: "const n = 1\n",
      structuredPatch: [],
      originalFile: null,
    };
    const props = {
      tool_use_id: "write",
      tool: "Write",
      input: { file_path: "/work/app.ts" },
      output,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    };
    const row = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolUse",
      props,
    });
    const result = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolResult",
      props: { tool_use_id: "write", tool: "Write", output, isErrored: false },
    });
    expect((await row.findAll({ type: "Text" })).map((node) => node.text).join("")).toBe(
      "● Wrote /work/app.ts · 1 line",
    );
    expect(await result.drawn()).toEqual({ type: "Box", props: {}, children: [] });
    const command = {
      command: "fx-details",
      origin: { kind: "composer" } as const,
      presentation: { isFullscreen: false, columns: 80 },
    };
    await $.command.run({ ...command, args: "on" });
    await row.redraw(props);
    await result.redraw({ tool_use_id: "write", tool: "Write", output, isErrored: false });
    expect(await row.drawn()).toEqual(native);
    expect(await result.drawn()).toEqual(native);
    await $.command.run({ ...command, args: "off" });
    await row.redraw(props);
    expect(await row.findAll({ type: "Text" })).toHaveLength(1);
  });

  test("file groups show paths and running file calls keep a working marker", async ($) => {
    const calls = ["/work/a.ts", "/work/b.ts"].map((file_path) => ({
      tool: "Read",
      input: { file_path },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    }));
    const group = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolGroup",
      props: { calls, isActive: false, isExpanded: false },
    });
    expect((await group.findAll({ type: "Text" })).map((node) => node.text)).toEqual([
      "● ",
      "2 tool calls · 2 read",
      "├ Read /work/a.ts",
      "└ Read /work/b.ts",
    ]);
    const running = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolUse",
      props: {
        tool_use_id: "write",
        tool: "Write",
        input: { file_path: "/work/a.ts" },
        isRunning: true,
        isErrored: false,
        isInterrupted: false,
      },
    });
    expect((await running.find({ type: "Text" }))?.text).toBe("⋯ Write /work/a.ts");
  });

  test("errors, staged changes, partial reads and nontext results retain native details", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    for (const props of [
      { tool: "Write", output: "Permission denied", isErrored: true },
      { tool: "Write", output: { filePath: "/work/app.ts", staged: true }, isErrored: false },
      { tool: "Write", output: { filePath: "/work/app.ts", userModified: true }, isErrored: false },
      {
        tool: "Read",
        output: { type: "text", file: { filePath: "/work/app.ts", truncatedByTokenCap: true } },
        isErrored: false,
      },
      { tool: "Read", output: { type: "image", file: {} }, isErrored: false },
      { tool: "Bash", output: { stdout: "done" }, isErrored: false },
    ]) {
      expect(
        await $.ui.render({
          surface: "terminal",
          component: "ToolResult",
          requestId: "result",
          props: { tool_use_id: "result", ...props },
        }),
      ).toEqual(native);
    }
    for (const props of [
      { tool: "Write", isErrored: true, isInterrupted: false },
      { tool: "Write", isErrored: false, isInterrupted: true },
      { tool: "constructor", isErrored: false, isInterrupted: false },
    ]) {
      expect(
        await $.ui.render({
          surface: "terminal",
          component: "ToolUse",
          requestId: "use",
          props: {
            tool_use_id: "use",
            input: { file_path: "/work/a.ts" },
            isRunning: false,
            ...props,
          },
        }),
      ).toEqual(native);
    }
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
