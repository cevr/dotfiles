---
name: image
description: Make or edit images with the `image` tool. Use for illustrations, diagrams, logos, photos, slide art, or changing an existing image. Covers the subscription and paid routes, sizes, references, masks and failure codes.
---

# image

Call the `image` tool. It runs as a background job and returns at once; the result arrives as a letter naming the saved path, its dimensions and the route. Then `read` the path to see it. A subagent waits with `job({ action: "wait", id })`.

## Routes

- **Subscription (default).** The ChatGPT subscription's image tool, through the Codex login (`codex login`). No cost past the plan. Use it for everything unless the user asks otherwise.
- **Paid.** The OpenAI Images API with GPT Image 2.5, billed per image. Only when the user asks for the paid API, Flare or Sunburst, or for what only it does: an exact size, a transparent background, several images at once (`n`), a masked edit, `quality` up to `max`. Ask the user first when the paid route would only be nicer.
  - `flare`: fast, good for most paid work.
  - `sunburst`: slower, for precise edits and fine detail.

## Size

- Subscription: `size` is a request. The backend may change it (a square often comes back 1254x1254); the letter says so when it did. Ask for `1536x1024` (landscape) or `1024x1536` (portrait) for slides and posters.
- Paid: the size is exact. Each side a multiple of 16 and at most 3840, the ratio between 1:3 and 3:1, the total 655,360 to 8,294,400 pixels; above 2560x1440 is experimental. A transparent background needs `png` or `webp`.

## Images

- Subscription: `images` are references for style, subject or composition (up to 16).
- Paid: `images` are the sources to edit; `paid.mask` is a PNG whose transparent areas mark where to change, applied to the first source. A mask guides the edit; it is not pixel exact.

## Failures

The letter starts with a code:

| Code | Fix |
| --- | --- |
| `AUTH_MISSING` | Subscription: the user runs `codex login`. Paid: set `OPENAI_API_KEY`, or the user stores a key with `bun cmd/image/key.ts set --stdin` in the dotfiles' `opencode/`. |
| `AUTH_EXPIRED` | Subscription: `codex login` again. Paid: replace the key. |
| `GENERATION_FAILED` | The backend refused or failed (rate limit, safety, outage). Wait or rephrase; do not switch to paid on your own. |
| `NO_IMAGE` | Rephrase the prompt. |
| `INVALID_INPUT` | Fix the input the message names. |
| `WRITE_FAILED` | Pick a path you can write to. |
