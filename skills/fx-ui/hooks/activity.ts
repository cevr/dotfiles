import type { ToolGroupCall } from "claude-code";
import type { Document, Section } from "./inspector";
import { brief, duration } from "./render";

export type Activity = { label: string; category: string; collapse: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function lineCount(source: string): number {
  return source === "" ? 0 : source.split("\n").length - Number(source.endsWith("\n"));
}

function patchStats(result: Record<string, unknown>): string {
  const diff = record(result.gitDiff);
  if (count(diff?.additions) && count(diff?.deletions))
    return ` +${diff.additions} −${diff.deletions}`;
  if (!Array.isArray(result.structuredPatch) || !result.structuredPatch.length) return "";
  let added = 0;
  let removed = 0;
  for (const raw of result.structuredPatch) {
    const patch = record(raw);
    if (!Array.isArray(patch?.lines) || !patch.lines.every((line) => typeof line === "string"))
      return "";
    for (const line of patch.lines) {
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
  }
  return ` +${added} −${removed}`;
}

function pathLabel(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, "");
  return brief(root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
}

export function describeActivity(call: ToolGroupCall, cwd: string): Activity | undefined {
  const input = record(call.input);
  const result = record(call.output);
  if (!input) return undefined;
  const safe = !call.isErrored && !call.isInterrupted && !result?.staged && !result?.userModified;
  if (["Read", "Write", "Edit"].includes(call.tool) && typeof input.file_path === "string") {
    const path = pathLabel(input.file_path, cwd);
    if (call.tool === "Read") {
      const file = record(result?.file);
      return {
        label: `Read ${path}`,
        category: "read",
        collapse:
          safe &&
          result?.type === "text" &&
          typeof file?.content === "string" &&
          !file.truncatedByTokenCap,
      };
    }
    const verb = call.isRunning ? call.tool : call.tool === "Write" ? "Wrote" : "Edited";
    let suffix = result ? patchStats(result) : "";
    if (call.tool === "Write" && !call.isRunning && typeof result?.content === "string") {
      if (result.type === "update" && result.originalFile === result.content)
        return { label: `No changes to ${path}`, category: "write", collapse: safe };
      if (!suffix && result.type === "create") suffix = ` +${lineCount(result.content)} −0`;
      else if (!suffix) {
        const lines = lineCount(result.content);
        suffix = ` · ${lines} ${lines === 1 ? "line" : "lines"}`;
      }
    }
    return {
      label: `${verb} ${path}${call.isRunning ? "" : suffix}`,
      category: call.tool === "Write" ? "write" : "edit",
      collapse: safe && typeof result?.filePath === "string",
    };
  }
  if (call.tool === "Bash" && typeof input.command === "string") {
    const multiline = input.command.trim().includes("\n");
    const command = brief(input.command.trim().split("\n")[0] ?? "");
    const lines = typeof result?.stdout === "string" ? lineCount(result.stdout) : undefined;
    const background =
      result?.backgroundTaskId ||
      result?.timedOutAfterMs ||
      result?.backgroundedByUser ||
      result?.backgroundedByTurnAbort ||
      result?.backgroundedToDeliverMessage;
    return {
      label: `${call.isRunning ? "Running" : "Ran"} ${command}${multiline ? " …" : ""}${!call.isRunning && lines ? ` · ${lines} ${lines === 1 ? "line" : "lines"}` : ""}`,
      category: "command",
      collapse:
        safe &&
        typeof result?.stdout === "string" &&
        typeof result.stderr === "string" &&
        !result.stderr &&
        !result.interrupted &&
        !result.isImage &&
        !background &&
        !result.returnCodeInterpretation &&
        !result.gitOperation &&
        !result.staleReadFileStateHint &&
        !result.ghRateLimitHint &&
        !result.rawOutputPath &&
        !result.persistedOutputPath,
    };
  }
  if ((call.tool === "Grep" || call.tool === "Glob") && typeof input.pattern === "string") {
    const files = result && count(result.numFiles) ? result.numFiles : undefined;
    const matches = result && count(result.numMatches) ? result.numMatches : undefined;
    const n = call.tool === "Grep" && matches !== undefined ? matches : files;
    const noun = call.tool === "Grep" && matches !== undefined ? "match" : "file";
    const suffix =
      n === undefined ? "" : ` · ${n} ${noun}${n === 1 ? "" : noun === "match" ? "es" : "s"}`;
    return {
      label: `${call.tool === "Grep" ? "Searched" : "Found"} ${JSON.stringify(brief(input.pattern, 100))}${suffix}`,
      category: call.tool === "Grep" ? "search" : "list",
      collapse:
        safe &&
        !!result &&
        !result.truncated &&
        result.countIsComplete !== false &&
        !(count(result.appliedOffset) && result.appliedOffset > 0) &&
        !(
          count(result.totalFiles) &&
          count(result.numFiles) &&
          result.totalFiles > result.numFiles
        ) &&
        !(
          count(result.totalLines) &&
          count(result.numLines) &&
          result.totalLines > result.numLines
        ) &&
        !(
          count(result.appliedLimit) &&
          result.appliedLimit > 0 &&
          ((count(result.numLines) && result.numLines >= result.appliedLimit) ||
            (count(result.numFiles) && result.numFiles >= result.appliedLimit))
        ) &&
        (typeof result.content === "string" ||
          (Array.isArray(result.filenames) &&
            result.filenames.every((path) => typeof path === "string"))),
    };
  }
  if ((call.tool === "Agent" || call.tool === "Task") && typeof input.description === "string") {
    const calls = count(result?.totalToolUseCount) ? ` · ${result.totalToolUseCount} calls` : "";
    const elapsed = count(result?.totalDurationMs) ? ` · ${duration(result.totalDurationMs)}` : "";
    const handback = record(result?.handbackReport);
    return {
      label: `Agent · ${brief(input.description, 120)}${call.isRunning ? "" : calls + elapsed}`,
      category: "agent",
      collapse:
        safe &&
        result?.status === "completed" &&
        result.handback !== "flagged" &&
        result.handback !== "withheld" &&
        !handback?.warning &&
        Array.isArray(result.content) &&
        result.content.every((part) => {
          const item = record(part);
          return item?.type === "text" && typeof item.text === "string";
        }),
    };
  }
  return undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "No captured result.";
}

function diffSection(result: Record<string, unknown>): Section | undefined {
  if (!Array.isArray(result.structuredPatch) || !result.structuredPatch.length) return undefined;
  const hunks: string[] = [];
  for (const raw of result.structuredPatch) {
    const patch = record(raw);
    if (
      !patch ||
      ![patch.oldStart, patch.oldLines, patch.newStart, patch.newLines].every(count) ||
      !Array.isArray(patch.lines) ||
      !patch.lines.every((line) => typeof line === "string")
    )
      return undefined;
    hunks.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@\n${patch.lines.join("\n")}`,
    );
  }
  return { label: "Diff", source: hunks.join("\n"), format: "diff", language: "diff" };
}

export function activityDocument(call: ToolGroupCall, cwd: string): Document {
  const result = record(call.output);
  const sections: Section[] = [];
  const diff = result ? diffSection(result) : undefined;
  if (diff) sections.push(diff);
  if (call.tool === "Bash" && result && typeof result.stdout === "string") {
    sections.push({ label: "Output", source: result.stdout });
    if (typeof result.stderr === "string" && result.stderr)
      sections.push({ label: "Stderr", source: result.stderr });
  } else if (call.tool === "Read" && result?.type === "text") {
    const file = record(result.file);
    if (typeof file?.content === "string")
      sections.push({
        label: "File",
        source: file.content,
        ...(typeof file.filePath === "string" ? { path: file.filePath } : {}),
      });
  } else if (result && typeof result.content === "string") {
    sections.push({ label: "Output", source: result.content });
  } else if (
    result &&
    Array.isArray(result.filenames) &&
    result.filenames.every((path) => typeof path === "string")
  ) {
    sections.push({ label: "Files", source: result.filenames.join("\n") });
  } else if (
    result &&
    Array.isArray(result.content) &&
    result.content.every((part) => typeof record(part)?.text === "string")
  ) {
    sections.push({
      label: "Report",
      source: result.content.map((part) => record(part)?.text).join("\n\n"),
    });
  }
  sections.push({ label: "Arguments", source: json(call.input), language: "json" });
  sections.push({ label: "Result", source: json(call.output), language: "json" });
  return { title: describeActivity(call, cwd)?.label ?? brief(call.tool), sections };
}
