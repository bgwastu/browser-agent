/**
 * Functions that run inside a page, in the extension's isolated world. Each is
 * serialized with Function.prototype.toString, so it must not reference
 * anything outside its own body, except `pageRoots` and `findRef`: background.ts
 * defines both in the page ahead of every call.
 */

/** The document, every open shadow root and every same-origin frame's document in it, the document first. */
export function pageRoots(): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  for (const root of roots) {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
        let inner: Document | null = null;
        try {
          inner = (element as HTMLIFrameElement).contentDocument;
        } catch {
          // Another site's frame: not reachable from this page.
        }
        if (inner !== null) roots.push(inner);
      }
    }
  }
  return roots;
}

/** The element carrying a snapshot ref, in the document, an open shadow root or a same-origin frame. */
export function findRef(ref: string): Element | null {
  const selector = `[data-agent-ref="${CSS.escape(ref)}"]`;
  for (const root of pageRoots()) {
    const found = root.querySelector(selector);
    if (found !== null) return found;
  }
  return null;
}

export interface SnapshotOptions {
  query: string | null;
  offset: number;
  maxChars: number;
  /** "main", "dialog", a ref, or null for the whole page. */
  scope: string | null;
  /** The lowest ref number to hand out, so refs from an earlier page in the tab are not reused. */
  start: number;
  /** Return the outline's lines too, for comparing before and after an action. */
  lines: boolean;
  /** Keep only lines with refs, and headings. */
  interactive: boolean;
}

export interface SnapshotResult {
  text: string;
  total: number;
  nextOffset: number | null;
  refs: number;
  /** The next ref number to hand out. */
  next: number;
  /** True when the page body gave no lines at all. */
  empty: boolean;
  /** The scope asked for is not on the page. */
  scopeMissing: boolean;
  lines?: string[];
}

/**
 * A text outline of the page; interactive elements get a `[eN]` ref stored in
 * `data-agent-ref`. A ref stays with its element across snapshots while the
 * element keeps its role and name (a field may change its name as it is
 * filled); a changed or new element gets a new number, and refs of elements
 * that are gone or hidden are dropped. So an old ref never names a different
 * element: it names the same one, or none.
 */
/**
 * What scrolls the page: the document, or, on apps that keep the window still and
 * scroll a panel instead (LinkedIn, Gmail, many dashboards), the biggest visible panel that scrolls.
 */
export function mainScroller(): Element {
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollHeight - root.clientHeight > 1) return root;
  let best: Element = root;
  let bestArea = 0;
  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (element.scrollHeight - element.clientHeight <= 50) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)) continue;
    const box = element.getBoundingClientRect();
    const area = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0)) * Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
    if (area > bestArea) {
      best = element;
      bestArea = area;
    }
  }
  return best;
}

/**
 * A scroll key when nothing editable has focus, on a page whose window does not scroll: keys go to
 * the focused element, so the browser would scroll nothing. Scrolls the main panel; false when the
 * browser's own handling is right.
 */
