/** @jsxImportSource rune:dashboard */
import { Details, Table } from "rune:dashboard";

export function registerDashboard(settings: () => Record<string, RuneDashboardValue>,
  players: () => { name: string; ping: number; alerts: number }[]) {
  return rune.dashboard.register({
    id: "anticheat", title: "Anticheat", navigation: [{ page: "monitoring" }],
    metrics: () => ({ ...settings(), Online: players().length, Alerts: players().reduce((total, player) => total + player.alerts, 0) }),
    pages: { monitoring: { title: "Anticheat", render: () => <div className="stack">
      <section className="card"><h2>Monitoring thresholds</h2><Details values={settings()} /><p><a href="/settings">Edit thresholds</a></p></section>
      <Table title="Current player sessions" columns={["Player", "Ping (ms)", "Alerts"]} rows={players().map((row) => ({
        key: row.name, cells: [row.name, row.ping, row.alerts],
      }))} />
    </div> } },
  });
}
