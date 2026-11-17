import type { BridgeMessage, BridgeMethod, BridgeParams } from "../../extension/src/shared.js";

const CALL_TIMEOUT_MS = 90_000;

/** Something that can carry text frames to the extension (a Bun ServerWebSocket). */
export interface Socket {
  send(data: string): unknown;
  close(): unknown;
}

export interface BrowserInfo {
  browser: string;
  version: string;
  extension: string;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * The one connected browser. A new extension connection replaces the old one,
 * and calls still waiting on the old one fail.
 */
export class Bridge {
  private socket: Socket | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  info: BrowserInfo | null = null;

  get connected(): boolean {
    return this.socket !== null;
  }

  attach(socket: Socket): void {
    if (this.socket !== null && this.socket !== socket) {
      this.socket.close();
      this.failAll("The browser reconnected; try again.");
    }
    this.socket = socket;
    this.info = null;
  }

  detach(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.info = null;
    this.failAll("The browser disconnected.");
  }

  receive(socket: Socket, data: string): void {
    if (this.socket !== socket) return;
    let message: BridgeMessage;
    try {
      message = JSON.parse(data) as BridgeMessage;
    } catch {
      return;
    }
    if ("type" in message) {
      if (message.type === "hello") this.info = { browser: message.browser, version: message.version, extension: message.extension };
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    if ("error" in message) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  }

  call<M extends BridgeMethod>(agent: string, method: M, params: BridgeParams[M], signal?: AbortSignal): Promise<unknown> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.reject(new Error("No browser is connected. Ask the user to open their browser with the Browser Agent extension."));
    }
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`The browser did not answer within ${CALL_TIMEOUT_MS / 1000} s.`));
      }, CALL_TIMEOUT_MS);
      const onAbort = () => {
        done();
        reject(new Error("Cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, agent, method, params }));
    });
  }

  private failAll(reason: string): void {
    for (const entry of [...this.pending.values()]) entry.reject(new Error(reason));
    this.pending.clear();
  }
}
