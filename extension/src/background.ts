import {
  domClick,
  findRef,
  fieldKind,
  focusRef,
  locateRef,
  mainScroller,
  pageRoots,
  pointAt,
  putFiles,
  readValue,
  scrollKey,
  selectOption,
  setValue,
  shotArea,
  snapshotPage,
  type FieldKind,
  type Located,
  type ShotArea,
  type SnapshotOptions,
  type SnapshotResult,
} from "./page.js";
import { diffOutline } from "./outline.js";
import { SERVER_URL } from "./config.js";
import { SERVER_URL_KEY, type ActionResult, type BridgeMessage, type BridgeRequest, type ConnectionStatus, type PageDialog, type TabInfo, type UploadFile } from "./shared.js";

const CDP_VERSION = "1.3";
const CDP_TIMEOUT_MS = 10_000;
const EVAL_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT_MS = 4_000;
const SCREENSHOT_TIMEOUT_MS = 6_000;
const LOAD_TIMEOUT_MS = 20_000;
const WAIT_FOR_MS = 10_000;
const IDLE_DETACH_MS = 60_000;
/** A tab recording logs stays attached this long without use. */
const RECORDING_DETACH_MS = 15 * 60_000;
const LOG_LIMIT = 500;
const PING_MS = 20_000;
const RECONNECT_ALARM = "reconnect";

/** A CDP call that got no answer in time; some actions fall back to the DOM on it. */
class TimeoutError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserName(): string {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData?.brands ?? [];
  const names = brands.map((entry) => entry.brand);
  if ((navigator as Navigator & { brave?: unknown }).brave !== undefined || names.includes("Brave")) return "Brave";
  if (names.includes("Microsoft Edge")) return "Edge";
  if (names.includes("Google Chrome")) return "Chrome";
  return "Chromium";
}

// ---------------------------------------------------------------- server connection

let socket: WebSocket | null = null;
let retryMs = 1_000;
/** The URL set in the popup, else the one built in; undefined until storage was read. */
let serverUrl: string | undefined;
let status: ConnectionStatus = { state: "off" };

function send(message: BridgeMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function loadServerUrl(): Promise<string> {
  const stored = (await chrome.storage.local.get(SERVER_URL_KEY))[SERVER_URL_KEY];
  serverUrl = typeof stored === "string" && stored !== "" ? stored : SERVER_URL;
  return serverUrl;
}

function connect(): void {
  if (socket !== null) return;
  if (serverUrl === undefined) {
    void loadServerUrl().then(connect);
    return;
  }
  if (serverUrl === "") {
    status = { state: "off" };
    return;
  }
  let next: WebSocket;
  try {
    next = new WebSocket(serverUrl);
  } catch (error) {
    status = { state: "error", error: message(error) };
    return;
  }
  socket = next;
  status = { state: "connecting", error: status.error };
  next.onopen = () => {
    retryMs = 1_000;
    status = { state: "connected" };
    send({ type: "hello", browser: browserName(), version: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "", extension: chrome.runtime.getManifest().version });
  };
  next.onmessage = (event) => {
    let request: BridgeRequest;
    try {
      request = JSON.parse(String(event.data)) as BridgeRequest;
    } catch {
      return;
    }
    if (typeof request.id === "string") void handle(request);
  };
  next.onclose = (event) => {
    if (socket !== next) return;
    socket = null;
    status = { state: "error", error: status.state === "connected" ? "Disconnected; retrying." : `Could not connect (code ${event.code}); retrying.` };
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
}

/** Drops the current connection and connects to the URL now in storage. */
function reconnect(): void {
  const old = socket;
  socket = null;
  old?.close();
  retryMs = 1_000;
  serverUrl = undefined;
  connect();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SERVER_URL_KEY in changes) reconnect();
});

chrome.runtime.onMessage.addListener((request: unknown, _sender, reply) => {
  if ((request as { type?: string } | null)?.type !== "status") return;
  reply({ ...status, url: serverUrl ?? "" });
});

async function handle(request: BridgeRequest): Promise<void> {
  try {
    send({ id: request.id, result: await dispatch(request) });
  } catch (error) {
    send({ id: request.id, error: message(error) });
  }
}

// WebSocket traffic keeps the service worker alive (Chrome 116+); the alarm revives it if it was stopped anyway.
setInterval(() => send({ type: "ping" }), PING_MS);
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------- tabs and groups

const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"] as unknown as chrome.tabGroups.Color[];

/** The same agent name always gets the same color. */
function groupColor(agent: string): chrome.tabGroups.Color {
  let hash = 0;
  for (const char of agent) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length]!;
}

/** Puts a tab into the group titled with the agent's name in its window, creating the group if needed. */
async function groupTab(tabId: number, agent: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const [existing] = await chrome.tabGroups.query({ title: agent, windowId: tab.windowId });
  if (existing !== undefined) {
    if (tab.groupId !== existing.id) await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: agent, color: groupColor(agent), collapsed: false });
}

async function groupTitles(): Promise<Map<number, string>> {
  return new Map((await chrome.tabGroups.query({})).map((group) => [group.id, group.title ?? ""]));
}

function tabSummary(tab: chrome.tabs.Tab, groups: Map<number, string>): TabInfo {
  const group = tab.groupId !== undefined && tab.groupId !== -1 ? groups.get(tab.groupId) : undefined;
  return {
    tab_id: tab.id ?? -1,
    title: tab.title ?? "",
    url: tab.url || tab.pendingUrl || "",
    ...(group !== undefined ? { group } : {}),
    active: tab.active,
  };
}

