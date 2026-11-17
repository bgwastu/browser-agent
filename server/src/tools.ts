import { z } from "zod";
// Types only: the extension owns the wire protocol.
import type { ActionResult, BridgeMethod, BridgeParams, TabInfo } from "../../extension/src/shared.js";

/** An MCP tool backed by one extension method. */
export interface BrowserTool {
  name: string;
  method: BridgeMethod;
  description: string;
  shape: z.ZodRawShape;
}

const tabId = z.number().int().describe("Tab id from browser_tabs or browser_navigate");
const ref = z.string().min(1).describe("Element ref such as e12 from browser_read or an earlier action's result in this tab");
const waitFor = z
  .string()
  .min(1)
  .optional()
  .describe("Text to wait for (up to 10 s) before reporting, such as a confirmation or the next step's heading");

/** Checks a tool's shape against the params the extension takes for its method. */
function shape<M extends BridgeMethod>(_method: M, fields: z.ZodRawShape & { [K in keyof BridgeParams[M]]-?: z.ZodType<BridgeParams[M][K]> }): z.ZodRawShape {
  return fields;
}

export const BROWSER_TOOLS: readonly BrowserTool[] = [
  {
    name: "browser_tabs",
    method: "tabs",
    description: "List the open tabs of the user's browser with tab ids, titles, URLs and tab groups. Agents keep their tabs in tab groups named for their task.",
    shape: shape("tabs", {}),
  },
  {
    name: "browser_navigate",
    method: "navigate",
    description:
      "Without tab_id: open a URL in a new background tab, in the tab group named by `group`, and return its tab_id. With tab_id: load a URL in that tab, or pass back, forward or reload. Tabs a page opens (such as target=_blank links) join the same group.",
    shape: shape("navigate", {
      tab_id: tabId.optional(),
      url: z.string().min(1).describe("A URL, or back, forward or reload (with tab_id)"),
      group: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .optional()
        .describe("For a new tab: a short name for your task, such as \"Flight search\", used as the tab group's title. Pass the same name to keep related tabs together. Defaults to the agent's name."),
      wait_for: waitFor,
    }),
  },
  {
    name: "browser_read",
    method: "read",
    description:
      "Read a tab as a text outline: headings, text, and interactive elements as `[eN] role \"name\"` lines whose refs the other tools take. A ref stays with its element while the element is on the page and unchanged. Same-site frames are included. query keeps matching lines (a ref such as e12 gives that element's line); scope reads only the main region, the open dialog, or the part under a ref; offset continues a long outline. The outline covers the whole page whatever the scroll position.",
    shape: shape("read", {
      tab_id: tabId,
      query: z.string().optional().describe("Only lines containing this text (case-insensitive), or a ref"),
      scope: z.string().optional().describe('"main", "dialog" (the open modal), or a ref: read only that part'),
      offset: z.number().int().min(0).optional().describe("Character offset from a previous read's next offset"),
      max_chars: z.number().int().min(1_000).max(60_000).optional().describe("Default 15000"),
      wait_for: waitFor,
    }),
  },
  {
    name: "browser_click",
    method: "click",
    description:
      "Click an element by ref with trusted input; works while the tab is in the background. Like every action it answers with what changed in the page outline (or the new page), dialogs the page showed (accepted automatically), and tabs it opened.",
    shape: shape("click", { tab_id: tabId, ref, wait_for: waitFor }),
  },
  {
    name: "browser_fill",
    method: "fill",
    description:
      "Fill form fields by ref in one call: text fields are replaced with the value (typed with trusted input), a <select> chooses the option matching it, and a checkbox or switch takes true or false. It does not submit: click the button or press Enter with browser_key afterwards.",
    shape: shape("fill", {
      tab_id: tabId,
      fields: z
        .array(z.object({ ref, value: z.union([z.string(), z.boolean()]) }))
        .min(1)
        .describe("Fields in the order to fill them"),
      wait_for: waitFor,
    }),
  },
  {
    name: "browser_key",
    method: "key",
    description: "Press a key or combination in a tab, such as Enter, Escape, Tab, ArrowDown, PageDown, End, or Meta+A. It goes to the focused element.",
    shape: shape("key", { tab_id: tabId, key: z.string().min(1), wait_for: waitFor }),
  },
  {
    name: "browser_eval",
    method: "eval",
    description:
      "Run JavaScript in a tab. code is an async function body: use `return` for the result (JSON-serializable), and `await` freely. The default isolated world sees the DOM but not the page's own variables; world \"main\" runs as the page itself (app state, its globals, fetch with its cookies). Good for extracting data in bulk and reading app state. Events dispatched from script are untrusted and many sites ignore them, so prefer browser_click and browser_fill for interacting. Elements from browser_read carry their ref in the data-agent-ref attribute.",
    shape: shape("eval", {
      tab_id: tabId,
      code: z.string().min(1).describe("Async function body, such as: return [...document.querySelectorAll('h2')].map((h) => h.textContent)"),
      world: z.enum(["isolated", "main"]).optional().describe("Default isolated"),
      wait_for: waitFor,
    }),
  },
  {
    name: "browser_screenshot",
    method: "screenshot",
    description:
      "Take a JPEG of a tab's viewport at its CSS size, or pass ref for that element alone at the screen's full resolution, to read small print. A tab in the background may not be drawn; then use browser_read.",
    shape: shape("screenshot", { tab_id: tabId, ref: ref.optional() }),
  },
  {
    name: "browser_close",
    method: "close",
    description: "Close a tab, for example one this agent opened and no longer needs.",
    shape: shape("close", { tab_id: tabId }),
  },
];

