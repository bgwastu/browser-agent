// Builds the extension into extension/dist: compiles src with tsc (no bundling: page.ts functions are
// sent to pages with Function.prototype.toString, so their names must survive), copies static/,
// and writes the server URL into config.js.
//
//   SERVER_URL=wss://example.com/ext/<secret> bun run build:extension
//   OUT_DIR=/some/path changes where it goes.
import { $ } from "bun";
import { cp, rm, writeFile } from "node:fs/promises";

const root = new URL(".", import.meta.url).pathname;
const url = process.env.SERVER_URL ?? "";
const out = process.env.OUT_DIR ?? `${root}dist`;
if (url === "") console.log("SERVER_URL is not set: set the server URL in the extension popup.");
else if (!/^wss?:\/\//.test(url)) throw new Error(`SERVER_URL must start with ws:// or wss://, got ${url}`);

await rm(out, { recursive: true, force: true });
await $`bunx tsc -p ${root}tsconfig.json --outDir ${out}`;
await cp(`${root}static`, out, { recursive: true, filter: (source) => !source.endsWith(".svg") });
await writeFile(`${out}/config.js`, `export const SERVER_URL = ${JSON.stringify(url)};\n`);
console.log(`Built ${out}${url !== "" ? ` (server ${url.replace(/\/ext\/.*/, "/ext/…")})` : ""}`);
