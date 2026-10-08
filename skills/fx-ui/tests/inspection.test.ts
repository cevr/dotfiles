import { describe, expect, test } from "claude-code/testing";
import type { ToolGroupCall } from "claude-code";

const paneProps = {
  title: "Details",
  isFocused: true,
  bodyColumns: 80,
  placement: "inline" as const,
  scroll: { bodyRows: 18, offset: 0 },
  view: {},
};
const finished = { isRunning: false, isErrored: false, isInterrupted: false };
const command = {
  command: "fx-tool",
  origin: { kind: "composer" } as const,
  presentation: { isFullscreen: false, columns: 80 },
};

describe("inspection", () => {
  test("mixed activity uses concrete actions, relative paths and actual diff counts", async ($, on) => {
    on("session.cwd", () => ({ value: "/work" }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    const calls: ToolGroupCall[] = [
      {
        ...finished,
        tool_use_id: "shell",
        tool: "Bash",
        input: { command: "bun test" },
        output: { stdout: "2 tests passed\n", stderr: "", interrupted: false },
      },
      {
        ...finished,
        tool_use_id: "grep",
        tool: "Grep",
        input: { pattern: "register" },
        output: { numMatches: 3, filenames: [], content: "a.ts:register\n" },
      },
      {
        ...finished,
        tool_use_id: "glob",
        tool: "Glob",
        input: { pattern: "**/*.ts" },
        output: { numFiles: 2, filenames: ["a.ts", "b.ts"] },
      },
      {
        ...finished,
        tool_use_id: "edit",
        tool: "Edit",
        input: { file_path: "/work/a.ts" },
        output: {
          filePath: "/work/a.ts",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-const n = 1", "+const n = 2"],
            },
          ],
        },
      },
      {
        ...finished,
        tool_use_id: "agent",
        tool: "Agent",
        input: { description: "Check rendering" },
        output: {
          status: "completed",
          content: [{ type: "text", text: "Looks good" }],
          totalToolUseCount: 4,
          totalDurationMs: 12000,
        },
      },
    ];
    const group = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolGroup",
      props: { calls, isActive: false, isExpanded: false },
    });
    expect((await group.findAll({ type: "Button" })).map((node) => node.props.label)).toEqual([
      "├ Ran bun test · 1 line",
      '├ Searched "register" · 3 matches',
      '├ Found "**/*.ts" · 2 files',
      "├ Edited a.ts +1 −1",
      "└ Agent · Check rendering · 4 calls · 12s",
    ]);
    await group.press({ key: "tool-edit" });
    const pane = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "Pane",
      requestId: "fx-inspect",
      props: paneProps,
    });
    expect((await pane.find({ type: "Code" }))?.props).toMatchObject({
      source: "@@ -1,1 +1,1 @@\n-const n = 1\n+const n = 2",
      format: "diff",
    });
    expect(await group.findAll({ type: "Button" })).toHaveLength(5);
    await pane.press({ key: "section-1" });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe(
      '{\n  "file_path": "/work/a.ts"\n}',
    );
    await group.press({ key: "tool-grep" });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe("a.ts:register\n");
  });

  test("large output stays bounded, pages without losing Unicode, and copies the whole section", async ($, on) => {
    on("session.cwd", () => ({ value: "/work" }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    let copied = "";
    on("ui.copy", (_$, e) => {
      copied = e.text;
      return { value: { isCopied: true } };
    });
    const source = "x".repeat(7999) + "😀" + "y".repeat(10000);
    const row = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "ToolUse",
      props: {
        ...finished,
        tool_use_id: "large",
        tool: "Read",
        input: { file_path: "/work/large.ts" },
        output: { type: "text", file: { filePath: "/work/large.ts", content: source } },
      },
    });
    await row.press({ key: "tool-large" });
    const pane = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "Pane",
      requestId: "fx-inspect",
      props: paneProps,
    });
    let joined = String((await pane.find({ type: "Code" }))?.props.source);
    await pane.press({ key: "next" });
    joined += (await pane.find({ type: "Code" }))?.props.source;
    await pane.press({ key: "next" });
    joined += (await pane.find({ type: "Code" }))?.props.source;
    expect(joined).toBe(source);
    expect(await pane.find({ key: "next" })).toBeUndefined();
    await pane.press({ key: "copy" });
    expect(copied).toBe(source);
    await $.command.run({ ...command, args: "large" });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe("x".repeat(7999));
  });

  test("chooser pages long histories, and background or partial results keep native rendering", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    on("session.cwd", () => ({ value: "/work" }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    for (let i = 0; i < 25; i++)
      await $.ui.render({
        surface: "terminal",
        component: "ToolUse",
        requestId: `read-${i}`,
        props: {
          ...finished,
          tool_use_id: `read-${i}`,
          tool: "Read",
          input: { file_path: `/work/${i}.ts` },
        },
      });
    await $.command.run({ ...command, args: "" });
    const pane = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "Pane",
      requestId: "fx-inspect",
      props: paneProps,
    });
    expect(await pane.findAll({ type: "Button" })).toHaveLength(21);
    await pane.press({ key: "next" });
    expect(await pane.findAll({ type: "Button" })).toHaveLength(6);
    await pane.press({ key: "choice-0" });
    expect((await pane.find({ type: "Text" }))?.text).toBe("Read 4.ts");
    for (const output of [
      { stdout: "still running", stderr: "", backgroundTaskId: "task" },
      { stdout: "partial", stderr: "", persistedOutputPath: "/tmp/full-output" },
      { stdout: "warning", stderr: "something went wrong" },
    ]) {
      expect(
        await $.ui.render({
          surface: "terminal",
          component: "ToolUse",
          requestId: "important",
          props: {
            ...finished,
            tool_use_id: "important",
            tool: "Bash",
            input: { command: "bun test" },
            output,
          },
        }),
      ).toEqual(native);
    }
    expect(
      await $.ui.render({
        surface: "terminal",
        component: "ToolUse",
        requestId: "partial-search",
        props: {
          ...finished,
          tool_use_id: "partial-search",
          tool: "Grep",
          input: { pattern: "register" },
          output: { content: "partial", numFiles: 1, totalFiles: 10, filenames: [] },
        },
      }),
    ).toEqual(native);
  });
});
