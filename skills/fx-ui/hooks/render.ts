import type { RenderElement, RenderNode } from "claude-code";

// One transcript lane; spacing belongs to turns, not individual activities.
export const transcriptIndent = 2;
export const text = (
  value: string,
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Text", props, children: [value] });
export const box = (
  children: RenderNode[],
  props: Record<string, string | number | boolean> = {},
): RenderElement => ({ type: "Box", props, children });
export const column = (
  children: RenderNode[],
  props: Record<string, string | number | boolean> = {},
): RenderElement => box(children, { flexDirection: "column", ...props });

export function brief(value: string, limit = 180): string {
  const chars = Array.from(
    value
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
