import { describe, expect, test } from "claude-code/testing";

const paneProps = {
  title: "Details",
  isFocused: true,
  bodyColumns: 80,
  placement: "inline" as const,
  scroll: { bodyRows: 18, offset: 0 },
  view: {},
};

describe("composer", () => {
  test("quiet composer preserves native controls; status and Git are fetched on demand", async ($, on) => {
    let gitReads = 0;
    let envReads = 0;
    on("ui.render", { component: "PromptHint" }, () => ({
      type: "Text",
      children: ["auto mode · esc to interrupt"],
    }));
    on("session.cwd", () => ({ value: "/work/gent" }));
    on("session.model", () => ({ value: "claude-opus-5-5" }));
    on("session.usage", () => ({
      value: {
        startedAt: 0,
        context: { window: 1000000, percent: 31 },
        cost: { usd: 4.2 },
        rateLimits: [
          { kind: "five_hour", percentUsed: 7 },
          { kind: "seven_day", percentUsed: 88 },
        ],
      },
    }));
    on("env.get", () => {
      envReads++;
      return { value: "/home/user/.claude2" };
    });
    on("process.run", () => {
      gitReads++;
      return {
        value: {
          exitCode: 0,
          stdout: "## main...origin/main\n M app.ts\n",
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    });
    on("ui.open", () => ({ value: { isPlaced: true } }));
    const footer = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "PromptHint",
      viewport: { columns: 50, rows: 24 },
      props: { hint: "auto mode · esc to interrupt", isDraft: false, isWorking: true },
    });
    expect((await footer.findAll({ type: "Text" })).map((node) => node.text)).toEqual([
      "auto mode · esc to interrupt",
      "opus · ctx 31%/1M",
    ]);
    expect(gitReads).toBe(0);
    expect(envReads).toBe(0);
    await footer.press({ key: "fx-status" });
    expect(gitReads).toBe(1);
    expect(envReads).toBe(1);
    const pane = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "Pane",
      requestId: "fx-inspect",
      props: paneProps,
    });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe(
      "claude-opus-5-5\nAccount: work\nFolder: /work/gent\nctx 31%/1M\nCost: $4.20\n5h: 7% used\n7d: 88% used",
    );
    await pane.press({ key: "section-1" });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe(
      "## main...origin/main\n M app.ts",
    );
    await pane.press({ key: "refresh" });
    expect(gitReads).toBe(2);
    expect(envReads).toBe(2);
  });

  test("unknown readings remain unknown and Git failure still permits inspection", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    on("session.cwd", () => ({ value: "/tmp/demo" }));
    on("session.model", () => ({ value: "sonnet" }));
    on("session.usage", () => ({
      value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
    }));
    on("env.get", () => ({ value: undefined }));
    on("process.run", () => {
      throw new Error("git timeout");
    });
    on("ui.open", () => ({ value: { isPlaced: true } }));
    const footer = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "PromptHint",
      props: { hint: "? for shortcuts", isDraft: true, isWorking: false },
    });
    expect((await footer.find({ type: "Text" }))?.text).toBe("sonnet · ctx —/200k");
    await $.command.run({
      command: "fx-status",
      args: "",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 80 },
    });
    const pane = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "Pane",
      requestId: "fx-inspect",
      props: paneProps,
    });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe(
      "sonnet\nAccount: personal\nFolder: /tmp/demo\nctx —/200k\nCost: unavailable",
    );
    await pane.press({ key: "section-1" });
    expect((await pane.find({ type: "Code" }))?.props.source).toBe("Git status unavailable");
    expect(
      await $.ui.render({
        surface: "mobile",
        component: "PromptHint",
        requestId: "hint",
        props: { hint: "? for shortcuts", isDraft: false, isWorking: false },
      }),
    ).toEqual(native);
  });
});
