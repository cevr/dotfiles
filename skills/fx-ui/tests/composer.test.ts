import { describe, expect, test } from "claude-code/testing";

describe("composer", () => {
  test("composer retains native controls and shows live session metadata", async ($, on) => {
    on("ui.render", { component: "PromptHint" }, () => ({
      type: "Text",
      children: ["auto mode · esc to interrupt"],
    }));
    on("clock.now", () => ({ value: 0 }));
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
    on("env.get", { name: "CLAUDE_CONFIG_DIR" }, () => ({ value: "/home/user/.claude2" }));
    on("process.run", () => ({
      value: {
        exitCode: 0,
        stdout: "## main...origin/main\n M app.ts\n?? new.ts\n",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }));
    const footer = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      viewport: { columns: 160, rows: 24 },
      component: "PromptHint",
      props: { hint: "auto mode · esc to interrupt", isDraft: false, isWorking: true },
    });
    expect((await footer.findAll({ type: "Text" })).map((node) => node.text)).toEqual([
      "auto mode · esc to interrupt",
      "opus · work:gent · main · 2 changed · ctx 31%/1M · $4.20 · 5h 7% · 7d 88%",
    ]);
    expect((await footer.findAll({ type: "Text" }))[1]?.props.wrap).toBe("truncate-end");
    const narrow = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "PromptHint",
      viewport: { columns: 50, rows: 24 },
      props: { hint: "auto mode · esc to interrupt", isDraft: false, isWorking: true },
    });
    expect((await narrow.findAll({ type: "Text" })).map((node) => node.text)).toEqual([
      "auto mode · esc to interrupt",
      "opus · work:gent · main · 2 changed",
      "ctx 31%/1M · $4.20 · 5h 7% · 7d 88%",
    ]);
  });

  test("missing usage readings stay unknown and a Git failure does not remove the footer", async ($, on) => {
    const native = { type: "engine", ref: 0 } as const;
    on("ui.render", () => native);
    on("clock.now", () => ({ value: 0 }));
    on("session.cwd", () => ({ value: "/tmp/demo" }));
    on("session.model", () => ({ value: "sonnet" }));
    on("session.usage", () => ({
      value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
    }));
    on("env.get", () => ({ value: undefined }));
    on("process.run", () => {
      throw new Error("git timeout");
    });
    const footer = await $.ui.mount({
      plugin: "fx-ui",
      surface: "terminal",
      component: "PromptHint",
      props: { hint: "? for shortcuts", isDraft: true, isWorking: false },
    });
    expect((await footer.find({ type: "Text" }))?.text).toBe("sonnet · personal:demo · ctx —/200k");
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
