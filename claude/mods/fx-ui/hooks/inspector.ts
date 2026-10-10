import type { CodeProps, On } from "claude-code";
import { box, column, text } from "./render";

export type Section = {
  label: string;
  source: string;
  language?: string;
  path?: string;
  format?: CodeProps["format"];
};
export type Document = { title: string; sections: Section[] };
export type Choice = { label: string; load: () => Document | Promise<Document> };
export type Inspector = ReturnType<typeof createInspector>;

const paneId = "fx-inspect";
const pageSize = 8000;

function sourcePage(source: string, page: number): string {
  let start = page * pageSize;
  let end = Math.min(source.length, start + pageSize);
  // Keep surrogate pairs intact at page boundaries, without copying the entire output.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start] ?? "")) start--;
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end] ?? "")) end--;
  return source
    .slice(start, end)
    .replace(/\p{Cc}/gu, (char) =>
      char === "\n" || char === "\t" ? char : JSON.stringify(char).slice(1, -1),
    );
}

export const inspectPane = {
  id: paneId,
  title: "Details",
  focus: true,
  closeOnEscape: true,
  rows: 18,
} as const;

export function createInspector() {
  const state = {
    document: undefined as Document | undefined,
    choices: [] as Choice[],
    loader: undefined as (() => Document | Promise<Document>) | undefined,
    section: 0,
    page: 0,
    async prepare(load: () => Document | Promise<Document>) {
      state.document = await load();
      state.loader = load;
      state.choices = [];
      state.section = state.page = 0;
    },
    choose(items: Choice[]) {
      state.choices = items;
      state.document = state.loader = undefined;
      state.section = state.page = 0;
    },
  };
  return state;
}

export function registerInspector(on: On, inspector: Inspector) {
  on("ui.render", { surface: "terminal", component: "Pane", requestId: paneId }, ($, e) => {
    const { Button, Code } = $.ui.resolve(e);
    if (!inspector.document) {
      return column([
        text("Tool activity", { bold: true }),
        ...inspector.choices
          .slice(inspector.page * 20, (inspector.page + 1) * 20)
          .map((choice, i) =>
            box(
              [
                Button({
                  key: `choice-${i}`,
                  label: choice.label,
                  children: [text("› ")],
                  plain: true,
                  dimColor: true,
                  ...(i === 0 ? { autoFocus: true } : {}),
                  onPress: async () => {
                    await inspector.prepare(choice.load);
                    await $.ui.open(inspectPane);
                    $.ui.invalidate("ui.render");
                  },
                }),
                box([text(choice.label, { dimColor: true, wrap: "truncate-end" })], {
                  flexGrow: 1,
                  flexShrink: 1,
                }),
              ],
              { width: e.props.bodyColumns },
            ),
          ),
        box(
          [
            ...(inspector.page > 0
              ? [
                  Button({
                    key: "previous",
                    label: "Previous",
                    plain: true,
                    onPress: () => {
                      inspector.page--;
                      $.ui.invalidate("ui.render");
                    },
                  }),
                ]
              : []),
            ...((inspector.page + 1) * 20 < inspector.choices.length
              ? [
                  Button({
                    key: "next",
                    label: "Next",
                    plain: true,
                    onPress: () => {
                      inspector.page++;
                      $.ui.invalidate("ui.render");
                    },
                  }),
                ]
              : []),
          ],
          { gap: 2 },
        ),
        ...(!inspector.choices.length
          ? [text("No tool activity has been rendered yet.", { dimColor: true })]
          : []),
      ]);
    }
    const current = inspector.document.sections[inspector.section];
    if (!current) return text("No details available.", { dimColor: true });
    const pages = Math.max(1, Math.ceil(current.source.length / pageSize));
    inspector.page = Math.min(inspector.page, pages - 1);
    return column([
      text(inspector.document.title, { bold: true, wrap: "truncate-end" }),
      box(
        inspector.document.sections.map((item, i) =>
          Button({
            key: `section-${i}`,
            label: item.label,
            plain: true,
            dimColor: i !== inspector.section,
            ...(i === 0 ? { autoFocus: true } : {}),
            onPress: () => {
              inspector.section = i;
              inspector.page = 0;
              $.ui.invalidate("ui.render");
            },
          }),
        ),
        { gap: 2, flexWrap: "wrap" },
      ),
      ...(pages > 1 ? [text(`Page ${inspector.page + 1}/${pages}`, { dimColor: true })] : []),
      Code({
        source: sourcePage(current.source, inspector.page),
        ...(current.language ? { language: current.language } : {}),
        ...(current.path ? { path: current.path } : {}),
        ...(current.format && pages === 1 ? { format: current.format } : {}),
      }),
      box(
        [
          ...(inspector.page > 0
            ? [
                Button({
                  key: "previous",
                  label: "Previous",
                  plain: true,
                  hotkey: "p",
                  onPress: () => {
                    inspector.page--;
                    $.ui.invalidate("ui.render");
                  },
                }),
              ]
            : []),
          ...(inspector.page + 1 < pages
            ? [
                Button({
                  key: "next",
                  label: "Next",
                  plain: true,
                  hotkey: "n",
                  onPress: () => {
                    inspector.page++;
                    $.ui.invalidate("ui.render");
                  },
                }),
              ]
            : []),
          Button({
            key: "copy",
            label: "Copy section",
            plain: true,
            dimColor: true,
            hotkey: "c",
            onPress: (press) => $.ui.copy({ text: current.source, surface: press.surface }),
          }),
          Button({
            key: "refresh",
            label: "Refresh",
            plain: true,
            dimColor: true,
            hotkey: "r",
            onPress: async () => {
              if (inspector.loader) {
                inspector.document = await inspector.loader();
                inspector.page = 0;
                inspector.section = Math.min(
                  inspector.section,
                  inspector.document.sections.length - 1,
                );
                $.ui.invalidate("ui.render");
              }
            },
          }),
        ],
        { gap: 2, flexWrap: "wrap" },
      ),
      text("Esc close · Tab controls", { dimColor: true }),
    ]);
  });
}
