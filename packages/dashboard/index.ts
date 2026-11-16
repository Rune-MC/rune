import { startConsole } from "./app.tsx";

if (typeof rune.dashboard.monitor !== "function") throw new Error("Rune Dashboard requires Rune 0.5.3 or later.");
const port = Number(process.env.RUNE_DASHBOARD_PORT ?? 8777);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Set RUNE_DASHBOARD_PORT to a valid TCP port.");
await startConsole(port);
console.info(`Rune Dashboard is listening at http://127.0.0.1:${port}`);