async function existingTab(tabId: unknown): Promise<number> {
  if (typeof tabId !== "number") throw new Error("tab_id must be a number from browser_tabs or browser_navigate.");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab === null) throw new Error(`Tab ${tabId} is closed. browser_tabs lists the open tabs.`);
  return tabId;
}

// ---------------------------------------------------------------- debugger

/** Tabs the debugger is attached to, with when they were last used. */
const attached = new Map<number, number>();

/** The main frame's isolated world per tab, so evaluate does not create one on every call. */
interface World {
  frameId: string;
  contextId: number;
}
const worlds = new Map<number, World>();
/** Dialogs each tab opened (and the extension accepted) since its current action started. */
const dialogLog = new Map<number, PageDialog[]>();
/** The next ref number per tab, so a new document in the tab does not hand out an earlier page's refs again. */
const refCounters = new Map<number, number>();
/** Per tab, each ref's last outline line without the ref, to find its element again after a re-render. */
const refLines = new Map<number, Map<string, string>>();

interface ConsoleEntry {
  level: string;
  text: string;
  source?: string;
}
interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  mime?: string;
  size?: number;
  error?: string;
  /** The request's headers and body, for request_id. */
  headers?: Record<string, string>;
  post?: string;
  responseHeaders?: Record<string, string>;
}
/** Tabs recording logs (since the first browser_logs call), with what they recorded. */
const consoleLog = new Map<number, ConsoleEntry[]>();
const networkLog = new Map<number, Map<string, NetworkEntry>>();

function capped<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
}

function remoteText(value: { value?: unknown; description?: string; type?: string; unserializableValue?: string }): string {
  if (value.value !== undefined) return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  return value.description ?? value.unserializableValue ?? value.type ?? "";
}

/** Records console and network events of tabs that are recording. */
function recordEvent(tabId: number, method: string, params: Record<string, unknown>): void {
  const logs = consoleLog.get(tabId);
  const requests = networkLog.get(tabId);
  if (logs === undefined || requests === undefined) return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const args = (params.args as Array<Parameters<typeof remoteText>[0]>) ?? [];
      const frame = (params.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number }> } | undefined)?.callFrames?.[0];
      capped(logs, {
        level: String(params.type ?? "log"),
        text: args.map(remoteText).join(" ").slice(0, 4_000),
        ...(frame?.url ? { source: `${frame.url}:${frame.lineNumber + 1}` } : {}),
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = (params.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number };
      capped(logs, {
        level: "exception",
        text: (details.exception?.description ?? details.text ?? "").slice(0, 4_000),
        ...(details.url ? { source: `${details.url}:${(details.lineNumber ?? 0) + 1}` } : {}),
      });
      break;
    }
    case "Log.entryAdded": {
      const entry = (params.entry ?? {}) as { level?: string; text?: string; url?: string; source?: string };
      if (entry.source === "console-api") break;
      capped(logs, { level: entry.level ?? "log", text: `${entry.text ?? ""}`.slice(0, 4_000), ...(entry.url ? { source: entry.url } : {}) });
      break;
    }
    case "Network.requestWillBeSent": {
      const request = (params.request ?? {}) as { method?: string; url?: string; headers?: Record<string, string>; postData?: string };
      const id = String(params.requestId);
      requests.set(id, {
        id,
        method: request.method ?? "GET",
        url: request.url ?? "",
        type: String(params.type ?? "Other"),
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.postData ? { post: request.postData.slice(0, 20_000) } : {}),
      });
      if (requests.size > LOG_LIMIT) requests.delete(requests.keys().next().value as string);
      break;
    }
    case "Network.responseReceived": {
      const entry = requests.get(String(params.requestId));
      const response = (params.response ?? {}) as { status?: number; mimeType?: string; headers?: Record<string, string> };
      if (entry !== undefined) {
        entry.status = response.status;
        entry.mime = response.mimeType;
        if (response.headers) entry.responseHeaders = response.headers;
      }
      break;
    }
    case "Network.loadingFinished": {
      const entry = requests.get(String(params.requestId));
      if (entry !== undefined) entry.size = Number(params.encodedDataLength ?? 0);
      break;
    }
    case "Network.loadingFailed": {
      const entry = requests.get(String(params.requestId));
      if (entry !== undefined) entry.error = String(params.errorText ?? "failed");
      break;
    }
  }
}

/** Turns on the event domains that feed the logs. */
async function startRecording(tabId: number): Promise<void> {
  await cdp(tabId, "Runtime.enable").catch(() => undefined);
  await cdp(tabId, "Log.enable").catch(() => undefined);
  await cdp(tabId, "Network.enable", { maxPostDataSize: 20_000 }).catch(() => undefined);
}

function forget(tabId: number): void {
  attached.delete(tabId);
  worlds.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forget(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  if (method === "Input.dragIntercepted") {
    dragWaiters.get(tabId)?.((params as { data?: unknown } | undefined)?.data ?? null);
    return;
  }
  if (method !== "Page.javascriptDialogOpening") {
    recordEvent(tabId, method, (params ?? {}) as Record<string, unknown>);
    return;
  }
  // Every dialog is accepted at once (a prompt with its default answer) and reported in the action's result.
  const event = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
  const log = dialogLog.get(tabId) ?? [];
  log.push({ type: event.type ?? "alert", message: event.message ?? "" });
  dialogLog.set(tabId, log);
  void chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true, promptText: event.defaultPrompt ?? "" }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
  refCounters.delete(tabId);
  refLines.delete(tabId);
  dialogLog.delete(tabId);
  consoleLog.delete(tabId);
  networkLog.delete(tabId);
});

