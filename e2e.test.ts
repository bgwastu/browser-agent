/**
 * End to end: a real headless Chromium with the extension, connected to the
 * server over WebSocket, driven through MCP. Opt-in:
 *
 *   CHROMIUM=<path to Chrome for Testing or Chromium> bun run test:e2e
 *
 * Branded Chrome and Brave ignore --load-extension, so use Chrome for Testing:
 *   npx @puppeteer/browsers install chrome@stable
 * It uses a throwaway profile, so no installed browser is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { $, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "./server/src/server.js";

const enabled = process.env.BROWSER_E2E === "1" && process.env.CHROMIUM !== undefined;
const SECRET = "test-secret";

const FORM = `<!doctype html><title>Form</title>
<h1>Expenses</h1>
<label for="name">Name</label><input id="name">
<label for="kind">Kind</label><select id="kind"><option value="a">Food</option><option value="b">Travel</option></select>
<button id="save" style="display:block;margin:20px;width:100px;height:30px" onclick="document.getElementById('out').textContent = 'Saved: ' + document.getElementById('name').value + ' / ' + document.getElementById('kind').selectedOptions[0].text">Save</button>
<p id="out"></p>
<a href="/second">Next page</a>
<div style="height:3000px"></div>`;
const PANEL = `<!doctype html><title>Panel</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden } main { height: 100vh; overflow-y: auto }</style>
<main id="workspace"><h1>Inbox</h1>
<button onclick="history.pushState({}, '', '/panel/settings'); document.querySelector('h1').textContent = 'Settings'; document.getElementById('body').innerHTML = '<p>Notifications</p><p>Privacy</p><p>Theme</p>'">Settings</button>
<div id="body"><p>Message 1</p></div><div style="height:4000px"></div></main>`;
const SECOND = `<!doctype html><title>Second</title><p>Second page</p>`;
const FEATURES = `<!doctype html><title>Features</title>
<script>window.appState = { user: "ada", items: 3 };</script>
<header><a href="/second">Home</a></header>
<main>
<h1>Features</h1>
<button onclick="const row = document.createElement('li'); row.textContent = 'Row ' + (document.querySelectorAll('#list li').length + 1); document.getElementById('list').append(row)">Add row</button>
<ul id="list"><li>Row 1</li></ul>
<button onclick="document.getElementById('answer').textContent = confirm('Delete everything?') ? 'Deleted' : 'Kept'">Delete</button>
<button onclick="document.getElementById('answer').textContent = 'Name: ' + prompt('Your name?', 'Bob')">Ask name</button>
<p id="answer"></p>
<a href="/second" target="_blank">Open second</a>
<button onclick="setTimeout(() => { document.getElementById('late').textContent = 'Loaded late' }, 1500)">Load later</button>
<p id="late"></p>
<form><label>Email <input id="email"></label> <label>Plan <select><option>Free</option><option>Pro</option></select></label>
<label><input type="checkbox"> Accept terms</label></form>
<iframe title="Embedded" srcdoc="<button onclick=&quot;document.body.insertAdjacentHTML('beforeend', '<p>Frame clicked</p>')&quot;>Frame button</button>" style="width:300px;height:100px"></iframe>
</main>
<div role="dialog" aria-label="Cookies"><p>We use cookies</p><button>Accept cookies</button></div>`;

const TOOLKIT = `<!doctype html><title>Toolkit</title>
<script>function note(text) { const li = document.createElement('li'); li.textContent = 'Log: ' + text; document.getElementById('out').append(li); console.log('note', text); }
function rerender() { const b = document.createElement('button'); b.textContent = 'Target'; b.onclick = () => note('target'); document.getElementById('box').replaceChildren(b); }</script>
<button data-testid="trash-btn" onclick="note('trash')"><svg width="16" height="16"><title>Trash</title><rect width="16" height="16"/></svg></button>
<button oncontextmenu="event.preventDefault(); note('context')">Context me</button>
<button ondblclick="note('double')">Double me</button>
<button onmouseenter="note('hovered')">Hover me</button>
<button onclick="note(event.shiftKey ? 'shift click' : 'plain click')">Mod me</button>
<button id="point" onclick="note('point click')">Point me</button>
<div id="box"><button onclick="note('target')">Target</button></div>
<button onclick="rerender()">Rerender</button>
<div draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'card')">Drag card</div>
<div role="button" ondragover="event.preventDefault()" ondrop="event.preventDefault(); note('dropped ' + event.dataTransfer.getData('text/plain'))">Drop zone</div>
<label>Attachment <input type="file" multiple onchange="note('files ' + [...this.files].map((f) => f.name + ':' + f.size).join(','))"></label>
<div role="button" ondragover="event.preventDefault()" ondrop="event.preventDefault(); note('dropped files ' + [...event.dataTransfer.files].map((f) => f.name).join(','))">File dropzone</div>
<button onclick="fetch('/api/data?x=1').then((r) => r.json()).then((j) => note('api ' + j.value))">Call API</button>
<button onclick="console.error('boom here'); setTimeout(() => { throw new Error('kaboom') })">Fail</button>
<p>Plain paragraph text</p>
<ul id="out"></ul>`;

function refFor(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((entry) => pattern.test(entry));
  const ref = line === undefined ? undefined : /^\[(e\d+)\]/.exec(line)?.[1];
  if (ref === undefined) throw new Error(`no ref matches ${pattern} in:\n${text}`);
  return ref;
}

function tabIdIn(text: string): number {
  const match = /tab (\d+):/.exec(text);
  if (match === null) throw new Error(`no tab id in:\n${text}`);
  return Number(match[1]);
}

describe.skipIf(!enabled)("browser-agent end to end", () => {
  let work: string;
  let chromium: Subprocess;
  let pages: ReturnType<typeof Bun.serve>;
  let app: ReturnType<typeof startServer>;
  let base: string;
  const clients = new Map<string, Client>();

  /** An MCP client for one agent name. */
  async function client(agent: string): Promise<Client> {
    const existing = clients.get(agent);
    if (existing !== undefined) return existing;
    const created = new Client({ name: "e2e", version: "0" });
    await created.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.port}/mcp/${SECRET}?agent=${agent}`)));
    clients.set(agent, created);
    return created;
  }

  /** Calls a tool and returns its text; a failed call throws with the message. */
  async function call(name: string, args: Record<string, unknown> = {}, agent = "research"): Promise<string> {
    const result = (await (await client(agent)).callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string; data?: string }>;
      isError?: boolean;
    };
    const text = result.content.map((part) => (part.type === "text" ? part.text : `[${part.type} ${part.data?.length ?? 0}]`)).join("\n");
    if (result.isError === true) throw new Error(text);
    return text;
  }

  beforeAll(async () => {
    work = mkdtempSync("/tmp/browser-agent-e2e-");
    app = startServer({ port: 0, secret: SECRET, hostname: "127.0.0.1" });
    pages = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/data") return Response.json({ value: 42 });
        if (path === "/files/report.txt") return new Response("from a url", { headers: { "content-type": "text/plain" } });
        const html = ({ "/second": SECOND, "/features": FEATURES, "/panel": PANEL, "/toolkit": TOOLKIT } as Record<string, string>)[path] ?? FORM;
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${pages.port}`;

    const extension = join(work, "extension");
    await $`bun ${join(import.meta.dir, "extension/build.ts")}`.env({
      ...process.env,
      SERVER_URL: `ws://127.0.0.1:${app.server.port}/ext/${SECRET}`,
      OUT_DIR: extension,
    }).quiet();

    chromium = Bun.spawn(
      [
        process.env.CHROMIUM!,
        `--user-data-dir=${join(work, "profile")}`,
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "--window-size=1000,800",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const deadline = Date.now() + 30_000;
    while (!app.bridge.connected || app.bridge.info === null) {
      if (Date.now() > deadline) throw new Error("The extension did not connect to the server.");
      await Bun.sleep(200);
    }
  }, 60_000);

  afterAll(async () => {
    for (const each of clients.values()) await each.close().catch(() => undefined);
    chromium?.kill();
    await Bun.sleep(300);
    pages?.stop(true);
    app?.server.stop(true);
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  let tabId: number;

  it("lists the eleven tools", async () => {
    const { tools } = await (await client("research")).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "browser_click", "browser_close", "browser_eval", "browser_fill", "browser_key", "browser_logs", "browser_navigate", "browser_read",
        "browser_screenshot", "browser_tabs", "browser_upload",
      ].sort(),
    );
  });

  it("opens a tab in the agent's own group and reads it", async () => {
    const opened = await call("browser_navigate", { url: `${base}/form` });
    tabId = tabIdIn(opened);
    const page = await call("browser_read", { tab_id: tabId });
    expect(page).toContain("# Expenses");
    expect(page).toMatch(/\[e\d+\] textbox "Name"/);
    const tabs = await call("browser_tabs");
    expect(tabs).toContain(`tab ${tabId}: Form — ${base}/form [group: research]`);
  });

  it("fills a text field and a select, then clicks", async () => {
    const page = await call("browser_read", { tab_id: tabId });
    const filled = await call("browser_fill", {
      tab_id: tabId,
      fields: [
        { ref: refFor(page, /textbox "Name"/), value: "Ada" },
        { ref: refFor(page, /combobox/), value: "Travel" },
      ],
    });
    expect(filled).toContain('= "Ada"');
    expect(filled).toContain('= "Travel"');
    const clicked = await call("browser_click", { tab_id: tabId, ref: refFor(page, /button "Save"/) });
    expect(clicked).toContain("+ Saved: Ada / Travel");
  });

  it("refuses refs from an older page after navigation, and goes back", async () => {
    const page = await call("browser_read", { tab_id: tabId });
    const link = refFor(page, /link "Next page"/);
    const clicked = await call("browser_click", { tab_id: tabId, ref: link });
    expect(clicked).toContain("Second page");
    await expect(call("browser_click", { tab_id: tabId, ref: link })).rejects.toThrow(/not on the page now/);
    expect(await call("browser_navigate", { tab_id: tabId, url: "back" })).toContain("Expenses");
  });

  it("takes a screenshot, or explains why not", async () => {
    try {
      expect(await call("browser_screenshot", { tab_id: tabId })).toMatch(/^\[image \d{4,}\]$/);
    } catch (error) {
      expect(String(error)).toContain("not drawing this tab");
    }
  });

  it("names the group after the task, and scrolls a page's inner panel", async () => {
    const panel = tabIdIn(await call("browser_navigate", { url: `${base}/panel`, group: "Mail triage" }));
    expect(await call("browser_tabs")).toContain(`tab ${panel}: Panel — ${base}/panel [group: Mail triage]`);
    expect(await call("browser_read", { tab_id: panel })).toContain("Scroll: 0 of ");
    await call("browser_key", { tab_id: panel, key: "End" });
    expect(await call("browser_read", { tab_id: panel })).toMatch(/Scroll: [1-9]\d+ of \d+ px \(in the page's scrolling panel/);
    await call("browser_key", { tab_id: panel, key: "Home" });
    expect(await call("browser_read", { tab_id: panel })).toContain("Scroll: 0 of ");
    // An in-app navigation keeps the header, but is still reported as a new page.
    const page = await call("browser_read", { tab_id: panel });
    const moved = await call("browser_click", { tab_id: panel, ref: refFor(page, /button "Settings"/) });
    expect(moved).toContain("The page changed");
    expect(moved).toContain("Privacy");
    await call("browser_close", { tab_id: panel });
  });

  it("gives another agent its own group", async () => {
    const opened = await call("browser_navigate", { url: `${base}/second` }, "shopping");
    const other = tabIdIn(opened);
    expect(await call("browser_tabs", {}, "shopping")).toContain(`tab ${other}: Second — ${base}/second [group: shopping]`);
    await call("browser_close", { tab_id: other }, "shopping");
  });

  describe("on a page with mouse, file and log features", () => {
    let tab: number;
    let page: string;

    beforeAll(async () => {
      tab = tabIdIn(await call("browser_navigate", { url: `${base}/toolkit`, group: "Toolkit" }));
      page = await call("browser_read", { tab_id: tab });
    });

    it("hints at unnamed controls, and reads only interactive lines", async () => {
      expect(page).toMatch(/\[e\d+\] button "" hint="icon:Trash; testid:trash-btn"/);
      const interactive = await call("browser_read", { tab_id: tab, interactive: true });
      expect(interactive).toContain('button "Point me"');
      expect(interactive).not.toContain("Plain paragraph text");
    });

    it("right-clicks, double-clicks, hovers and clicks with a modifier", async () => {
      expect(await call("browser_click", { tab_id: tab, ref: refFor(page, /"Context me"/), button: "right" })).toContain("+ - Log: context");
      expect(await call("browser_click", { tab_id: tab, ref: refFor(page, /"Double me"/), count: 2 })).toContain("+ - Log: double");
      const hovered = await call("browser_click", { tab_id: tab, ref: refFor(page, /"Hover me"/), hover: true });
      expect(hovered).toContain("Hovered [");
      expect(hovered).toContain("+ - Log: hovered");
      expect(await call("browser_click", { tab_id: tab, ref: refFor(page, /"Mod me"/), modifiers: "shift" })).toContain("+ - Log: shift click");
    });

    it("clicks a point", async () => {
      const box = await call("browser_eval", { tab_id: tab, code: "const r = document.getElementById('point').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]" });
      const [x, y] = JSON.parse(box.slice(box.indexOf("["), box.indexOf("]") + 1)) as [number, number];
      const clicked = await call("browser_click", { tab_id: tab, x, y });
      expect(clicked).toContain('"Point me"');
      expect(clicked).toContain("+ - Log: point click");
    });

    it("finds a re-rendered element by its role and name", async () => {
      const target = refFor(page, /button "Target"/);
      await call("browser_click", { tab_id: tab, ref: refFor(page, /"Rerender"/) });
      const clicked = await call("browser_click", { tab_id: tab, ref: target });
      expect(clicked).toContain(`Ref ${target} was re-rendered; used e`);
      expect(clicked).toContain("+ - Log: target");
    });

    it("drags with HTML drag and drop", async () => {
      const dragged = await call("browser_click", { tab_id: tab, ref: refFor(page, /draggable "Drag card"/), drag_to: refFor(page, /button "Drop zone"/) });
      expect(dragged).toContain("+ - Log: dropped card");
    });

    it("uploads files by path, URL and data, and drops them", async () => {
      const input = refFor(page, /file "Attachment/);
      const path = join(work, "notes.txt");
      writeFileSync(path, "hello");
      expect(await call("browser_upload", { tab_id: tab, ref: input, files: [{ path }] })).toContain("+ - Log: files notes.txt:5");
      const both = await call("browser_upload", {
        tab_id: tab,
        ref: input,
        files: [{ url: `${base}/files/report.txt` }, { data: btoa("abc"), name: "a.txt", mime_type: "text/plain" }],
      });
      expect(both).toContain("+ - Log: files report.txt:10,a.txt:3");
      const dropped = await call("browser_upload", { tab_id: tab, ref: refFor(page, /"File dropzone"/), files: [{ data: btoa("x"), name: "drop.png" }] });
      expect(dropped).toContain("Dropped");
      expect(dropped).toContain("+ - Log: dropped files drop.png");
    });

    it("records console messages, errors and network requests", async () => {
      expect(await call("browser_logs", { tab_id: tab })).toContain("Recording");
      await call("browser_click", { tab_id: tab, ref: refFor(page, /"Fail"/) });
      await call("browser_click", { tab_id: tab, ref: refFor(page, /"Call API"/), wait_for: "api 42" });
      const logs = await call("browser_logs", { tab_id: tab });
      expect(logs).toContain("[error] boom here");
      expect(logs).toContain("kaboom");
      expect(logs).toContain("[log] note api 42");
      const network = await call("browser_logs", { tab_id: tab, kind: "network", query: "/api/" });
      expect(network).toMatch(/#\S+ GET 200 Fetch http:\/\/127\.0\.0\.1:\d+\/api\/data\?x=1/);
      const id = /#(\S+) GET/.exec(network)![1]!;
      const detail = await call("browser_logs", { tab_id: tab, request_id: id });
      expect(detail).toContain('{"value":42}');
      await call("browser_navigate", { tab_id: tab, url: "reload" });
      expect(await call("browser_logs", { tab_id: tab, query: "navigated" })).toContain("--- page loaded: http://127.0.0.1");
      await call("browser_close", { tab_id: tab });
    });
  });

  describe("on a page with dialogs, frames and late content", () => {
    let tab: number;
    let page: string;

    beforeAll(async () => {
      tab = tabIdIn(await call("browser_navigate", { url: `${base}/features` }));
      page = await call("browser_read", { tab_id: tab });
    });

    it("reports what an action changed, and keeps refs", async () => {
      const add = refFor(page, /button "Add row"/);
      const clicked = await call("browser_click", { tab_id: tab, ref: add });
      expect(clicked).toContain(`Clicked [${add}] button "Add row"`);
      expect(clicked).toContain("+ - Row 2");
      expect(refFor(await call("browser_read", { tab_id: tab }), /button "Add row"/)).toBe(add);
    });

    it("accepts dialogs automatically and reports them", async () => {
      const confirmed = await call("browser_click", { tab_id: tab, ref: refFor(page, /button "Delete"/) });
      expect(confirmed).toContain('confirm dialog, accepted automatically: "Delete everything?"');
      expect(confirmed).toContain("+ Deleted");
      const prompted = await call("browser_click", { tab_id: tab, ref: refFor(page, /button "Ask name"/) });
      expect(prompted).toContain("+ Name: Bob");
    });

    it("puts a tab a link opened in the agent's group", async () => {
      const clicked = await call("browser_click", { tab_id: tab, ref: refFor(page, /link "Open second"/) });
      expect(clicked).toContain(`It opened tab`);
      const opened = tabIdIn(clicked.slice(clicked.indexOf("It opened")));
      expect(await call("browser_tabs")).toContain(`tab ${opened}: Second — ${base}/second [group: research]`);
      await call("browser_close", { tab_id: opened });
    });

    it("waits for late content", async () => {
      const late = await call("browser_click", { tab_id: tab, ref: refFor(page, /button "Load later"/), wait_for: "Loaded late" });
      expect(late).toContain('"Loaded late" appeared.');
    });

    it("fills a form with a text field, select and checkbox", async () => {
      await call("browser_fill", {
        tab_id: tab,
        fields: [
          { ref: refFor(page, /textbox "Email"/), value: "ada@example.com" },
          { ref: refFor(page, /combobox "Plan"/), value: "Pro" },
          { ref: refFor(page, /checkbox "Accept terms"/), value: true },
        ],
      });
      const form = await call("browser_read", { tab_id: tab, query: "e" });
      expect(form).toMatch(/textbox "Email" value="ada@example.com"/);
      expect(form).toMatch(/combobox "Plan" selected="Pro"/);
      expect(form).toMatch(/checkbox "Accept terms" checked/);
    });

    it("clicks inside a same-site frame", async () => {
      expect(await call("browser_click", { tab_id: tab, ref: refFor(page, /button "Frame button"/) })).toContain("+ Frame clicked");
    });

    it("reads one region with scope", async () => {
      const dialog = await call("browser_read", { tab_id: tab, scope: "dialog" });
      expect(dialog).toContain('button "Accept cookies"');
      expect(dialog).not.toContain("# Features");
    });

    it("presses keys", async () => {
      await call("browser_fill", { tab_id: tab, fields: [{ ref: refFor(page, /textbox "Email"/), value: "x" }] });
      expect(await call("browser_key", { tab_id: tab, key: "Backspace" })).toContain("Pressed the key.");
      expect(await call("browser_read", { tab_id: tab, query: "Email" })).toMatch(/textbox "Email"(?! value)/);
    });

    it("runs JavaScript in the isolated world and in the page's own", async () => {
      const isolated = await call("browser_eval", { tab_id: tab, code: "return { items: document.querySelectorAll('#list li').length, app: typeof window.appState }" });
      expect(isolated).toContain('"items": 2');
      expect(isolated).toContain('"app": "undefined"');
      const main = await call("browser_eval", { tab_id: tab, world: "main", code: "await new Promise((r) => setTimeout(r, 50)); return window.appState" });
      expect(main).toContain('"user": "ada"');
      const changed = await call("browser_eval", { tab_id: tab, code: "document.querySelector('h1').textContent = 'Changed'; return null" });
      expect(changed).toContain("+ # Changed");
      await expect(call("browser_eval", { tab_id: tab, code: "throw new Error('boom')" })).rejects.toThrow(/boom/);
    });
  });

  it("refuses closed tabs and closes its own", async () => {
    await expect(call("browser_read", { tab_id: 999_999 })).rejects.toThrow(/closed/);
    await call("browser_close", { tab_id: tabId });
    await expect(call("browser_read", { tab_id: tabId })).rejects.toThrow(/closed/);
  });
});
