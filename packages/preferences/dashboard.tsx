/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";

export function registerDashboard(keys: readonly string[], read: () => Record<string, boolean>) {
  function counts() {
    const slots = Object.entries(read());
    return keys.map((setting) => ({
      setting, total: slots.filter(([key, enabled]) => !enabled && key.endsWith(":" + setting)).length,
    }));
  }
  return rune.dashboard.register({
    id: "preferences", title: "Preferences", navigation: [{ page: "summary" }],
    metrics: () => Object.fromEntries(counts().map(({ setting, total }) => [setting + " opt-outs", total])),
    pages: { summary: { title: "Preferences", render: () =>
      <Table title="Player opt-outs" columns={["Preference", "Opted-out players"]} rows={counts().map(({ setting, total }) => ({
        key: setting, cells: [setting, total],
      }))} /> } },
  });
}