// A new document replaces the page's isolated world. A call that raced the load recovers in run().
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") worlds.delete(tabId);
});

// Detach from idle tabs, so the browser's debugging bar goes away when agents stop.
setInterval(() => {
  const now = Date.now();
  for (const [tabId, used] of attached) {
    if (now - used > (consoleLog.has(tabId) ? RECORDING_DETACH_MS : IDLE_DETACH_MS)) {
      forget(tabId);
      void chrome.debugger.detach({ tabId }).catch(() => undefined);
    }
  }
}, 15_000);

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    attached.set(tabId, Date.now());
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (error) {
    if (!/already attached/i.test(message(error))) throw new Error(`Cannot control this tab: ${message(error)}`);
    // Our own attachment from before a service worker restart: carry on with it.
  }
  attached.set(tabId, Date.now());
  // Page events report dialogs.
  await cdp(tabId, "Page.enable").catch(() => undefined);
  // A background tab should behave like a focused, running one.
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  await cdp(tabId, "Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
  if (consoleLog.has(tabId)) await startRecording(tabId);
}

function cdp<T = Record<string, unknown>>(tabId: number, method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_TIMEOUT_MS): Promise<T> {
  if (attached.has(tabId)) attached.set(tabId, Date.now());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`The tab did not answer ${method} within ${timeoutMs / 1000} s.`)), timeoutMs);
    (chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function worldOf(tabId: number): Promise<World> {
  const cached = worlds.get(tabId);
  if (cached !== undefined) return cached;
  const tree = await cdp<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
  const frameId = tree.frameTree.frame.id;
  const world = await cdp<{ executionContextId: number }>(tabId, "Page.createIsolatedWorld", { frameId, worldName: "browser-agent" });
  const entry = { frameId, contextId: world.executionContextId };
  worlds.set(tabId, entry);
  return entry;
}

/** Evaluates an expression in the tab's isolated world (or the page's own, `main`), returning its value. */
async function evaluateExpression(tabId: number, expression: string, main = false, timeoutMs = CDP_TIMEOUT_MS): Promise<unknown> {
  await attach(tabId);
  const once = async (): Promise<unknown> => {
    const response = await cdp<{
      result: { value?: unknown; type?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      tabId,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, ...(main ? {} : { contextId: (await worldOf(tabId)).contextId }) },
      timeoutMs,
    );
    if (response.exceptionDetails !== undefined) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  };
  try {
    return await once();
  } catch (error) {
    // The context was destroyed by a navigation the cache has not seen yet: make a fresh world and try once more.
    if (main || !/Cannot find context|context with specified id/i.test(message(error))) throw error;
    worlds.delete(tabId);
    return once();
  }
}

/** Runs one of page.ts's functions in the tab; `pageRoots` and `findRef` are defined ahead of it. */
async function evaluate<T>(tabId: number, fn: (...args: never[]) => unknown, arg?: unknown): Promise<T> {
  const expression = `(() => {
    const pageRoots = ${pageRoots.toString()};
    const findRef = ${findRef.toString()};
    const mainScroller = ${mainScroller.toString()};
    return (${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)});
  })()`;
  return (await evaluateExpression(tabId, expression)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoad(tabId: number, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab === null || tab.status === "complete") return;
    await sleep(200);
  }
}

/** The page outline; refs continue from the tab's earlier pages. */
async function snapshot(tabId: number, options: Partial<SnapshotOptions> = {}): Promise<SnapshotResult> {
  const full: SnapshotOptions = { query: null, offset: 0, maxChars: 15_000, scope: null, interactive: false, start: refCounters.get(tabId) ?? 1, ...options, lines: true };
  const result = await evaluate<SnapshotResult>(tabId, snapshotPage, full);
  refCounters.set(tabId, Math.max(refCounters.get(tabId) ?? 1, result.next));
  const known = refLines.get(tabId) ?? new Map<string, string>();
  for (const line of result.lines ?? []) {
    const match = /^\[(e\d+)\] (.*)$/.exec(line);
    if (match !== null) known.set(match[1]!, identity(match[2]!));
  }
  if (known.size > 5_000) for (const key of [...known.keys()].slice(0, known.size - 5_000)) known.delete(key);
  refLines.set(tabId, known);
  if (options.lines !== true) delete result.lines;
  return result;
}

/** A ref line's role and name, without its state: `button "Save"`. */
function identity(rest: string): string {
  return /^\S+ "(?:[^"\\]|\\.)*"(?: hint="(?:[^"\\]|\\.)*")?/.exec(rest)?.[0] ?? rest;
}

/** The outline's lines, or null when the page cannot be read. */
async function outlineLines(tabId: number): Promise<string[] | null> {
  try {
    return (await snapshot(tabId, { lines: true, maxChars: 1 })).lines ?? [];
  } catch {
    return null;
  }
}