/** What an MCP tool call answers. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export function errorResult(tool: BrowserTool, message: string): ToolResult {
  return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], isError: true };
}

/** Turns the extension's answer into what the agent sees. */
export function toolResult(tool: BrowserTool, result: unknown): ToolResult {
  const value = (result ?? {}) as Record<string, unknown>;
  if (tool.method === "screenshot" && typeof value.data === "string") {
    return { content: [{ type: "image", data: value.data, mimeType: typeof value.mime_type === "string" ? value.mime_type : "image/jpeg" }] };
  }
  return { content: [{ type: "text", text: formatResult(tool, value) }] };
}

function quote(value: unknown): string {
  return JSON.stringify(typeof value === "string" ? value : String(value));
}

function tabLine(tab: TabInfo): string {
  return `tab ${tab.tab_id}: ${tab.title === "" ? "(untitled)" : tab.title} — ${tab.url}`;
}

/** The agent reads results as text: what was done, what it changed, and any dialog or new tab. */
export function formatResult(tool: BrowserTool, result: Record<string, unknown>): string {
  switch (tool.method) {
    case "read": {
      const lines: string[] = [];
      const waited = result.wait_for as ActionResult["wait_for"];
      if (waited !== undefined && !waited.found) lines.push(`(${quote(waited.text)} did not appear within 10 s; this is the page as it is.)`, "");
      lines.push(typeof result.text === "string" ? result.text : "");
      if (typeof result.nextOffset === "number") lines.push("", `(More: call browser_read with offset ${result.nextOffset}.)`);
      return lines.join("\n");
    }
    case "tabs": {
      const tabs = Array.isArray(result.tabs) ? (result.tabs as TabInfo[]) : [];
      const lines = tabs.map((tab) => `- ${tabLine(tab)}${tab.group !== undefined ? ` [group: ${tab.group}]` : ""}${tab.active === true ? " (in front)" : ""}`);
      return lines.length > 0 ? lines.join("\n") : "The browser has no open tabs.";
    }
    case "close":
      return `Closed tab ${String(result.closed)}.`;
    case "navigate":
      if (result.opened !== undefined) {
        const waited = result.wait_for as ActionResult["wait_for"];
        const lines = [`Opened ${tabLine(result.opened as TabInfo)}, in the background.`];
        if (waited !== undefined) lines.push(waited.found ? `${quote(waited.text)} appeared.` : `${quote(waited.text)} did not appear within 10 s.`);
        return lines.join("\n");
      }
      return formatAction(tool, result as unknown as ActionResult & Record<string, unknown>);
    default:
      return formatAction(tool, result as unknown as ActionResult & Record<string, unknown>);
  }
}

function formatAction(tool: BrowserTool, result: ActionResult & Record<string, unknown>): string {
  const lines: string[] = [];
  if (tool.method === "click" && result.target !== undefined) lines.push(`Clicked ${result.target}`);
  if (tool.method === "key") lines.push("Pressed the key.");
  if (tool.method === "navigate") lines.push("Navigated.");
  if (tool.method === "eval") {
    const json = JSON.stringify(result.value, null, 2) ?? "null";
    lines.push(`Result: ${json}`);
  }
  if (result.route === "dom") lines.push("(The tab did not take trusted input, so this went through the page's DOM instead.)");
  if (typeof result.covered_by === "string") lines.push(`Note: ${result.covered_by} covers the element's center; if nothing happened, close what covers it.`);
  if (tool.method === "fill" && Array.isArray(result.fields)) {
    lines.push(`Filled ${(result.fields as Array<{ ref: string; value: string }>).map((field) => `${field.ref} = ${quote(field.value)}`).join(", ")}.`);
  }
  for (const dialog of result.dialogs ?? []) lines.push(`The page showed a ${dialog.type} dialog, accepted automatically: ${quote(dialog.message)}`);
  for (const tab of result.opened_tabs ?? []) lines.push(`It opened ${tabLine(tab)}, in the background; use its tab_id to read it.`);
  if (result.wait_for !== undefined) {
    lines.push(result.wait_for.found ? `${quote(result.wait_for.text)} appeared.` : `${quote(result.wait_for.text)} did not appear within 10 s.`);
  }
  const changes = result.changes;
  if (changes !== undefined) {
    if (changes.outline !== undefined) {
      lines.push("", "The page changed; its outline now:", changes.outline);
      if (changes.truncated === true) lines.push("(Cut short: browser_read for the rest.)");
    } else if (changes.added.length + changes.removed.length === 0) {
      if (result.opened_tabs === undefined && tool.method !== "eval") {
        lines.push("The page outline did not change. If something should have happened, it may still be loading (pass wait_for), or check with browser_screenshot.");
      }
    } else {
      lines.push("", "Changes:", ...changes.removed.map((line) => `- ${line}`), ...changes.added.map((line) => `+ ${line}`));
      if (changes.truncated === true) lines.push("(More changed: browser_read for the whole page.)");
    }
  }
  if (typeof result.url === "string" && result.url !== "") lines.push("", `Page: ${typeof result.title === "string" && result.title !== "" ? `${result.title} — ` : ""}${result.url}`);
  return lines.join("\n").trim();
}
