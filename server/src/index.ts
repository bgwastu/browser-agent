import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const secret = (process.env.SECRET ?? "").trim();

const { server } = startServer({ port, secret });
const suffix = secret === "" ? "" : "/<SECRET>";
console.log(`browser-agent listening on :${server.port}`);
console.log(`  MCP:       /mcp${suffix}?agent=<name>`);
console.log(`  Extension: /ext${suffix} (WebSocket)`);
if (secret === "") console.warn("SECRET is not set: anyone who can reach this server can drive the connected browser.");