/** Waits up to WAIT_FOR_MS for text to appear in the tab's outline. */
async function waitForText(tabId: number, text: string): Promise<{ text: string; found: boolean }> {
  const wanted = text.trim().toLowerCase();
  const deadline = Date.now() + WAIT_FOR_MS;
  for (;;) {
    const lines = await outlineLines(tabId);
    if (lines?.some((line) => line.toLowerCase().includes(wanted)) === true) return { text, found: true };
    if (Date.now() >= deadline) return { text, found: false };
    await sleep(300);
    await waitForLoad(tabId);
  }
}

function waitForParam(params: { wait_for?: string }): string | null {
  const value = params.wait_for;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------------------------------------------------------------- actions

/** What an action needs from before it ran. */
interface ActionStart {
  before: string[] | null;
  targets: string[];
  /** The refs to act on: the ones asked for, or the element's new ref when it was re-rendered. */
  refs: string[];
  /** Refs that were replaced: "e12 → e40". */
  remapped: string[];
  url: string;
  /** The tab in front in the window, to bring back if the action opens one over it. */
  front: number | undefined;
}

function samePage(a: string, b: string): boolean {
  return a.split("#")[0] === b.split("#")[0];
}

function staleRef(ref: string): Error {
  return new Error(`Ref ${ref} is not on the page now: the element is gone, hidden, or changed. Call browser_read again and use a ref from it.`);
}

/** Reads the page before an action; each ref must be on it now. */
async function startAction(tabId: number, refs: string[]): Promise<ActionStart> {
  try {
    await attach(tabId);
  } catch (error) {
    // Navigating away from a page the extension cannot control still works.
    if (refs.length > 0) throw error;
  }
  await waitForLoad(tabId);
  const before = refs.length > 0 ? ((await snapshot(tabId, { lines: true, maxChars: 1 })).lines ?? []) : await outlineLines(tabId);
  const remapped: string[] = [];
  const resolved: string[] = [];
  const targets = refs.map((ref) => {
    let line = before?.find((entry) => entry.startsWith(`[${ref}] `));
    if (line === undefined) {
      // The page re-rendered the element: take the one element with the same role and name, if there is exactly one.
      const was = refLines.get(tabId)?.get(ref);
      const matches = was === undefined ? [] : (before ?? []).filter((entry) => /^\[e\d+\] /.test(entry) && identity(entry.slice(entry.indexOf("] ") + 2)) === was);
      if (matches.length !== 1) throw staleRef(ref);
      line = matches[0]!;
      const now = line.slice(1, line.indexOf("]"));
      remapped.push(`${ref} → ${now}`);
      resolved.push(now);
    } else {
      resolved.push(ref);
    }
    return line;
  });
  const tab = await chrome.tabs.get(tabId);
  const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  return { before, targets, refs: resolved, remapped, url: tab.url ?? "", front: front?.id };
}

/** Keeps tabs an action opened in the background, in the acting tab's group (else the agent's), and says what they hold. */
async function placeOpenedTabs(tabId: number, opened: number[], start: ActionStart, agent: string): Promise<TabInfo[]> {
  const source = await chrome.tabs.get(tabId).catch(() => null);
  const sourceGroup = source !== null && source.groupId !== -1 ? await chrome.tabGroups.get(source.groupId).catch(() => null) : null;
  const group = sourceGroup?.title || agent;
  const tabs: TabInfo[] = [];
  for (const id of opened) {
    await waitForLoad(id, 5_000);
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab === null) continue;
    if (tab.active && start.front !== undefined && start.front !== id && start.front !== tabId) {
      await chrome.tabs.update(start.front, { active: true }).catch(() => undefined);
    }
    await groupTab(id, group).catch(() => undefined);
    tabs.push({ tab_id: id, title: tab.title ?? "", url: tab.url || tab.pendingUrl || "", group });
  }
  return tabs;
}

