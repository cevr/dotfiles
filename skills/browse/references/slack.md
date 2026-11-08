# Slack in the browser

The owner's Chrome is logged into Slack at `app.slack.com`, so browse reads and drives Slack as the owner. Everything you do there is the owner speaking: sending, reacting, editing, joining, leaving or marking read runs only when the owner asked for that exact action, and then with **read, confirm, verify** (show the exact channel and text, get the go-ahead, act once, read it back).

## Open Slack

```bash
browse session new slack --allow-origin app.slack.com --allow-origin '*.slack.com'
```

```js
await page.goto("https://app.slack.com/client")
await page.waitForURL(/\/client\/T[A-Z0-9]+/)
return { title: await page.title(), outline: await snapshot() }   // title reads "<channel> (Channel) - <workspace> - Slack"
```

A channel's URL is `https://app.slack.com/client/<team id>/<channel id>`; once you know one, `page.goto` it instead of clicking through the sidebar. If the owner already has Slack open in a tab, ask them to click the browse toolbar button on it and adopt it rather than opening a second Slack.

## Read

Slack renders big, virtualized trees; search the snapshot instead of returning it whole:

```js
return await snapshot({ find: /unread|mention/i, context: 1 })
```

- **Unreads**: the sidebar's unread channels are bold `treeitem`s; the Activity view lists mentions and threads. Snapshot with `find`, open each, read, and return a summary.
- **A channel**: `page.getByRole("treeitem", { name: /^engineering/ }).click()`, then wait until the title names it (`page.waitForFunction((c) => document.title.startsWith(c), "engineering")`) so the previous channel cannot satisfy the wait.
- **Messages**: the message list is a `list` of `listitem`s; read the visible ones with `locator.allInnerTexts()`, and scroll the list (`locator.evaluate((el) => el.scrollBy(0, -800))`) for older ones. Slack only renders what is near the viewport.
- **Search**: focus search, `fill` the query, press Enter, then wait for a URL that carries that query before reading the results.

Return text and links, not screenshots of private conversations, unless the owner asked for one.

## Write (only when asked)

```js
const box = page.getByRole("textbox", { name: /Message to #engineering/i })
await box.click()
await box.pressSequentially(text)
// read the composed draft back and return it; send only after the owner confirmed this exact text
```

After the send, verify by reading the last message of the channel.

## Pace and finish

Slack rate-limits bursts; keep one action per second when you click through many channels. Delete the session and tidy the tabs when done. The Slack desktop app is Electron, so it is agent-browser's (`agent-browser skills get electron`); this file covers the web app only.
