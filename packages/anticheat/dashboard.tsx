/** @jsxImportSource rune:dashboard */
import { Card, Details, Operations, PlayerIdentity, Table } from "rune:dashboard";
import type { AnticheatAlert } from "./index.ts";

type Limits = { enabled: boolean; "speed-limit": number; "hit-limit": number; "max-ping": number; "min-tps": number };
type PlayerRow = { id: string; name: string; ping: number; alerts: number };

export function registerDashboard(config: { read(): Limits; update(changes: Limits): void },
  tps: () => number, players: () => PlayerRow[], alerts: () => readonly AnticheatAlert[]) {
  return rune.dashboard.register({
    id: "anticheat", title: "Anticheat", navigation: [{ page: "monitoring" }],
    metrics: () => ({ ...config.read(), "Estimated TPS": tps(), Online: players().length, "Recent alerts": alerts().length }),
    pages: { monitoring: { title: "Anticheat", render(context) {
      const settings = config.read();
      const id = context.query("id");
      const rows = [...alerts()].reverse().filter((row) => !id || row.playerId === id);
      const home = context.href("monitoring");
      return <div className="stack">
        <Card title="Monitoring thresholds"><Details values={{
          Monitoring: settings.enabled ? "Enabled" : "Disabled", "Estimated TPS": tps(),
          "Horizontal blocks per second": settings["speed-limit"], "Melee hits per second": settings["hit-limit"],
          "Maximum ping (ms)": settings["max-ping"], "Minimum TPS": settings["min-tps"],
        }} /></Card>
        <Table title="Current player sessions" columns={["Player", "Ping (ms)", "Session alerts"]} rows={players().map((row) => ({
          key: row.id, cells: [<a href={home + "?id=" + encodeURIComponent(row.id)}><PlayerIdentity {...row} /></a>, row.ping, row.alerts],
        }))} />
        {id && <p><a href={home}>Show alerts for all players</a></p>}
        <Table title="Recent detection alerts" columns={["Player", "Check", "Observed rate", "Limit", "Time"]} rows={rows.map((row, index) => ({
          key: index, cells: [<PlayerIdentity name={row.name} id={row.playerId} />, row.check, row.rate.toFixed(1), row.limit,
            new Date(row.timestamp).toISOString().slice(0, 19).replace("T", " ") + " UTC"],
        }))} />
        <Operations context={context} items={[{ id: "thresholds", label: "Configure monitoring", defaults: settings }]} />
      </div>;
    } } },
    actions: { thresholds: {
      title: "Configure monitoring", fields: {
        enabled: { type: "boolean", label: "Enable monitoring" },
        "speed-limit": { type: "number", label: "Horizontal blocks per second", min: 7, max: 80, required: true },
        "hit-limit": { type: "number", label: "Melee hits per second", min: 5, max: 30, required: true },
        "max-ping": { type: "number", label: "Maximum ping (ms)", min: 50, max: 1500, required: true },
        "min-tps": { type: "number", label: "Minimum TPS", min: 5, max: 20, required: true },
      },
      run(input) {
        config.update({ enabled: input.enabled === true, "speed-limit": Number(input["speed-limit"]), "hit-limit": Number(input["hit-limit"]),
          "max-ping": Number(input["max-ping"]), "min-tps": Number(input["min-tps"]) });
        return "Updated anticheat settings.";
      },
    } },
  });
}