/** Runs an action and reports what it did to the page: the outline's changes, dialogs it opened, tabs it opened. */
async function act(
  tabId: number,
  agent: string,
  refs: string[],
  params: { wait_for?: string },
  work: (start: ActionStart) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const start = await startAction(tabId, refs);
  const opened: number[] = [];
  const onCreated = (tab: chrome.tabs.Tab): void => {
    // A link opened from a background tab names the window's front tab as its opener.
    if (tab.id !== undefined && (tab.openerTabId === tabId || (tab.openerTabId !== undefined && tab.openerTabId === start.front))) opened.push(tab.id);
  };
  chrome.tabs.onCreated.addListener(onCreated);
  dialogLog.set(tabId, []);
  let own: Record<string, unknown>;
  let outcome: Partial<ActionResult>;
  try {
    own = await work(start);
    await sleep(350);
    await waitForLoad(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const waitFor = waitForParam(params);
    const waited = waitFor !== null ? await waitForText(tabId, waitFor) : undefined;
    const after = await outlineLines(tabId);
    const url = tab?.url ?? "";
    outcome = {
      url,
      title: tab?.title ?? "",
      ...(after !== null ? { changes: diffOutline(start.before, after, !samePage(start.url, url)) } : {}),
      ...(waited !== undefined ? { wait_for: waited } : {}),
    };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  const dialogs = dialogLog.get(tabId) ?? [];
  const openedTabs = opened.length > 0 ? await placeOpenedTabs(tabId, opened, start, agent) : [];
  return {
    ...(start.targets.length === 1 ? { target: start.targets[0] } : {}),
    ...(start.remapped.length > 0 ? { remapped: start.remapped } : {}),
    ...own,
    ...outcome,
    ...(dialogs.length > 0 ? { dialogs } : {}),
    ...(openedTabs.length > 0 ? { opened_tabs: openedTabs } : {}),
  };
}

/** Where a ref is, for a pointer action; it must take space on the page. */
async function located(tabId: number, ref: string, scroll = true): Promise<Located> {
  const spot = await evaluate<Located>(tabId, locateRef, { ref, scroll });
  if (!spot.found) throw staleRef(ref);
  if (!spot.visible) {
    throw new Error(`Ref ${ref} takes no space on the page, so it cannot be clicked. Open what shows it (a menu, a tab, a section) and read again.`);
  }
  return spot;
}

// ---------------------------------------------------------------- keys

const KEYS: Record<string, { code: string; keyCode: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};
/** The named keys by lower-case name, so "arrowdown" and "ArrowDown" both work. */
const NAMED_KEYS = new Map(Object.entries(KEYS).map(([name, spec]) => [name.toLowerCase(), spec] as const));
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

async function pressKey(tabId: number, combo: string): Promise<void> {
  const parts = combo.split("+").map((part) => part.trim()).filter((part) => part !== "");
  const keyName = parts.pop();
  if (keyName === undefined) throw new Error("key is empty.");
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier ${part}. Use ctrl, alt, shift or meta.`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS.get(keyName.toLowerCase());
  let event: { key: string; code: string; windowsVirtualKeyCode: number; text?: string };
  if (named !== undefined) {
    event = { key: named.key ?? named.code, code: named.code, windowsVirtualKeyCode: named.keyCode, ...(named.text ? { text: named.text } : {}) };
  } else if ([...keyName].length === 1) {
    const upper = keyName.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(keyName);
    event = {
      key: keyName,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${keyName}` : "",
      windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      ...(modifiers & (2 | 4) ? {} : { text: keyName }),
    };
  } else {
    throw new Error(`Unknown key ${keyName}. Use a single character or one of ${Object.keys(KEYS).join(", ")}.`);
  }
  if (modifiers === 0 && (await evaluate<boolean>(tabId, scrollKey, event.key))) return;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", modifiers, ...event }, INPUT_TIMEOUT_MS);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...event }, INPUT_TIMEOUT_MS);
}

// ---------------------------------------------------------------- input

type Point = { x: number; y: number };

function modifierBits(value: string | undefined): number {
  let bits = 0;
  for (const part of (value ?? "").split("+").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "")) {
    const bit = MODIFIERS[part];
    if (bit === undefined) throw new Error(`Unknown modifier ${part}. Use ctrl, alt, shift or meta, joined with +.`);
    bits |= bit;
  }
  return bits;
}

function mouse(tabId: number, type: string, point: Point, extra: Record<string, unknown> = {}): Promise<unknown> {
  return cdp(tabId, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra }, INPUT_TIMEOUT_MS);
}

/** A trusted click (or double or triple click) at a viewport point. */
async function clickPoint(tabId: number, point: Point, button: string, count: number, modifiers: number): Promise<void> {
  await mouse(tabId, "mouseMoved", point, { modifiers });
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await mouse(tabId, "mousePressed", point, { button, clickCount, modifiers });
    await mouse(tabId, "mouseReleased", point, { button, clickCount, modifiers });
  }
}

/** Waiters for Input.dragIntercepted, per tab. */
const dragWaiters = new Map<number, (data: unknown) => void>();

/** Presses at one point, moves to another and releases. HTML drag and drop is caught and replayed as drag events. */
async function dragPoints(tabId: number, from: Point, to: Point, modifiers: number): Promise<void> {
  await cdp(tabId, "Input.setInterceptDrags", { enabled: true }).catch(() => undefined);
  let dragData: unknown = null;
  dragWaiters.set(tabId, (data) => {
    dragData = data;
  });
  try {
    await mouse(tabId, "mouseMoved", from, { modifiers });
    await mouse(tabId, "mousePressed", from, { button: "left", clickCount: 1, modifiers });
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
      await mouse(tabId, "mouseMoved", point, { button: "left", buttons: 1, modifiers });
      if (dragData !== null) break;
      await sleep(16);
    }
    if (dragData !== null) {
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await cdp(tabId, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: dragData, modifiers }, INPUT_TIMEOUT_MS);
      }
    }
    await mouse(tabId, "mouseReleased", to, { button: "left", clickCount: 1, modifiers });
  } finally {
    dragWaiters.delete(tabId);
    await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
  }
}

async function clickRef(tabId: number, ref: string): Promise<Record<string, unknown>> {
  const spot = await located(tabId, ref);
  let route = "trusted";
  try {
    const point = { x: spot.x, y: spot.y };
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, INPUT_TIMEOUT_MS);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, INPUT_TIMEOUT_MS);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, INPUT_TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    route = "dom";
    if (!(await evaluate<boolean>(tabId, domClick, ref))) throw staleRef(ref);
  }
  return { route, ...(spot.covered !== null ? { covered_by: spot.covered } : {}) };
}

async function typeInto(tabId: number, ref: string, text: string): Promise<{ route: string; value: string }> {
  const focused = await evaluate<{ found: boolean; editable: boolean }>(tabId, focusRef, { ref, replace: true });
  if (!focused.found) throw staleRef(ref);
  if (!focused.editable) throw new Error(`Ref ${ref} is not a text field. Click it or pick another ref.`);
  const before = await evaluate<{ value: string }>(tabId, readValue, ref);
  let route = "trusted";
  try {
    if (text !== "") await cdp(tabId, "Input.insertText", { text }, INPUT_TIMEOUT_MS);
    else await pressKey(tabId, "Backspace");
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    route = "dom";
  }
  let after = await evaluate<{ value: string }>(tabId, readValue, ref);
  if (route === "trusted" && text !== "" && after.value === before.value) route = "dom";
  if (route === "dom") {
    await evaluate<boolean>(tabId, setValue, { ref, text, replace: true });
    after = await evaluate<{ value: string }>(tabId, readValue, ref);
  }
  return { route, value: after.value.slice(0, 500) };
}

