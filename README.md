# browser-agent

An MCP server that lets AI agents drive your real browser through a Chrome extension.

```
agent ──MCP (HTTP)──▶ browser-agent server ◀──WebSocket── Chrome extension ──▶ your tabs
```

- The extension connects **out** to the server, so the server can run anywhere: your laptop, a VPS, or a PaaS.
- Agents keep their tabs in **tab groups named for their task**: `browser_navigate` takes a `group` name for a new tab, and tabs a page opens join its group.
- Agents read pages as a compact outline with `[eN]` refs. After every action they get a diff of what changed.
- One browser at a time. If a second extension connects, it replaces the first.

Forked from [qwadrox/bb-plugin-desktop-browser-agent](https://github.com/qwadrox/bb-plugin-desktop-browser-agent). The CUA driver, the bb plugin parts, native messaging and most of the guardrails were removed.

> **No guardrails.** Anyone who has the MCP URL can do anything in your browser that you can, including run JavaScript in your logged-in sessions. Keep the `SECRET` secret.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_tabs` | List the open tabs with ids, titles, URLs and groups |
| `browser_navigate` | Open a URL. With no `tab_id` it opens a new tab in the tab group named by `group`. Also takes `back`, `forward` and `reload` |
| `browser_read` | Read the page as an outline with refs; `interactive`, `query` and `scope` narrow it. Controls with no name get a hint (icon, test id) |
| `browser_click` | Click a ref or an x/y point with trusted mouse input: right/middle button, double/triple click, modifiers, hover, and drag (including HTML drag and drop) |
| `browser_upload` | Give files to a file input, or drop them on an element, from a path on the browser's computer, a URL, or base64 data |
| `browser_logs` | Console messages, page errors and network requests, recorded from the first call on a tab; `request_id` gives a request's headers and bodies |
| `browser_fill` | Fill text fields, selects and checkboxes in one call |
| `browser_key` | Press a key or a combo (`Enter`, `Control+A`, …) |
| `browser_eval` | Run an async JS function body, in an isolated world (default) or the page's `main` world; returns its JSON value |
| `browser_screenshot` | Take a JPEG of the tab or of one ref |
| `browser_close` | Close a tab |

If the page re-rendered an element, so its ref is gone, actions use the one element with the same role and name and say so.

Actions take an optional `wait_for` text to wait for after the action. Dialogs (`alert`, `confirm`, `prompt`) are accepted automatically and reported in the result.

## On the page

A tab an agent is using glows at its edges and shows a pill at the bottom, "<agent> is using this tab", with a **Stop** button. The agent's cursor glides to each point it clicks, hovers or drags, and the fields it fills get a ring. All of this sits in a closed shadow root, so the page's scripts cannot see into it, and it is left out of `browser_read` and screenshots. While a call runs the pill lets clicks through, so it never covers what the agent clicks. It fades 15 s after the agent's last call.

**Stop** blocks every agent from that tab until you press **Resume**, even after you navigate the tab yourself. The agent gets an error telling it to ask you. To turn all of it off, untick "Show on pages when an agent is using them" in the popup.

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

- `POST /mcp/<SECRET>?agent=<name>`: stateless Streamable HTTP MCP. `agent` (or an `X-Agent-Id` header) is optional: it's the group name when the agent doesn't pass `group`. The default is `Agent`.
- `GET /ext/<SECRET>`: the extension's WebSocket.
- `GET /healthz`: `{"ok":true,"browser":{…} | null}`.

To run it with Docker:

```sh
docker build -t browser-agent .
docker run -p 3000:3000 -e SECRET=... browser-agent
```

Behind a reverse proxy, make sure the proxy passes WebSocket upgrades through on `/ext/…`. Tool calls can take up to 90 s, so allow long requests.

## Install the extension

```sh
bun run build:extension
```

In Chrome (116+) or Brave, open `chrome://extensions` (`brave://extensions`), turn on **Developer mode**, click **Load unpacked** and pick `extension/dist`.

Click the extension's icon, paste the server's extension URL, `https://<host>/ext/<SECRET>` (or `wss://…`), and press **Save**. The popup shows whether it is connected. It reconnects on its own.

To bake a default URL into a build instead (the popup still overrides it): `SERVER_URL=wss://<host>/ext/<SECRET> bun run build:extension`.

While it is driving a tab, Chrome shows a "started debugging this browser" bar.

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

Agents name their own groups per task. `agent=` only sets the fallback name. Agents can still see and use every tab.

## Develop

```sh
bun run dev          # server with --watch
bun run typecheck
CHROMIUM="<Chrome for Testing binary>" bun run test:e2e
```

The end-to-end test starts the server, builds the extension against it, loads the extension into headless Chrome for Testing, and drives it over MCP. Branded Chrome ignores `--load-extension`, so get Chrome for Testing with `npx @puppeteer/browsers install chrome@stable`.

Layout:

- `server/src`: Bun server (`server.ts`), extension bridge (`bridge.ts`), MCP tool definitions (`tools.ts`)
- `extension/src`: service worker (`background.ts`), popup (`popup.ts`), in-page functions (`page.ts`, `outline.ts`), wire protocol (`shared.ts`)

## License

MIT. See [LICENSE](LICENSE).
