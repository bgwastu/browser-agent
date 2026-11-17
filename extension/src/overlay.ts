// The on-page sign that an agent is using a tab: a glowing frame, a pill with a Stop button, and a cursor
// that moves to where the agent clicks. Runs as a content script (chrome.scripting, so its Stop button can
// message the extension), as one self-contained function, inside a closed shadow root: the page cannot
// see into it, and it takes no pointer events while an action runs, so it never gets in the agent's way.

export type OverlayCommand =
  /** The agent is using the tab: `busy` while a call runs, then it lingers `linger_ms` and fades. */
  | { op: "show"; label: string; busy: boolean; paused: boolean; linger_ms: number }
  /** Moves the cursor to a viewport point (and ripples for a click); `ms` sets the glide, `wait` false returns at once. */
  | { op: "cursor"; x: number; y: number; click?: boolean; grab?: boolean; ms?: number; wait?: boolean }
  /** Rings an element and moves the cursor onto it. */
  | { op: "focus"; ref: string }
  /** Hides everything, for a screenshot; the next show brings it back. */
  | { op: "hide" };

export interface OverlayState {
  /** The user pressed Stop on this page (and has not pressed Resume). */
  stopped: boolean;
}

export function overlay(command: OverlayCommand): Promise<OverlayState> {
  const TAG = "browser-agent-overlay";
  const ACCENT = "#8b6cff";
  interface Ui {
    host: HTMLElement;
    root: HTMLElement;
    text: HTMLElement;
    button: HTMLButtonElement;
    cursor: HTMLElement;
    ring: HTMLElement;
    stopped: boolean;
    /** A Stop or Resume the user pressed that the extension has not acknowledged yet. */
    pending: boolean | null;
    label: string;
    timer: number | undefined;
    cursorAt: { x: number; y: number } | null;
  }
  const scope = globalThis as unknown as { __browserAgentOverlay?: Ui };
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const render = (ui: Ui): void => {
    ui.root.classList.toggle("stopped", ui.stopped);
    if (ui.stopped) {
      ui.root.classList.remove("on", "busy");
      ui.text.textContent = `You stopped ${ui.label}. It waits until you resume.`;
      ui.button.textContent = "Resume";
      ui.cursor.classList.remove("show");
    } else {
      ui.text.textContent = `${ui.label} is using this tab`;
      ui.button.textContent = "Stop";
    }
  };

  const build = (): Ui => {
    // A host left by an earlier world (the extension restarted): keep its Stop, replace it.
    let wasStopped: boolean | null = null;
    for (const old of Array.from(document.querySelectorAll(TAG))) {
      if ((old as HTMLElement).dataset.stopped === "1") wasStopped = true;
      old.remove();
    }
    const host = document.createElement(TAG);
    host.style.cssText = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      * { box-sizing: border-box; }
      .root { position: fixed; inset: 0; pointer-events: none; font: 500 12.5px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .root.hidden { display: none; }
      .glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .4s;
        box-shadow: inset 0 0 0 2px ${ACCENT}d9, inset 0 0 26px 4px ${ACCENT}66; animation: pulse 2.4s ease-in-out infinite; }
      .on .glow { opacity: 1; }
      @keyframes pulse { 50% { box-shadow: inset 0 0 0 2px ${ACCENT}99, inset 0 0 40px 10px ${ACCENT}38; } }
      .pill { position: fixed; left: 50%; bottom: 18px; display: flex; align-items: center; gap: 9px; max-width: calc(100vw - 32px);
        padding: 6px 6px 6px 13px; border-radius: 999px; background: rgba(22, 20, 34, .94); color: #fff;
        box-shadow: 0 6px 22px rgba(0, 0, 0, .32), 0 0 0 1px rgba(255, 255, 255, .08);
        opacity: 0; transform: translate(-50%, 10px); transition: opacity .25s, transform .25s; pointer-events: none; }
      .on .pill, .stopped .pill { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
      .busy .pill { pointer-events: none; }
      .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}; animation: blink 1.1s ease-in-out infinite; }
      .stopped .dot { background: #f5a524; animation: none; }
      @keyframes blink { 50% { opacity: .35; } }
      button { all: unset; flex: none; cursor: pointer; padding: 4px 11px; border-radius: 999px; background: rgba(255, 255, 255, .14); font-weight: 600; }
      button:hover { background: rgba(255, 255, 255, .26); }
      .cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; pointer-events: none; opacity: 0;
        transition-property: transform, opacity; transition-timing-function: cubic-bezier(.3, .7, .2, 1); will-change: transform;
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .35)); }
      .cursor.show { opacity: 1; }
      .cursor.grab path { fill: #6a4cf0; }
      .ripple { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; border: 2px solid ${ACCENT};
        pointer-events: none; animation: ripple .5s ease-out forwards; }
      @keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
      .ring { position: fixed; pointer-events: none; border: 2px solid ${ACCENT}; border-radius: 6px; box-shadow: 0 0 0 4px ${ACCENT}40;
        opacity: 0; transition: opacity .3s; }
      .ring.show { opacity: 1; }
    </style>
    <div class="root"><div class="glow"></div><div class="ring"></div>
      <div class="pill"><span class="dot"></span><span class="text"></span><button type="button"></button></div>
      <div class="cursor"><svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2.5 L4 21 L9.2 16.4 L12.8 24 L16 22.5 L12.5 15 L19.6 15 Z" fill="${ACCENT}" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg></div>
    </div>`;
    const ui: Ui = {
      host,
      root: shadow.querySelector(".root") as HTMLElement,
      text: shadow.querySelector(".text") as HTMLElement,
      button: shadow.querySelector("button") as HTMLButtonElement,
      cursor: shadow.querySelector(".cursor") as HTMLElement,
      ring: shadow.querySelector(".ring") as HTMLElement,
      stopped: wasStopped === true,
      pending: wasStopped,
      label: "Agent",
      timer: undefined,
      cursorAt: null,
    };
    ui.button.addEventListener("click", (event) => {
      event.stopPropagation();
      ui.stopped = !ui.stopped;
      ui.pending = ui.stopped;
      if (ui.stopped) host.dataset.stopped = "1";
      else delete host.dataset.stopped;
      // Tells the extension at once, so a Stop holds even if the page navigates away.
      try {
        void chrome.runtime.sendMessage({ type: "overlay-stop", stopped: ui.stopped }).catch(() => undefined);
      } catch {
        // The extension was reloaded: it reads the state on its next call.
      }
      if (!ui.stopped) {
        ui.root.classList.add("on");
        clearTimeout(ui.timer);
        ui.timer = setTimeout(() => ui.root.classList.remove("on"), 4_000) as unknown as number;
      }
      render(ui);
    });
    document.documentElement.append(host);
    return ui;
  };

  let ui = scope.__browserAgentOverlay;
  let fresh = false;
  if (ui === undefined || ui.host.ownerDocument !== document) {
    ui = build();
    scope.__browserAgentOverlay = ui;
    fresh = true;
  } else if (!ui.host.isConnected) {
    // The page replaced <html>'s children: put it back.
    document.documentElement.append(ui.host);
  }
  const current = ui;

  const fade = (): void => {
    current.root.classList.remove("on", "busy");
    current.cursor.classList.remove("show");
    current.cursorAt = null;
  };

  /** Glides the cursor to a point; resolves when it gets there. */
  const glide = async (x: number, y: number, ms?: number, grab = false): Promise<void> => {
    const cursor = current.cursor;
    if (current.cursorAt === null) {
      // It comes in from the pill, where the agent "lives".
      cursor.style.transitionDuration = "0ms";
      cursor.style.transform = `translate(${innerWidth / 2 - 4}px, ${innerHeight - 40}px)`;
      cursor.getBoundingClientRect();
      current.cursorAt = { x: innerWidth / 2, y: innerHeight - 36 };
    }
    const distance = Math.hypot(x - current.cursorAt.x, y - current.cursorAt.y);
    const duration = ms ?? Math.round(Math.min(360, 110 + distance / 5));
    cursor.classList.add("show");
    cursor.classList.toggle("grab", grab);
    cursor.style.transitionDuration = `${duration}ms, 200ms`;
    // The arrow's tip is at (4, 2.5) in its box.
    cursor.style.transform = `translate(${x - 4}px, ${y - 2.5}px)`;
    current.cursorAt = { x, y };
    await wait(duration + 15);
  };

  const run = async (): Promise<OverlayState> => {
    switch (command.op) {
      case "show": {
        // The extension's word holds, except for a press it has not heard of yet. (A page restored from the
        // back-forward cache must not bring back a Stop the user already took back elsewhere.)
        if (current.pending !== null) {
          current.stopped = current.pending;
          current.pending = null;
        } else {
          current.stopped = command.paused;
        }
        if (current.stopped) current.host.dataset.stopped = "1";
        else delete current.host.dataset.stopped;
        current.label = command.label;
        current.root.classList.remove("hidden");
        clearTimeout(current.timer);
        if (!current.stopped) {
          current.root.classList.add("on");
          current.root.classList.toggle("busy", command.busy);
          // A call that never reports back still lets the frame fade.
          current.timer = setTimeout(fade, command.busy ? Math.max(command.linger_ms, 60_000) : command.linger_ms) as unknown as number;
          if (!command.busy) current.cursor.classList.remove("grab");
        }
        render(current);
        break;
      }
      case "hide": {
        current.root.classList.add("hidden");
        // Let the browser paint without it before the screenshot.
        await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), wait(60)]);
        break;
      }
      case "cursor": {
        if (current.stopped) break;
        const moving = glide(command.x, command.y, command.ms, command.grab === true);
        if (command.wait === false) break;
        await moving;
        if (command.click === true) {
          const ripple = document.createElement("div");
          ripple.className = "ripple";
          ripple.style.left = `${command.x}px`;
          ripple.style.top = `${command.y}px`;
          current.root.append(ripple);
          setTimeout(() => ripple.remove(), 600);
        }
        break;
      }
      case "focus": {
        if (current.stopped) break;
        // Refs are marked on the elements; frames have their own coordinates, so only this document's count.
        const selector = `[data-agent-ref="${CSS.escape(command.ref)}"]`;
        let element = document.querySelector(selector);
        if (element === null) {
          for (const each of Array.from(document.querySelectorAll("*"))) {
            element = each.shadowRoot?.querySelector(selector) ?? null;
            if (element !== null) break;
          }
        }
        if (element === null) break;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) break;
        const ring = current.ring;
        ring.style.left = `${rect.left - 3}px`;
        ring.style.top = `${rect.top - 3}px`;
        ring.style.width = `${rect.width + 6}px`;
        ring.style.height = `${rect.height + 6}px`;
        ring.classList.add("show");
        setTimeout(() => ring.classList.remove("show"), 900);
        await glide(Math.min(rect.left + 14, rect.right - 4), rect.top + rect.height / 2);
        break;
      }
    }
    return { stopped: current.stopped };
  };
  return run();
}
