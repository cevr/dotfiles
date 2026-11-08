# Derive an API client from a captured flow

Drive a site once in the owner's browser while browse captures its traffic, then write a client that calls the site's internal API directly. browse writes the HAR with every credential (cookies, auth headers, tokens in query or body fields) replaced by a stable `${BC_SECRET_N}` reference, and can keep the real values in a mode-0600 **secret profile** that the client receives as environment variables. You never see or copy a credential.

## 1. Capture

Log in first (the owner's Chrome usually already is), then capture only the flows the client needs:

```bash
browse session new site --allow-origin app.example.com
browse network start --session site --url /api/ --resource-type fetch --resource-type xhr
browse execute --session site --file flow.js          # search "alpha", open one item
browse execute --session site --file flow-2.js        # search "beta", open another
browse network stop --session site --output ./site.har --secrets site
```

Run each flow at least twice with different inputs: the diff separates parameters from constants. MCP: the `network` tool with `action: "start"` / `"stop"` (`outputPath`, `secrets`). A capture ends by itself after 30 minutes, discarding what it holds; `network status` shows its counts. Bodies are embedded by default (`--content omit` drops them; `--max-body-bytes` caps each).

## 2. Identify the endpoints

```bash
jq -r '.log.entries[] | "\(.request.method) \(.response.status) \(.request.url)"' site.har
jq '.log.entries[] | select(.request.url | test("api/search"))
  | {method: .request.method, headers: .request.headers, body: .request.postData.text, response: .response.content.text}' site.har
```

Keep first-party JSON calls that line up with the actions you took; drop telemetry (`/collect`, `/track`, `/beacon`), third-party hosts and static assets.

## 3. Read shapes and auth

- Type the responses from `.response.content.text`.
- Auth is whatever became `${BC_SECRET_N}` (a cookie, `authorization`, `x-csrf-token`, a site-specific header). `browse secrets status site` shows the profile's metadata, never the values. Test by omission in step 5 which ones the API needs.
- Keep the headers the API checks (`user-agent`, `referer`, `x-requested-with`) as observed.

## 4. Generate the client

- One typed function per captured flow (`search(query)`, `getItem(id)`), with the pagination, sort and filter parameters seen in the query strings as options.
- Read each credential from its environment variable (`process.env.BC_SECRET_1`); fail with a message that tells the owner to refresh the profile when a call returns 401 or 403.
- Never write a captured value into source, a fixture or a test.

## 5. Verify

Call every function for real, with harmless read-only requests, through the profile:

```bash
browse secrets run site -- bun ./site-client.ts search alpha
```

Compare each response with the HAR's shape.

| Symptom | Cause | Fix |
| --- | --- | --- |
| 401 or 403 | expired session | `browse secrets refresh site --session site --url /api/` reloads the page and refreshes the values under the same references |
| 403 or 419 on writes | per-session or per-form CSRF token | fetch the token endpoint first, or leave that flow browser-driven |
| works, then breaks | signed or expiring parameters | keep that step in the browser, derive the rest |
| a shape unlike the HAR | A/B or geo variation | capture again; make the differing fields optional |

## Caveats

- Internal APIs change without notice: keep the HAR (it holds references, not values) so the client can be derived again.
- Respect the site's terms and rate limits; pace bulk fetches.
- Delete the session and tidy the tabs when the capture is done.