async function chooseOption(tabId: number, ref: string, option: string): Promise<string> {
  const result = await evaluate<{ found: boolean; chosen: string | null; options: string[] }>(tabId, selectOption, { ref, option });
  if (!result.found) throw staleRef(ref);
  if (result.chosen === null) {
    throw new Error(
      result.options.length > 0
        ? `No option of ${ref} matches ${JSON.stringify(option)}. Options: ${result.options.slice(0, 40).join(" | ")}`
        : `Ref ${ref} is not a <select>. For a custom dropdown, click it and then click the option.`,
    );
  }
  return result.chosen;
}

/** Fills one field the way its kind takes a value. */
async function fillField(tabId: number, ref: string, value: unknown): Promise<string> {
  const field = await evaluate<FieldKind>(tabId, fieldKind, ref);
  if (!field.found) throw staleRef(ref);
  if (field.kind === "check") {
    const wanted = value === true || value === "true" || value === "on";
    if (!wanted && value !== false && value !== "false" && value !== "off") throw new Error(`Ref ${ref} is a checkbox or switch: pass true or false.`);
    if (field.checked !== wanted) await clickRef(tabId, ref);
    return wanted ? "checked" : "unchecked";
  }
  if (typeof value !== "string") throw new Error(`Ref ${ref} takes text: pass a string.`);
  if (field.kind === "select") return chooseOption(tabId, ref, value);
  if (field.kind === "text") return (await typeInto(tabId, ref, value)).value;
  throw new Error(`Ref ${ref} is not a form field${field.kind === "file" ? " you can fill (it is a file input)" : ""}. Click it with browser_click instead.`);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** A file's name, type and base64 content, from a URL or from data. */
async function fileContent(file: UploadFile): Promise<{ name: string; type: string; data: string }> {
  if (typeof file.url === "string" && file.url !== "") {
    const response = await fetch(file.url).catch((error: unknown) => {
      throw new Error(`Could not download ${file.url}: ${message(error)}`);
    });
    if (!response.ok) throw new Error(`Fetching ${file.url} answered ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const fromUrl = decodeURIComponent(new URL(response.url || file.url).pathname.split("/").pop() ?? "") || "file";
    return { name: file.name || fromUrl, type: file.mime_type || response.headers.get("content-type")?.split(";")[0] || "", data: base64Of(bytes) };
  }
  if (typeof file.data === "string" && file.data !== "") {
    return { name: file.name || "file", type: file.mime_type || "", data: file.data.replace(/^data:[^,]*,/, "") };
  }
  throw new Error("Each file needs a path, url or data.");
}

/** Gives a file input files by their paths on the browser's computer, as if picked in the file dialog. */
async function setFilePaths(tabId: number, ref: string, paths: string[]): Promise<void> {
  const response = await cdp<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
    expression: `(() => { const findRef = ${findRef.toString()}; const pageRoots = ${pageRoots.toString()}; return findRef(${JSON.stringify(ref)}); })()`,
    contextId: (await worldOf(tabId)).contextId,
  });
  const objectId = response.result.objectId;
  if (objectId === undefined) throw staleRef(ref);
  await cdp(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
}

async function upload(tabId: number, ref: string, files: UploadFile[]): Promise<Record<string, unknown>> {
  const field = await evaluate<FieldKind>(tabId, fieldKind, ref);
  if (!field.found) throw staleRef(ref);
  const paths = files.filter((file) => typeof file.path === "string" && file.path !== "");
  if (paths.length > 0) {
    if (paths.length !== files.length) throw new Error("Pass every file by path, or none: paths and url/data cannot be mixed.");
    if (field.kind !== "file") throw new Error(`Ref ${ref} is not a file input: paths only go to a file input. Pass url or data to drop files on it instead.`);
    await setFilePaths(tabId, ref, paths.map((file) => file.path!));
    return { files: paths.map((file) => file.path!.split(/[\\/]/).pop()), dropped: false };
  }
  const contents = await Promise.all(files.map(fileContent));
  const result = await evaluate<{ found: boolean; input: boolean; names: string[] }>(tabId, putFiles, { ref, files: contents });
  if (!result.found) throw staleRef(ref);
  return { files: result.names, dropped: !result.input };
}

/** The longest edge a screenshot gets: models scale larger pictures down to about this anyway. */
const SCREENSHOT_MAX_EDGE = 1_568;

/** The viewport comes at its CSS size; a ref's box at the screen's full resolution, for small print. */
function screenshotClip(area: ShotArea, full: boolean): Record<string, number> {
  const { devicePixelRatio, x, y, width, height } = area;
  const scale = Math.min(full ? 1 : 1 / devicePixelRatio, SCREENSHOT_MAX_EDGE / (Math.max(width, height) * devicePixelRatio));
  return { x, y, width, height, scale };
}

function scopeParam(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (value === "main" || value === "dialog" || /^e\d+$/.test(value))) return value;
  throw new Error('scope must be "main", "dialog", or a ref such as e12.');
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string.`);
  return value;
}

/** Opens a background tab in the agent's group, in the last focused window (or a new one). */
async function openTab(url: string, agent: string): Promise<number> {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  let tabId: number | undefined;
  if (window?.id !== undefined) {
    tabId = (await chrome.tabs.create({ url, active: false, windowId: window.id })).id;
  } else {
    tabId = (await chrome.windows.create({ url, focused: false }))?.tabs?.[0]?.id;
  }
  if (tabId === undefined) throw new Error("The browser did not create a tab.");
  await groupTab(tabId, agent).catch(() => undefined);
  return tabId;
}

// ---------------------------------------------------------------- methods

async function dispatch(request: BridgeRequest): Promise<unknown> {
  const { agent } = request;
  switch (request.method) {
    case "tabs": {
      const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowType: "normal" }), groupTitles()]);
      return { tabs: tabs.map((tab) => tabSummary(tab, groups)) };
    }
    case "navigate": {
      const { params } = request;
      const target = required(params.url, "url");
      const history = target === "back" || target === "forward" || target === "reload";
      if (params.tab_id === undefined) {
        if (history) throw new Error(`${target} needs a tab_id.`);
        const tabId = await openTab(target, params.group?.trim() || agent);
        await waitForLoad(tabId);
        const waitFor = waitForParam(params);
        const waited = waitFor !== null ? await waitForText(tabId, waitFor) : undefined;
        const tab = tabSummary(await chrome.tabs.get(tabId), await groupTitles());
        return { opened: tab, ...(waited !== undefined ? { wait_for: waited } : {}) };
      }
      const tabId = await existingTab(params.tab_id);
      return act(tabId, agent, [], params, async () => {
        if (target === "back" || target === "forward") {
          await (target === "back" ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId)).catch(() => {
            throw new Error(`There is no page to go ${target} to.`);
          });
        } else if (target === "reload") {
          await chrome.tabs.reload(tabId);
        } else {
          await chrome.tabs.update(tabId, { url: target });
        }
        return {};
      });
    }
    case "read": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const options = {
        query: typeof params.query === "string" && params.query !== "" ? params.query : null,
        offset: typeof params.offset === "number" ? params.offset : 0,
        maxChars: typeof params.max_chars === "number" ? Math.min(Math.max(params.max_chars, 1_000), 60_000) : 15_000,
        scope: scopeParam(params.scope),
        interactive: params.interactive === true,
      };
      await waitForLoad(tabId);
      const waitFor = waitForParam(params);
      const waited = waitFor !== null ? await waitForText(tabId, waitFor) : undefined;
      let result = await snapshot(tabId, options);
      if (result.empty && waited === undefined) {
        // A page that is still drawing: give it a moment before saying it is empty.
        await sleep(1_000);
        await waitForLoad(tabId);
        result = await snapshot(tabId, options);
      }
      return { ...result, ...(waited !== undefined ? { wait_for: waited } : {}) };
    }
    case "click": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const ref = typeof params.ref === "string" && params.ref !== "" ? params.ref : null;
      const point = typeof params.x === "number" && typeof params.y === "number" ? { x: params.x, y: params.y } : null;
      if ((ref === null) === (point === null)) throw new Error("Pass a ref, or x and y (viewport CSS pixels, as in a browser_screenshot), not both.");
      const button = params.button ?? "left";
      if (!["left", "right", "middle"].includes(button)) throw new Error("button must be left, right or middle.");
      const count = params.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error("count must be 1, 2 or 3.");
      const modifiers = modifierBits(params.modifiers);
      const dragTo = params.drag_to;
      const plain = button === "left" && count === 1 && modifiers === 0 && params.hover !== true && dragTo === undefined;
      return act(tabId, agent, ref === null ? [] : [ref], params, async (start) => {
        const actual = start.refs[0];
        // A plain click on a ref keeps its DOM fallback for tabs that take no trusted input.
        if (actual !== undefined && plain) return clickRef(tabId, actual);
        let from: Point;
        let covered: string | null = null;
        let target: string | null = null;
        if (actual !== undefined) {
          const spot = await located(tabId, actual);
          from = { x: spot.x, y: spot.y };
          covered = spot.covered;
        } else {
          from = point!;
          target = await evaluate<string | null>(tabId, pointAt, from);
        }
        const done: Record<string, unknown> = {
          ...(target !== null ? { target: `point (${from.x}, ${from.y}): ${target}` } : {}),
          ...(covered !== null ? { covered_by: covered } : {}),
        };
        if (params.hover === true) {
          await mouse(tabId, "mouseMoved", from, { modifiers });
          return { ...done, did: "hovered" };
        }
        if (dragTo !== undefined) {
          let to: Point;
          if (typeof dragTo === "string") {
            const spot = await located(tabId, dragTo, false);
            to = { x: spot.x, y: spot.y };
            // Re-measure the start, in case finding the target scrolled the page.
            if (actual !== undefined) {
              const again = await located(tabId, actual, false);
              from = { x: again.x, y: again.y };
            }
          } else if (typeof dragTo?.x === "number" && typeof dragTo?.y === "number") {
            to = { x: dragTo.x, y: dragTo.y };
          } else {
            throw new Error("drag_to must be a ref or {x, y}.");
          }
          await dragPoints(tabId, from, to, modifiers);
          return { ...done, did: "dragged", to: typeof dragTo === "string" ? dragTo : `(${to.x}, ${to.y})` };
        }
        await clickPoint(tabId, from, button, count, modifiers);
        const kind = count === 2 ? "double-clicked" : count === 3 ? "triple-clicked" : "clicked";
        return { ...done, did: button === "left" ? kind : `${button}-${kind}` };
      });
    }
    case "upload": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const ref = required(params.ref, "ref");
      if (!Array.isArray(params.files) || params.files.length === 0) throw new Error("files must list one or more files.");
      return act(tabId, agent, [ref], params, (start) => upload(tabId, start.refs[0]!, params.files));
    }
    case "logs": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      await attach(tabId);
      if (!consoleLog.has(tabId)) {
        consoleLog.set(tabId, []);
        networkLog.set(tabId, new Map());
        await startRecording(tabId);
        return { started: true };
      }
      const requests = networkLog.get(tabId)!;
      if (typeof params.request_id === "string" && params.request_id !== "") {
        const entry = requests.get(params.request_id);
        if (entry === undefined) throw new Error(`No recorded request ${params.request_id}. It may be older than the last ${LOG_LIMIT} requests.`);
        let body: string | undefined;
        let bodyError: string | undefined;
        try {
          const response = await cdp<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", { requestId: entry.id });
          body = response.base64Encoded ? `(binary, ${Math.round((response.body.length * 3) / 4)} bytes)` : response.body;
        } catch (error) {
          bodyError = message(error);
        }
        return {
          request: entry,
          ...(body !== undefined ? { body: body.slice(0, 50_000), body_truncated: body.length > 50_000 } : { body_error: bodyError }),
        };
      }
      const query = params.query?.trim().toLowerCase() ?? "";
      const limit = Math.min(Math.max(params.limit ?? 50, 1), LOG_LIMIT);
      const kind = params.kind ?? "console";
      let entries: unknown[];
      if (kind === "network") {
        const all = [...requests.values()].filter((entry) => query === "" || `${entry.method} ${entry.url} ${entry.status ?? ""} ${entry.type}`.toLowerCase().includes(query));
        entries = all.slice(-limit).map(({ headers: _h, post: _p, responseHeaders: _r, ...rest }) => rest);
        if (params.clear === true) requests.clear();
        return { kind, total: all.length, entries };
      }
      const logs = consoleLog.get(tabId)!;
      const all = logs.filter((entry) => query === "" || `${entry.level} ${entry.text}`.toLowerCase().includes(query));
      entries = all.slice(-limit);
      if (params.clear === true) logs.length = 0;
      return { kind, total: all.length, entries };
    }
    case "fill": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const fields: unknown = params.fields;
      if (
        !Array.isArray(fields) ||
        fields.length === 0 ||
        !fields.every((field) => typeof field?.ref === "string" && field.ref !== "" && (typeof field.value === "string" || typeof field.value === "boolean"))
      ) {
        throw new Error("fields must list one or more {ref, value} entries; value is text, or true or false for a checkbox.");
      }
      const entries = fields as Array<{ ref: string; value: string | boolean }>;
      return act(
        tabId,
        agent,
        entries.map((field) => field.ref),
        params,
        async () => {
          const filled: Array<{ ref: string; value: string }> = [];
          for (const field of entries) {
            try {
              filled.push({ ref: field.ref, value: await fillField(tabId, field.ref, field.value) });
            } catch (error) {
              if (filled.length === 0) throw error;
              throw new Error(`Filled ${filled.map((entry) => entry.ref).join(", ")}; then ${field.ref} failed: ${message(error)}`);
            }
          }
          return { fields: filled };
        },
      );
    }
    case "key": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const key = required(params.key, "key");
      return act(tabId, agent, [], params, async () => {
        await pressKey(tabId, key);
        return {};
      });
    }
    case "eval": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      const code = required(params.code, "code");
      const main = params.world === "main";
      return act(tabId, agent, [], params, async () => {
        const value = await evaluateExpression(tabId, `(async () => {\n${code}\n})()`, main, EVAL_TIMEOUT_MS);
        return { value: value === undefined ? null : value };
      });
    }
    case "screenshot": {
      const { params } = request;
      const tabId = await existingTab(params.tab_id);
      await attach(tabId);
      const ref = typeof params.ref === "string" && params.ref !== "" ? params.ref : null;
      const area = await evaluate<ShotArea>(tabId, shotArea, ref);
      if (!area.found && ref !== null) throw staleRef(ref);
      if (area.width <= 0 || area.height <= 0) {
        throw new Error(
          ref === null
            ? "The tab's viewport has no size, so there is no picture. Read it with browser_read instead."
            : `Ref ${ref} takes no space on the page, so there is nothing to show.`,
        );
      }
      try {
        const shot = await cdp<{ data: string }>(
          tabId,
          "Page.captureScreenshot",
          { format: "jpeg", quality: 80, captureBeyondViewport: false, clip: screenshotClip(area, ref !== null) },
          SCREENSHOT_TIMEOUT_MS,
        );
        return { data: shot.data, mime_type: "image/jpeg" };
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new Error("The browser is not drawing this tab because it is in the background, so there is no picture. Read it with browser_read instead.");
        }
        throw error;
      }
    }
    case "close": {
      const tabId = await existingTab(request.params.tab_id);
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }
    default: {
      const unhandled: never = request;
      throw new Error(`Unknown method ${String((unhandled as { method: unknown }).method)}.`);
    }
  }
}
