import type { On, SessionUsage } from "claude-code";
import { inspectPane, type Inspector } from "./inspector";
import { box, brief, text } from "./render";

function modelName(model: string) {
  return model.match(/opus|sonnet|haiku|fable/i)?.[0]?.toLowerCase() ?? brief(model, 24);
}

function contextLabel(usage: SessionUsage) {
  const window =
    usage.context.window >= 1000000
      ? `${Math.round(usage.context.window / 1000000)}M`
      : `${Math.round(usage.context.window / 1000)}k`;
  return `ctx ${usage.context.percent === undefined ? "—" : `${Math.round(usage.context.percent)}%`}/${window}`;
}

function statusDocument(
  cwd: string,
  model: string,
  usage: SessionUsage,
  configDir: string | undefined,
  git: string,
) {
  const account = configDir?.replace(/\/+$/, "").split("/").pop();
  const accountLabel =
    !account || account === ".claude" ? "personal" : account === ".claude2" ? "work" : account;
  const limits = usage.rateLimits.map(
    (limit) =>
      `${limit.kind === "five_hour" ? "5h" : limit.kind === "seven_day" ? "7d" : limit.kind}: ${Math.round(limit.percentUsed)}% used`,
  );
  return {
    title: "Session status",
    sections: [
      {
        label: "Session",
        source: [
          model,
          `Account: ${accountLabel}`,
          `Folder: ${cwd}`,
          contextLabel(usage),
          `Cost: ${usage.cost ? `$${usage.cost.usd.toFixed(2)}` : "unavailable"}`,
          ...limits,
        ].join("\n"),
      },
      { label: "Git", source: git },
    ],
  };
}

export function register(on: On, inspector: Inspector) {
  on("command.run", { command: "fx-status" }, async ($) => {
    await inspector.prepare(async () => {
      const [cwd, model, usage, configDir] = await Promise.all([
        $.session.cwd(),
        $.session.model(),
        $.session.usage(),
        $.env.get("CLAUDE_CONFIG_DIR"),
      ]);
      let git = "Git status unavailable";
      try {
        const result = await $.process.run(["git", "-C", cwd, "status", "--short", "--branch"], {
          timeoutMs: 500,
        });
        if (result.exitCode === 0 && !result.isStdoutTruncated)
          git = result.stdout.trimEnd() || "Clean working tree";
      } catch {
        // Session figures remain available outside Git or while Git is unavailable.
      }
      return statusDocument(cwd, model, usage, configDir, git);
    });
    await $.ui.open(inspectPane);
    $.ui.invalidate("ui.render");
    return {};
  });

  on("ui.render", { surface: "terminal", component: "PromptHint" }, async ($, e, next) => {
    const [native, model, usage] = await Promise.all([
      next(e),
      $.session.model(),
      $.session.usage(),
    ]);
    const { Button } = $.ui.resolve(e);
    return box(
      [
        native,
        box(
          [
            text(`${modelName(model)} · ${contextLabel(usage)}`, {
              dimColor: true,
              wrap: "truncate-end",
            }),
            Button({
              key: "fx-status",
              label: "details",
              plain: true,
              dimColor: true,
              onPress: async () => {
                await inspector.prepare(async () => {
                  const [cwd, currentModel, currentUsage, configDir] = await Promise.all([
                    $.session.cwd(),
                    $.session.model(),
                    $.session.usage(),
                    $.env.get("CLAUDE_CONFIG_DIR"),
                  ]);
                  let git = "Git status unavailable";
                  try {
                    const result = await $.process.run(
                      ["git", "-C", cwd, "status", "--short", "--branch"],
                      { timeoutMs: 500 },
                    );
                    if (result.exitCode === 0 && !result.isStdoutTruncated)
                      git = result.stdout.trimEnd() || "Clean working tree";
                  } catch {
                    // Keep the status view usable when Git is unavailable.
                  }
                  return statusDocument(cwd, currentModel, currentUsage, configDir, git);
                });
                await $.ui.open(inspectPane);
                $.ui.invalidate("ui.render");
              },
            }),
          ],
          { gap: 2 },
        ),
      ],
      { flexDirection: "column" },
    );
  });
}
