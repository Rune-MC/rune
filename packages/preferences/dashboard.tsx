/** @jsxImportSource rune:dashboard */
import { Operations, PlayerIdentity, Table } from "rune:dashboard";

type Setting = "announcements" | "actionbars" | "sounds";
const labels: Record<Setting, string> = { announcements: "Announcements", actionbars: "Action bars", sounds: "Sounds" };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function directory() {
  const result = new Map<string, string>();
  for (const player of [...(rune.bukkit.getOfflinePlayers() as OfflinePlayer[]), ...rune.players()]) {
    const id = String(player.getUniqueId());
    result.set(id, player.getName() ?? id);
  }
  return result;
}

export function registerDashboard(keys: readonly Setting[], read: () => Record<string, boolean>,
  set: (player: string, key: Setting, enabled: boolean) => Promise<void>) {
  function counts() {
    const slots = Object.entries(read());
    return keys.map((setting) => ({
      setting, total: slots.filter(([key, enabled]) => !enabled && key.endsWith(":" + setting)).length,
    }));
  }
  return rune.dashboard.register({
    id: "preferences", title: "Preferences", navigation: [{ page: "summary" }],
    metrics: () => Object.fromEntries(counts().map(({ setting, total }) => [labels[setting] + " opt-outs", total])),
    pages: { summary: { title: "Player preferences", render(context) {
      const query = context.query("q")?.toLowerCase().slice(0, 100) ?? "";
      const id = context.query("id") ?? "";
      const players = directory();
      const data = read();
      for (const key of Object.keys(data)) {
        const player = key.split(":")[0];
        if (!players.has(player) && uuid.test(player)) players.set(player, player);
      }
      const rows = [...players].filter(([key, name]) => key.includes(query) || name.toLowerCase().includes(query));
      const enabled = (player: string, key: Setting) => data[player + ":" + key] ?? true;
      return <div className="stack">
        <Table title="Player opt-outs" columns={["Preference", "Opted-out players"]} rows={counts().map(({ setting, total }) => ({
          key: setting, cells: [labels[setting], total],
        }))} />
        <search aria-label="Find player preferences"><form className="toolbar">
          <label>Player name or UUID<input name="q" defaultValue={query} maxLength={100} /></label><button type="submit">Find players</button>
        </form></search>
        <Table title={`Players · ${rows.length} found`} columns={["Player", ...keys.map((key) => labels[key])]} rows={rows.slice(0, 100).map(([key, name]) => ({
          key, cells: [<a href={context.href("summary") + "?id=" + encodeURIComponent(key)}><PlayerIdentity id={key} name={name} /></a>,
            ...keys.map((setting) => enabled(key, setting) ? "On" : "Off")],
        }))} />
        {players.has(id) && <Operations title={`Manage ${players.get(id)}`} context={context} items={keys.map((key) => ({
          id: "preference", key, label: labels[key], defaults: { player: id, setting: key, enabled: enabled(id, key) },
        }))} />}
      </div>;
    } } },
    actions: {
      preference: {
        title: "Set player preference", fields: {
          player: { type: "string", label: "Player name or UUID", required: true, maxLength: 36 },
          setting: { type: "string", choices: labels, required: true }, enabled: { type: "boolean", label: "Enable this preference" },
        },
        async run(input) {
          const key = String(input.player).toLowerCase();
          const player = uuid.test(key) ? key : [...directory()].find(([, name]) => name.toLowerCase() === key)?.[0];
          if (!player) throw new Error("Choose a known player or enter their UUID.");
          const setting = input.setting as Setting;
          await set(player, setting, input.enabled === true);
          return `Updated ${labels[setting].toLowerCase()}.`;
        },
      },
    },
  });
}
