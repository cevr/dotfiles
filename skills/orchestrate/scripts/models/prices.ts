// $ per million tokens: input, cache write (shortest TTL), cache read, output.
// A model with no row prints its tokens and a cost of "?": add one line here to price it.
// Claude rows: the claude-api skill's model table, cached 2026-10-06. Codex rows run on the
// ChatGPT subscription; their API price is OpenAI's Standard short-context row (30-minute
// write), https://developers.openai.com/api/docs/pricing, read 2026-10-30.
export type Price = [input: number, cacheWrite: number, cacheRead: number, output: number];

export const PRICE: Record<string, Price> = {
  'claude-opus-5-5': [4, 5, 0.2, 20],
  'claude-sonnet-5-5': [2, 2.5, 0.2, 10],
  'claude-haiku-5-5': [0.1, 0.125, 0.01, 0.5],
  'claude-fable-5-1': [10, 12.5, 0.25, 50],
  'gpt-6.1-sol': [2, 2.5, 0.1, 10],
  'gpt-6-luna': [0.1, 0.125, 0.01, 0.5],
  'gpt-6-astra': [10, 12.5, 1, 50],
  'gpt-5.6-luna': [0.2, 0.25, 0.02, 1.2],
};

export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number };

/** The API price of these tokens, or null when the model has no row. */
export const costOf = (model: string, t: Tokens): number | null => {
  const p = PRICE[model];
  return p ? (t.input * p[0] + t.cacheWrite * p[1] + t.cacheRead * p[2] + t.output * p[3]) / 1e6 : null;
};
