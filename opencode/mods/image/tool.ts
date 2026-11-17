// The `image` tool as the agent sees it: its name, input and description,
// and the words its receipt answers with. The input is `Input`
// (request.ts) with what each field means; `paid` is the only way to the paid
// API, and its description says when not to set it.
import { Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import { Background, Format, MAX_COUNT, MAX_IMAGES, PaidModel, Quality } from "./request.ts"

export const NAME = "image"

/** OpenCode's own image tool, which this one replaces. */
export const UPSTREAM_TOOL = "experimental_image_generate"

const Paid = Schema.Struct({
  model: PaidModel.annotate({ description: "`flare`: GPT Image 2.5 Flare, fast. `sunburst`: GPT Image 2.5 Sunburst, for precise edits." }),
  quality: Schema.optionalKey(Quality).annotate({ description: "Rendering quality. Default: the API's (auto)." }),
  background: Schema.optionalKey(Background).annotate({ description: "`transparent` needs format png or webp." }),
  n: Schema.optionalKey(Schema.Int).annotate({ description: `How many images, 1 to ${MAX_COUNT}. Each is billed. They are saved as <path>-1, <path>-2, ….` }),
  mask: Schema.optionalKey(Schema.String).annotate({
    description: "A PNG whose transparent areas mark where to edit the first of `images`. Relative to the session directory or absolute.",
  }),
}).annotate({
  description:
    "The paid OpenAI Images API (billed per image to the OpenAI key). Never set it unless the user asks for the paid API, Flare or Sunburst, or for something only it does: an exact size, a transparent background, several images, a masked edit. Without it the ChatGPT subscription makes the image at no extra cost.",
})

export const ImageInput = toolInput(
  Schema.Struct({
    prompt: Schema.String.annotate({ description: "What to create, or what to change in `images`." }),
    images: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: `Up to ${MAX_IMAGES} local PNG, JPEG, WebP or GIF files, relative to the session directory or absolute, each at most 20 MiB. Subscription: references for style, subject or composition. Paid: the sources to edit.`,
    }),
    path: Schema.optionalKey(Schema.String).annotate({
      description: "Where to save, relative to the session directory or absolute; an existing file is replaced. Default: a new file in this session's image folder under the temp directory.",
    }),
    size: Schema.optionalKey(Schema.String).annotate({
      description: "`auto` (default) or WIDTHxHEIGHT, e.g. 1536x1024 (landscape) or 1024x1536 (portrait). The subscription takes it as a request and may change it (the result says so); the paid API makes it exact.",
    }),
    format: Schema.optionalKey(Format).annotate({ description: "`png` (default), `webp` or `jpeg`." }),
    paid: Schema.optionalKey(Paid),
  }),
)
export type ImageInput = typeof ImageInput.Type

export const DESCRIPTION = [
  "Make or edit an image. By default the ChatGPT subscription makes it, at no cost past the plan; the paid OpenAI Images API is used only when you set `paid`.",
  "- It runs in the background as a job outside the server: the call returns at once with the job's id, the path and the route, and a letter with the saved path, its size and the route wakes this session when it ends. Never poll, sleep or check for the file meanwhile; end your turn unless other work remains. A subagent waits with job({ action: \"wait\", id }).",
  "- After the letter, read the path to see the image.",
  "- Pass images as references (subscription) or as the sources to edit (paid).",
  "- Leave `paid` out unless the user asked for the paid API, Flare or Sunburst, or for what only it does.",
].join("\n")

/** What the call answers: the job's id, where the image goes and the route; the letter comes later. */
export const receipt = (id: string, path: string, route: string) =>
  [
    `Image job ${id} started via ${route}. It saves to ${path}.`,
    "You will be notified with the saved path when it ends: do not poll, sleep or check for the file. End your turn unless other work remains; a subagent waits with job({ action: \"wait\", id: \"" + id + "\" }).",
  ].join("\n")

/** The job's note, which the end letter carries. */
const excerpt = (prompt: string) => {
  const short = prompt.replace(/\s+/gu, " ").trim()
  if (short.length <= 80) return short
  return `${short.slice(0, 80)}…`
}

export const note = (route: string, prompt: string) => {
  const head = excerpt(prompt)
  return `Image (${route}): "${head}". The log tail above says where it was saved, or the failure's code and fix. Read the path to view it.`
}