export function scrollKey(key: string): boolean {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== document.documentElement) {
    if ((active as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;
  }
  const scroller = mainScroller();
  if (scroller === (document.scrollingElement ?? document.documentElement)) return false;
  const page = scroller.clientHeight * 0.85;
  const deltas: Record<string, number> = { PageDown: page, PageUp: -page, ArrowDown: 40, ArrowUp: -40, " ": page };
  if (key === "End") scroller.scrollTop = scroller.scrollHeight;
  else if (key === "Home") scroller.scrollTop = 0;
  else if (deltas[key] !== undefined) scroller.scrollTop += deltas[key];
  else return false;
  return true;
}

export function snapshotPage(options: SnapshotOptions): SnapshotResult {
  const ATTRIBUTE = "data-agent-ref";
  const WAS = "data-agent-was";
  const NEXT = "data-agent-next";
  const INTERACTIVE = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "switch", "combobox", "listbox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "file",
  ]);
  // Roles whose name may follow their value; their refs survive a name change.
  const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
  const SPECIAL =
    "a[href],button,input:not([type=hidden]),select,textarea,summary,[role],[contenteditable=''],[contenteditable=true],h1,h2,h3,h4,h5,h6,table,ul,ol,iframe";
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "CANVAS"]);
  // Read item by item, row by row, even with no control inside.
  const CONTAINERS = new Set(["UL", "OL", "DL", "TABLE", "THEAD", "TBODY", "TFOOT"]);
  const MAX_LINES = 4000;

  const previous = new Map<string, Element>();
  let next = Math.max(1, options.start, Number(document.documentElement.getAttribute(NEXT)) || 0);
  for (const root of pageRoots()) {
    for (const element of Array.from(root.querySelectorAll(`[${ATTRIBUTE}]`))) {
      const ref = element.getAttribute(ATTRIBUTE) ?? "";
      const number = Number(ref.slice(1));
      if (Number.isFinite(number)) next = Math.max(next, number + 1);
      // A copy of a ref'd node (cloned markup) must not share its ref.
      if (previous.has(ref)) {
        element.removeAttribute(ATTRIBUTE);
        element.removeAttribute(WAS);
      } else {
        previous.set(ref, element);
      }
    }
  }

  const lines: string[] = [];
  const seen = new Set<string>();

  const clean = (value: string | null | undefined, limit: number): string => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
  const quoted = (value: string): string => JSON.stringify(value);

  const isVisible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (style.display === "contents") return true;
    return element.getClientRects().length > 0;
  };

  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit.trim() !== "") return explicit.trim().split(/\s+/)[0] ?? null;
    const tag = element.tagName;
    if (tag === "A" && element.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const type = ((element as HTMLInputElement).type || "text").toLowerCase();
      if (type === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "file") return "file";
      return "textbox";
    }
    if ((element as HTMLElement).isContentEditable && element.hasAttribute("contenteditable")) return "textbox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    return null;
  };

  const nameOf = (element: Element): string => {
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim() !== "") return label;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => (element.ownerDocument.getElementById(id) as HTMLElement | null)?.innerText ?? "")
        .join(" ");
      if (text.trim() !== "") return text;
    }
    const labels = (element as HTMLInputElement).labels;
    if (labels !== null && labels !== undefined && labels.length > 0) {
      // A label around its control holds the control's text too (a select's options): leave controls out.
      const textOf = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (node.nodeType !== Node.ELEMENT_NODE || ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes((node as Element).tagName)) return "";
        return Array.from(node.childNodes).map(textOf).join(" ");
      };
      return Array.from(labels)
        .map((entry) => textOf(entry))
        .join(" ");
    }
    if (element.tagName === "INPUT") {
      const input = element as HTMLInputElement;
      if (["button", "submit", "reset"].includes(input.type)) return input.value;
      // A dropzone's file input is usually unlabelled: the short text around it says what it takes.
      if (input.type === "file") {
        const around = input.parentElement?.innerText ?? "";
        return input.title || input.name || (around.trim().length <= 120 ? around : input.id);
      }
      return input.placeholder || input.title || input.name || "";
    }
    if (element.tagName === "TEXTAREA") {
      const area = element as HTMLTextAreaElement;
      return area.placeholder || area.title || area.name || "";
    }
    if (element.tagName === "SELECT") return element.getAttribute("title") ?? (element as HTMLSelectElement).name;
    const text = (element as HTMLElement).innerText;
    if (text !== undefined && text.trim() !== "") return text;
    return element.getAttribute("title") ?? element.querySelector("img[alt]")?.getAttribute("alt") ?? "";
  };

  /** For a control with no name (an icon button): what the markup says about it. */
  const hintOf = (element: Element): string => {
    const parts: string[] = [];
    const inner = element.querySelector("svg title, [aria-label], img[alt], img[src], use[href], use[*|href]");
    if (inner !== null) {
      const text =
        inner.tagName.toLowerCase() === "title"
          ? inner.textContent
          : inner.getAttribute("aria-label") ?? inner.getAttribute("alt") ?? inner.getAttribute("href") ?? inner.getAttribute("xlink:href") ?? inner.getAttribute("src");
      const short = clean(text, 60).replace(/^.*[/#]/, "").replace(/\.(svg|png|jpe?g|gif|webp)(\?.*)?$/i, "");
      if (short !== "") parts.push(`icon:${short}`);
    }
    const iconClass = Array.from(element.querySelectorAll("[class]"))
      .concat(element)
      .flatMap((node) => Array.from(node.classList))
      .find((name) => /icon|fa-|glyph|symbol/i.test(name) && name.length < 40);
    if (iconClass !== undefined && parts.length === 0) parts.push(`icon:${iconClass}`);
    const testId = element.getAttribute("data-testid") ?? element.getAttribute("data-test-id") ?? element.getAttribute("data-test");
    if (testId) parts.push(`testid:${clean(testId, 40)}`);
    else if (element.id && !/\d{3,}|^[:_]/.test(element.id)) parts.push(`id:${clean(element.id, 40)}`);
    const name = element.getAttribute("name");
    if (name) parts.push(`name:${clean(name, 40)}`);
    return parts.length > 0 ? ` hint=${quoted(parts.join("; "))}` : "";
  };

  const stateOf = (element: Element, role: string): string => {
    const parts: string[] = [];
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const input = element as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") {
        parts.push(input.checked ? "checked" : "unchecked");
      } else if (input.type === "password") {
        if (input.value !== "") parts.push("value=(hidden)");
      } else if (input.type === "file") {
        if (input.accept !== "") parts.push(`accept=${quoted(clean(input.accept, 80))}`);
        if (input.multiple) parts.push("multiple");
        const names = Array.from(input.files ?? []).map((file) => file.name);
        if (names.length > 0) parts.push(`files=${quoted(clean(names.join(", "), 120))}`);
      } else if (input.value !== "") {
        parts.push(`value=${quoted(clean(input.value, 120))}`);
      }
      if (input.disabled) parts.push("disabled");
    } else if (tag === "SELECT") {
      const select = element as HTMLSelectElement;
      const chosen = Array.from(select.selectedOptions).map((option) => clean(option.text, 60));
      if (chosen.length > 0) parts.push(`selected=${quoted(chosen.join(", "))}`);
      const options = Array.from(select.options).map((option) => clean(option.text, 40));
      parts.push(`options=${quoted(options.slice(0, 25).join(" | ") + (options.length > 25 ? " | …" : ""))}`);
      if (select.disabled) parts.push("disabled");
    } else if (role === "textbox" && (element as HTMLElement).isContentEditable) {
      const text = clean((element as HTMLElement).innerText, 120);
      if (text !== "") parts.push(`value=${quoted(text)}`);
    }
    for (const [attribute, word] of [
      ["aria-checked", "checked"],
      ["aria-selected", "selected"],
      ["aria-expanded", "expanded"],
      ["aria-pressed", "pressed"],
    ] as const) {
      const value = element.getAttribute(attribute);
      if (value === "true") parts.push(word);
      if (value === "false" && (attribute === "aria-expanded" || attribute === "aria-checked")) {
        parts.push(attribute === "aria-expanded" ? "collapsed" : "unchecked");
      }
    }
    if (element.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (tag === "A") {
      const href = element.getAttribute("href") ?? "";
      if (href !== "" && !href.startsWith("javascript:")) parts.push(`href=${quoted(clean(href, 100))}`);
      if (element.getAttribute("target") === "_blank") parts.push("new-tab");
    }
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
  };

  /** The element's ref: its old one while it is the same element, otherwise a new number. */
  const refFor = (element: Element, role: string, identity: string): string => {
    const old = element.getAttribute(ATTRIBUTE);
    const was = element.getAttribute(WAS);
    const same = was === identity || (VALUE_ROLES.has(role) && was !== null && was.startsWith(`${role} `));
    const ref = old !== null && same && !seen.has(old) ? old : `e${next++}`;
    element.setAttribute(ATTRIBUTE, ref);
    element.setAttribute(WAS, identity);
    seen.add(ref);
    return ref;
  };

  const push = (line: string): void => {
    if (lines.length < MAX_LINES && line.trim() !== "") lines.push(line);
  };

  const visit = (element: Element): void => {
    if (lines.length >= MAX_LINES || SKIP.has(element.tagName.toUpperCase())) return;
    // Dropzones and upload buttons hide their file input; list it anyway, so the agent can find it.
    const hiddenFile = !isVisible(element) && element.tagName === "INPUT" && (element as HTMLInputElement).type === "file";
    if (!hiddenFile && !isVisible(element)) return;
    if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
      let inner: Document | null = null;
      try {
        inner = (element as HTMLIFrameElement).contentDocument;
      } catch {
        // Another site's frame.
      }
      if (inner?.body) {
        visit(inner.body);
      } else {
        const title = element.getAttribute("title") ?? element.getAttribute("name") ?? "";
        let host = "";
        try {
          host = new URL((element as HTMLIFrameElement).src, location.href).host;
        } catch {
          // No usable src.
        }
        push(`(frame${title ? ` ${quoted(clean(title, 60))}` : ""}${host ? ` from ${host}` : ""}: another site's content, which browser_read cannot see; use browser_screenshot, or open the frame's URL in its own tab with browser_navigate)`);
      }
      return;
    }
    const role = roleOf(element);
    if (role !== null && INTERACTIVE.has(role)) {
      const name = clean(nameOf(element), 100);
      const ref = refFor(element, role, `${role} ${quoted(name)}`);
      push(`[${ref}] ${role} ${quoted(name)}${name === "" ? hintOf(element) : ""}${stateOf(element, role)}${hiddenFile ? " hidden" : ""}`);
      if (role !== "listbox" && role !== "combobox") return;
      if (element.tagName === "SELECT") return;
    } else if (role === "heading") {
      const level = /^H([1-6])$/.exec(element.tagName)?.[1] ?? element.getAttribute("aria-level") ?? "";
      push(`${"#".repeat(Number(level) || 2)} ${clean((element as HTMLElement).innerText, 200)}`);
      return;
    } else if (element.tagName === "TR" && element.querySelector(SPECIAL) === null) {
      const cells = Array.from(element.children)
        .map((cell) => clean((cell as HTMLElement).innerText, 80))
        .filter((cell) => cell !== "");
      if (cells.length > 0) push(cells.join(" | "));
      return;
    } else if (!CONTAINERS.has(element.tagName) && element.querySelector(SPECIAL) === null && element.shadowRoot === null) {
      const text = clean((element as HTMLElement).innerText, 500);
      if (text !== "") push(element.tagName === "LI" ? `- ${text}` : text);
      return;
    }
    const children = element.shadowRoot !== null ? [element.shadowRoot, element] : [element];
    for (const parent of children) {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = clean(node.textContent, 300);
          // A combobox's own text is already its name.
          if (text !== "" && !(role === "combobox" && text === clean(nameOf(element), 100))) push(text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          visit(node as Element);
        }
      }
    }
  };

  let scopeRoot: Element | null = document.body;
  if (options.scope === "main") {
    scopeRoot = document.querySelector("main, [role=main]");
  } else if (options.scope === "dialog") {
    const dialogs = Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")).filter(isVisible);
    scopeRoot = dialogs[dialogs.length - 1] ?? null;
  } else if (options.scope !== null) {
    scopeRoot = findRef(options.scope);
  }
  if (scopeRoot !== null) visit(scopeRoot);

  // Refs of elements that are gone, hidden or changed (within what was read) expire.
  for (const [ref, element] of scopeRoot === null ? [] : previous) {
    if (seen.has(ref) || element.getAttribute(ATTRIBUTE) !== ref) continue;
    if (options.scope !== null && scopeRoot !== null && !scopeRoot.contains(element)) continue;
    element.removeAttribute(ATTRIBUTE);
    element.removeAttribute(WAS);
  }
  document.documentElement.setAttribute(NEXT, String(next));

  const empty = lines.length === 0 && options.scope === null;
  const header = [
    `Title: ${document.title}`,
    `URL: ${location.href}`,
    (() => {
      const scroller = mainScroller();
      const inner = scroller !== (document.scrollingElement ?? document.documentElement);
      const where = inner ? ` (in the page's scrolling panel; PageDown/End scroll it)` : "";
      return `Scroll: ${Math.round(scroller.scrollTop)} of ${Math.max(0, scroller.scrollHeight - scroller.clientHeight)} px${where}`;
    })(),
    "",
  ];
  const query = options.query?.trim().toLowerCase() ?? null;
  const refQuery = query !== null ? /^\[?(e\d+)\]?$/.exec(query)?.[1] : undefined;
  let body: string[] = lines;
  if (scopeRoot === null) {
    body = [`(There is no ${options.scope === "main" || options.scope === "dialog" ? `${options.scope} region` : `element ${options.scope}`} on this page. Read without scope.)`];
  } else if (empty) {
    const elements = document.body?.getElementsByTagName("*").length ?? 0;
    body = [
      `(The page shows no content yet: readyState ${document.readyState}, ${elements} elements in the body, viewport ${innerWidth}×${innerHeight}, ${document.visibilityState}. It may still be loading: call browser_read with wait_for, or take a browser_screenshot.)`,
    ];
  } else if (refQuery !== undefined) {
    body = lines.filter((line) => line.startsWith(`[${refQuery}] `));
    if (body.length === 0) body = [`(No element has ref ${refQuery} now: it is gone or changed. Read again without query.)`];
  } else {
    if (options.interactive) body = body.filter((line) => line.startsWith("[e") || line.startsWith("#"));
    if (query !== null && query !== "") {
      body = body.filter((line) => line.toLowerCase().includes(query));
      if (body.length === 0) body = [`(No line contains ${quoted(options.query ?? "")}; the page has ${lines.length} lines. Try another word, or read without query.)`];
    }
  }
  const full = [...header, ...body].join("\n");
  const start = Math.max(0, options.offset);
  const text =
    start >= full.length && start > 0
      ? `(Offset ${start} is past the end: this outline has ${full.length} characters. Read without offset, or use query or scope to find a part.)`
      : full.slice(start, start + options.maxChars);
  const end = Math.min(full.length, start + options.maxChars);
  return {
    text,
    total: full.length,
    nextOffset: end < full.length ? end : null,
    refs: seen.size,
    next,
    empty,
    scopeMissing: scopeRoot === null,
    ...(options.lines ? { lines } : {}),
  };
}

