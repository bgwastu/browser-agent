// The wire protocol between the browser-agent server and the extension.
// The server imports these types (types only) from here.

/** What each method takes. */
export interface BridgeParams {
  tabs: {};
  /** Without tab_id, opens a new background tab in the agent's group. url may also be back, forward or reload with a tab_id. */
  /** `group` titles the tab group a new tab goes into; it defaults to the agent's name. */
  navigate: { tab_id?: number; url: string; group?: string; wait_for?: string };
  /** `scope` is "main", "dialog" or a ref; `wait_for` waits up to 10 s for text to appear first. */
  /** `interactive` keeps only lines with refs, and headings. */
  read: { tab_id: number; query?: string; offset?: number; max_chars?: number; scope?: string; interactive?: boolean; wait_for?: string };
  /** A ref, or a viewport point (CSS px, as in a screenshot). `hover` only moves the pointer there; `drag_to` presses, moves there and releases. */
  click: {
    tab_id: number;
    ref?: string;
    x?: number;
    y?: number;
    button?: "left" | "right" | "middle";
    count?: number;
    modifiers?: string;
    hover?: boolean;
    drag_to?: string | { x: number; y: number };
    wait_for?: string;
  };
  /** Each file comes from a path on the browser's computer, a URL, or base64 data. */
  upload: { tab_id: number; ref: string; files: UploadFile[]; wait_for?: string };
  /** Console messages and page errors, or network requests, recorded since the first call on the tab. `request_id` gives one request's details and response body. */
  logs: { tab_id: number; kind?: "console" | "network"; query?: string; limit?: number; clear?: boolean; request_id?: string };
  /** Each field is typed into (replacing), chosen in, or ticked (true) or cleared (false). */
  fill: { tab_id: number; fields: Array<{ ref: string; value: string | boolean }>; wait_for?: string };
  key: { tab_id: number; key: string; wait_for?: string };
  /** Without `ref`, the viewport at its CSS size; with one, that element at the screen's full resolution. */
  screenshot: { tab_id: number; ref?: string };
  close: { tab_id: number };
  /** `code` is a function body: it may `await` and `return` a JSON-serializable value. */
  eval: { tab_id: number; code: string; world?: "isolated" | "main"; wait_for?: string };
}

export interface UploadFile {
  path?: string;
  url?: string;
  /** Base64 file content. */
  data?: string;
  name?: string;
  mime_type?: string;
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

/** chrome.storage.local key of the server URL set in the popup. */
export const SERVER_URL_KEY = "serverUrl";

/** What the popup shows about the connection to the server. */
export interface ConnectionStatus {
  state: "off" | "connecting" | "connected" | "error";
  error?: string;
}
