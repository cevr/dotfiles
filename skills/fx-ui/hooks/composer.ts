import type { On, RenderElement } from "claude-code";

function clean(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

function short(value: string, length: number): string {
  const chars = Array.from(clean(value));
  return chars.length > length ? `${chars.slice(0, length - 1).join("")}…` : chars.join("");
}

export function register(on: On) {
  let git: { cwd: string; until: number; label: string } | undefined;

  on("ui.render", { surface: "terminal", component: "PromptHint" }, async ($, e, next) => {
    const [native, cwd, model, usage, configDir, now] = await Promise.all([
      next(e),
      $.session.cwd(),
      $.session.model(),
      $.session.usage(),
      $.env.get("CLAUDE_CONFIG_DIR"),
      $.clock.now(),
    ]);
    if (!git || git.cwd !== cwd || now >= git.until) {
      let label = "";
      try {
        const result = await $.process.run(
          ["git", "-C", cwd, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
          { timeoutMs: 500 },
        );
        const rows = result.stdout.trimEnd().split("\n");
        if (result.exitCode === 0 && !result.isStdoutTruncated) {
          const branch =
            rows[0]
              ?.replace(/^## /, "")
              .split("...")[0]
              ?.replace(/^No commits yet on /, "") ?? "";
          const changed = rows.slice(1).filter(Boolean).length;
          label = `${short(branch, 20)}${changed ? ` · ${changed} changed` : ""}`;
        }
      } catch {
        // The composer still works outside Git or while Git is unavailable.
      }
      git = { cwd, until: now + 2000, label };
    }
    const account = configDir?.replace(/\/+$/, "").split("/").pop();
    const accountLabel =
      !account || account === ".claude"
        ? "personal"
        : account === ".claude2"
          ? "work"
          : account.replace(/^\./, "");
    const modelLabel =
      model.match(/opus|sonnet|haiku|fable/i)?.[0]?.toLowerCase() ?? short(model, 24);
    const window =
      usage.context.window >= 1000000
        ? `${Math.round(usage.context.window / 1000000)}M`
        : `${Math.round(usage.context.window / 1000)}k`;
    const context =
      usage.context.percent === undefined
        ? `ctx —/${window}`
        : `ctx ${Math.round(usage.context.percent)}%/${window}`;
    const limits = usage.rateLimits
      .filter((limit) => ["five_hour", "seven_day", "spend_limit"].includes(limit.kind))
      .map(
        (limit) =>
          `${limit.kind === "five_hour" ? "5h" : limit.kind === "seven_day" ? "7d" : "limit"} ${Math.round(limit.percentUsed)}%`,
      );
    const identity = [
      modelLabel,
      `${short(accountLabel, 16)}:${short(cwd.split("/").filter(Boolean).pop() ?? "/", 24)}`,
      git.label,
    ]
      .filter(Boolean)
      .join(" · ");
    const figures = [
      context,
      ...(usage.cost ? [`$${usage.cost.usd.toFixed(2)}`] : []),
      ...limits,
    ].join(" · ");
    const full = `${identity} · ${figures}`;
    const rows =
      Array.from(full).length <= (e.viewport?.columns ?? 80) - 2 ? [full] : [identity, figures];
    return {
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        native,
        ...rows.map((row): RenderElement => ({
          type: "Text",
          props: { dimColor: true, wrap: "truncate-end" },
          children: [row],
        })),
      ],
    };
  });
}