export interface Located {
  found: boolean;
  /** False when the element has no size: hidden, or a closed menu's item. */
  visible: boolean;
  x: number;
  y: number;
  covered: string | null;
}

/** Scrolls the ref into view and returns its center in the tab's viewport, in CSS pixels. */
export function locateRef(arg: string | { ref: string; scroll: boolean }): Located {
  const ref = typeof arg === "string" ? arg : arg.ref;
  const element = findRef(ref);
  if (element === null) return { found: false, visible: false, x: 0, y: 0, covered: null };
  if (typeof arg === "string" || arg.scroll) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  const hit = element.ownerDocument.elementFromPoint(x, y);
  const covered =
    hit === null || hit === element || element.contains(hit) || hit.contains(element)
      ? null
      : `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}`;
  // Inside same-origin frames, add each frame's offset to reach the tab's viewport.
  let view: Window | null = element.ownerDocument.defaultView;
  while (view !== null && view !== window && view.frameElement !== null) {
    const frame = view.frameElement;
    const box = frame.getBoundingClientRect();
    x += box.left + frame.clientLeft;
    y += box.top + frame.clientTop;
    view = view.parent;
  }
  return { found: true, visible: rect.width > 0 && rect.height > 0, x, y, covered };
}

export interface ShotArea {
  found: boolean;
  devicePixelRatio: number;
  /** In CSS pixels from the document's top left, as Page.captureScreenshot's clip takes them. */
  x: number;
  y: number;
  /** Zero when the ref is outside the viewport or takes no space. */
  width: number;
  height: number;
}

