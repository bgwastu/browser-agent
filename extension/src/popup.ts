// The toolbar popup: set the server URL and see whether the extension is connected.
import { SERVER_URL_KEY, type ConnectionStatus } from "./shared.js";

const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("url") as HTMLInputElement;
const saved = document.getElementById("saved") as HTMLElement;
const dot = document.getElementById("dot") as HTMLElement;
const text = document.getElementById("text") as HTMLElement;

const LABELS: Record<ConnectionStatus["state"], string> = {
  off: "No server URL set.",
  connecting: "Connecting…",
  connected: "Connected.",
  error: "Not connected.",
};

/** Accepts ws(s):// as is, and turns http(s):// into ws(s)://. */
function normalize(raw: string): string {
  const url = raw.trim();
  if (url === "") return "";
  const parsed = new URL(url.replace(/^http(s?):\/\//, "ws$1://"));
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("Use a wss://, ws://, https:// or http:// URL.");
  return parsed.toString();
}

async function refresh(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "status" })) as (ConnectionStatus & { url: string }) | undefined;
  if (status === undefined) return;
  if (document.activeElement !== input && input.value === "") input.value = status.url;
  dot.className = status.state;
  text.textContent = status.state === "error" && status.error !== undefined ? status.error : LABELS[status.state];
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = normalize(input.value);
    input.value = url;
    await chrome.storage.local.set({ [SERVER_URL_KEY]: url });
    saved.textContent = "Saved.";
  } catch (error) {
    saved.textContent = error instanceof Error ? error.message : String(error);
  }
});

void refresh();
setInterval(() => void refresh(), 1000);
