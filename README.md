# browser-agent

An MCP server that lets AI agents drive your real browser through a Chrome extension.

```
agent ──MCP (HTTP)──▶ browser-agent server ◀──WebSocket── Chrome extension ──▶ your tabs
```

- The extension connects **out** to the server, so the server can run anywhere: your laptop, a VPS, or a PaaS.
- Every agent gets its **own tab group**, titled with the agent's name. Tabs it opens, or that its clicks open, land in that group.
- Agents read pages as a compact outline with `[eN]` refs. After every action they get a diff of what changed.
- One browser at a time. If a second extension connects, it replaces the first.

Forked from [qwadrox/bb-plugin-desktop-browser-agent](https://github.com/qwadrox/bb-plugin-desktop-browser-agent). The CUA driver, the bb plugin parts, native messaging and most of the guardrails were removed.

> **No guardrails.** Anyone who has the MCP URL can do anything in your browser that you can, including run JavaScript in your logged-in sessions. Keep the `SECRET` secret.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_tabs` | List the open tabs with ids, titles, URLs and groups |
| `browser_navigate` | Open a URL. With no `tab_id` it opens a new tab in the agent's group. Also takes `back`, `forward` and `reload` |
| `browser_read` | Read the page as an outline with refs; `query` and `scope` narrow it |
| `browser_click` | Click a ref with a trusted mouse event |
| `browser_fill` | Fill text fields, selects and checkboxes in one call |
| `browser_key` | Press a key or a combo (`Enter`, `Control+A`, …) |
| `browser_eval` | Run an async JS function body, in an isolated world (default) or the page's `main` world; returns its JSON value |
| `browser_screenshot` | Take a JPEG of the tab or of one ref |
| `browser_close` | Close a tab |

Actions take an optional `wait_for` text to wait for after the action. Dialogs (`alert`, `confirm`, `prompt`) are accepted automatically and reported in the result.

## Run the server

Requires [Bun](https://bun.sh).

```sh
bun install
SECRET=$(openssl rand -hex 16) PORT=3000 bun start
```

| Env | Default | |
| --- | --- | --- |
| `PORT` | `3000` | |
| `SECRET` | *(none)* | Path secret. The endpoints become `/mcp/<SECRET>` and `/ext/<SECRET>`. Without it they're `/mcp` and `/ext`, open to anyone who can reach the server |

Endpoints:

- `POST /mcp/<SECRET>?agent=<name>`: stateless Streamable HTTP MCP. You can send the agent name as an `X-Agent-Id` header instead. The default name is `Agent`.
- `GET /ext/<SECRET>`: the extension's WebSocket.
- `GET /healthz`: `{"ok":true,"browser":{…} | null}`.

To run it with Docker:

```sh
docker build -t browser-agent .
docker run -p 3000:3000 -e SECRET=... browser-agent
```

Behind a reverse proxy, make sure the proxy passes WebSocket upgrades through on `/ext/…`. Tool calls can take up to 90 s, so allow long requests.

## Install the extension

The server URL is compiled into the extension:

```sh
SERVER_URL=wss://browser.example.com/ext/<SECRET> bun run build:extension
# local: SERVER_URL=ws://127.0.0.1:3000/ext/<SECRET>
```

Then in Chrome (version 116 or later), go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `extension/dist`.

The extension reconnects by itself. While it is driving a tab, Chrome shows a "started debugging this browser" bar.

## Connect an agent

Claude Code:

```sh
claude mcp add --transport http browser "https://browser.example.com/mcp/<SECRET>?agent=claude"
```

Any MCP client that speaks Streamable HTTP:

```json
{
  "mcpServers": {
    "browser": { "type": "http", "url": "https://browser.example.com/mcp/<SECRET>?agent=research" }
  }
}
```

Give each agent its own `agent=` name and it gets its own tab group. Agents can still see and use every tab.

## Develop

```sh
bun run dev          # server with --watch
bun run typecheck
CHROMIUM="<Chrome for Testing binary>" bun run test:e2e
```

The end-to-end test starts the server, builds the extension against it, loads the extension into headless Chrome for Testing, and drives it over MCP. Branded Chrome ignores `--load-extension`, so get Chrome for Testing with `npx @puppeteer/browsers install chrome@stable`.

Layout:

- `server/src`: Bun server (`server.ts`), extension bridge (`bridge.ts`), MCP tool definitions (`tools.ts`)
- `extension/src`: service worker (`background.ts`), in-page functions (`page.ts`, `outline.ts`), wire protocol (`shared.ts`)

## License

MIT. See [LICENSE](LICENSE).