/** What a screenshot captures: the visible viewport, or a ref's box (scrolled into view, a little padded) within it. */
export function shotArea(ref: string | null): ShotArea {
  const PADDING = 8;
  const element = ref === null ? null : findRef(ref);
  if (ref !== null && element === null) return { found: false, devicePixelRatio: 1, x: 0, y: 0, width: 0, height: 0 };
  element?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const view = window.visualViewport;
  const left = view?.offsetLeft ?? 0;
  const top = view?.offsetTop ?? 0;
  const width = view?.width ?? document.documentElement.clientWidth;
  const height = view?.height ?? document.documentElement.clientHeight;
  const devicePixelRatio = window.devicePixelRatio || 1;
  if (element === null) return { found: true, devicePixelRatio, x: scrollX + left, y: scrollY + top, width, height };
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  // Inside same-origin frames, add each frame's offset to reach the tab's viewport.
  let frameView: Window | null = element.ownerDocument.defaultView;
  while (frameView !== null && frameView !== window && frameView.frameElement !== null) {
    const frame = frameView.frameElement;
    const box = frame.getBoundingClientRect();
    x += box.left + frame.clientLeft;
    y += box.top + frame.clientTop;
    frameView = frameView.parent;
  }
  const x1 = Math.max(left, x - PADDING);
  const y1 = Math.max(top, y - PADDING);
  const x2 = Math.min(left + width, x + rect.width + PADDING);
  const y2 = Math.min(top + height, y + rect.height + PADDING);
  const empty = rect.width <= 0 || rect.height <= 0 || x2 <= x1 || y2 <= y1;
  return {
    found: true,
    devicePixelRatio,
    x: scrollX + x1,
    y: scrollY + y1,
    width: empty ? 0 : x2 - x1,
    height: empty ? 0 : y2 - y1,
  };
}

