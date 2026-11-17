// The wire protocol between the browser-agent server and the extension.
// The server imports these types (types only) from here.

/** What each method takes. */
export interface BridgeParams {
  tabs: {};
  /** Without tab_id, opens a new background tab in the agent's group. url may also be back, forward or reload with a tab_id. */
  navigate: { tab_id?: number; url: string; wait_for?: string };
  /** `scope` is "main", "dialog" or a ref; `wait_for` waits up to 10 s for text to appear first. */
  read: { tab_id: number; query?: string; offset?: number; max_chars?: number; scope?: string; wait_for?: string };
  click: { tab_id: number; ref: string; wait_for?: string };
  /** Each field is typed into (replacing), chosen in, or ticked (true) or cleared (false). */
  fill: { tab_id: number; fields: Array<{ ref: string; value: string | boolean }>; wait_for?: string };
  key: { tab_id: number; key: string; wait_for?: string };
  /** Without `ref`, the viewport at its CSS size; with one, that element at the screen's full resolution. */
  screenshot: { tab_id: number; ref?: string };
  close: { tab_id: number };
  /** `code` is a function body: it may `await` and `return` a JSON-serializable value. */
  eval: { tab_id: number; code: string; world?: "isolated" | "main"; wait_for?: string };
}

export type BridgeMethod = keyof BridgeParams;

/** Server → extension. `agent` names the calling agent; its tabs go in a tab group with that title. */
export type BridgeRequest = { [M in BridgeMethod]: { id: string; agent: string; method: M; params: BridgeParams[M] } }[BridgeMethod];

/** Extension → server. */
export type BridgeMessage =
  | { type: "hello"; browser: string; version: string; extension: string }
  | { type: "ping" }
  | { id: string; result: unknown }
  | { id: string; error: string };

/** A JavaScript dialog (alert, confirm, prompt, beforeunload) the extension accepted. */
export interface PageDialog {
  type: string;
  message: string;
}

/** How an action changed the tab's outline, compared line by line. */
export interface PageChanges {
  added: string[];
  removed: string[];
  /** Set instead of the lists when most of the page changed: the start of its new outline. */
  outline?: string;
  /** Some lines or the outline were left out. */
  truncated?: boolean;
}

export interface TabInfo {
  tab_id: number;
  title: string;
  url: string;
  /** The title of the tab group the tab is in, if any. */
  group?: string;
  active?: boolean;
}

/** What every action answers, besides its own fields (route, value, chosen, fields…). */
export interface ActionResult {
  /** The ref's outline line before the action, so the agent sees what it acted on. */
  target?: string;
  url: string;
  title: string;
  /** Missing when the page could not be read afterwards. */
  changes?: PageChanges;
  /** Dialogs the page opened during the action; each was accepted at once. */
  dialogs?: PageDialog[];
  /** Tabs the action opened, such as a link with target=_blank. They stay in the background, in the agent's group. */
  opened_tabs?: TabInfo[];
  wait_for?: { text: string; found: boolean };
}