/** Clicks through the DOM; the fallback when trusted input is unavailable. */
export function domClick(ref: string): boolean {
  const element = findRef(ref) as HTMLElement | null;
  if (element === null) return false;
  element.focus();
  element.click();
  return true;
}

/** Focuses an editable ref, selecting its content when `replace` is set. */
export function focusRef(args: { ref: string; replace: boolean }): { found: boolean; editable: boolean } {
  const element = findRef(args.ref) as HTMLElement | null;
  if (element === null) return { found: false, editable: false };
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();
  const field = element as HTMLInputElement;
  const isField = element.tagName === "INPUT" || element.tagName === "TEXTAREA";
  if (!isField && !element.isContentEditable) return { found: true, editable: false };
  if (args.replace) {
    if (isField) {
      field.select();
    } else {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  } else if (isField) {
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      // Some input types (email, number) do not support selection ranges.
    }
  }
  return { found: true, editable: true };
}

/** The field's current value. */
export function readValue(ref: string): { found: boolean; value: string } {
  const element = findRef(ref) as HTMLElement | null;
  if (element === null) return { found: false, value: "" };
  const value = element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? (element as HTMLInputElement).value : element.innerText;
  return { found: true, value };
}

/** Sets a field's value the way a framework sees typing; the fallback when Input.insertText is unavailable. */
export function setValue(args: { ref: string; text: string; replace: boolean }): boolean {
  const element = findRef(args.ref) as HTMLElement | null;
  if (element === null) return false;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    const field = element as HTMLInputElement;
    // The field's own realm: a frame has its own HTMLInputElement.
    const realm = (element.ownerDocument.defaultView ?? window) as typeof window;
    const prototype = element.tagName === "INPUT" ? realm.HTMLInputElement.prototype : realm.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    const next = args.replace ? args.text : field.value + args.text;
    if (setter !== undefined) setter.call(field, next);
    else field.value = next;
  } else if (element.isContentEditable) {
    element.innerText = args.replace ? args.text : element.innerText + args.text;
  } else {
    return false;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: args.text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Chooses an option of a <select> by its value or visible text. */
export function selectOption(args: { ref: string; option: string }): { found: boolean; chosen: string | null; options: string[] } {
  const element = findRef(args.ref);
  if (element === null || element.tagName !== "SELECT") return { found: element !== null, chosen: null, options: [] };
  const select = element as HTMLSelectElement;
  const options = Array.from(select.options);
  const wanted = args.option.trim().toLowerCase();
  const match =
    options.find((option) => option.value === args.option) ??
    options.find((option) => option.text.trim().toLowerCase() === wanted) ??
    options.find((option) => option.text.trim().toLowerCase().includes(wanted));
  if (match === undefined) return { found: true, chosen: null, options: options.map((option) => option.text.trim()) };
  select.value = match.value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, chosen: match.text.trim(), options: [] };
}

export interface FieldKind {
  found: boolean;
  kind: "select" | "check" | "text" | "file" | "other";
  checked: boolean;
}

/** What filling a ref means: choosing an option, ticking a box, or typing. */
export function fieldKind(ref: string): FieldKind {
  const element = findRef(ref) as HTMLElement | null;
  if (element === null) return { found: false, kind: "other", checked: false };
  const input = element as HTMLInputElement;
  if (element.tagName === "SELECT") return { found: true, kind: "select", checked: false };
  if (element.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) {
    return { found: true, kind: "check", checked: input.checked };
  }
  if (element.tagName === "INPUT" && input.type === "file") return { found: true, kind: "file", checked: false };
  const role = element.getAttribute("role");
  if (role === "checkbox" || role === "switch" || role === "radio" || role === "menuitemcheckbox") {
    return { found: true, kind: "check", checked: element.getAttribute("aria-checked") === "true" };
  }
  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.isContentEditable) {
    return { found: true, kind: "text", checked: false };
  }
  return { found: true, kind: "other", checked: false };
}


/** What is at a viewport point (CSS px), for reporting what a click at coordinates hit. */
export function pointAt(point: { x: number; y: number }): string | null {
  let doc: Document = document;
  let x = point.x;
  let y = point.y;
  let hit = doc.elementFromPoint(x, y);
  // Into same-origin frames.
  while (hit !== null && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
    let inner: Document | null = null;
    try {
      inner = (hit as HTMLIFrameElement).contentDocument;
    } catch {
      break;
    }
    if (inner === null) break;
    const box = hit.getBoundingClientRect();
    x -= box.left + hit.clientLeft;
    y -= box.top + hit.clientTop;
    doc = inner;
    hit = doc.elementFromPoint(x, y);
  }
  if (hit === null) return null;
  const target = hit.closest("[data-agent-ref]");
  const text = ((target ?? hit) as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "";
  const label = (target ?? hit).getAttribute("aria-label");
  const tag = hit.tagName.toLowerCase();
  return `${target !== null ? `[${target.getAttribute("data-agent-ref")}] ` : ""}<${tag}${hit.id ? `#${hit.id}` : ""}> ${JSON.stringify(label ?? text)}`;
}

/** Gives files to a file input (as if picked), or drops them on any other element. */
export function putFiles(args: { ref: string; files: Array<{ name: string; type: string; data: string }> }): { found: boolean; input: boolean; names: string[] } {
  const element = findRef(args.ref);
  if (element === null) return { found: false, input: false, names: [] };
  const transfer = new DataTransfer();
  for (const file of args.files) {
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: Date.now() }));
  }
  const names = Array.from(transfer.files).map((file) => file.name);
  if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "file") {
    const input = element as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, input: true, names };
  }
  element.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ["dragenter", "dragover", "drop"]) {
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }));
  }
  return { found: true, input: false, names };
}
