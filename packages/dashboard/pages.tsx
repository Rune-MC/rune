/** @jsxImportSource react */
import { type ReactNode } from "react";
import { Badge, Card, Details, FormField, number, Table, Utc } from "./ui.tsx";
import { PlayerIdentity } from "./identity.tsx";
import { Search } from "lucide-react";

type RuneEntry = Awaited<ReturnType<RuneDashboardMonitor["runes"]>>[number];
type Log = ReturnType<RuneDashboardMonitor["logs"]>[number];

function ownedLogs(rows: Log[], runes: RuneEntry[]) {
  const sources = new Map(runes.flatMap((rune) => rune.script ? [[rune.script.path, rune] as const] : []));
  const folders = new Map(runes.map((rune) => [rune.id.toLowerCase(), rune]));
  return rows.map((row) => {
    if (!row.rune) return { ...row, source: "runtime", label: "Rune runtime" };
    const parts = row.rune.replaceAll("\\", "/").split("/").filter(Boolean);
    const matched = sources.get(row.rune) ?? folders.get(parts.at(-2)?.toLowerCase() ?? "");
    const name = parts.at(-1) ?? "Local Rune";
    return { ...row, source: matched?.id ?? name, label: matched?.name ?? name };
  });
}

export const asLink = (root: string, id: string) => root + "/" + encodeURIComponent(id);
const state = (value: string) => {
  const status = value.toLowerCase();
  return <Badge tone={status === "loaded" ? "good" : status.startsWith("fail") ? "bad" : "warn"}>{value}</Badge>;
};
const sum = (script: RuneDashboardScript | undefined, key: "calls" | "errors" | "registered") =>
  script ? Object.values(script.activity).reduce((total, entry) => total + entry[key], 0) : "—";

export function Runes({ rows, query }: { rows: RuneEntry[]; query: string }) {
  const visible = rows.filter(({ name, id, status }) => [name, id, status].some((value) => value.toLowerCase().includes(query.toLowerCase())));
  return <>
    <search><form className="toolbar" method="get" action="/runes">
      <label>Find a Rune<input type="search" name="q" defaultValue={query} /></label><button type="submit"><Search size={16} aria-hidden="true" />Search</button>
      {query && <a className="button" href="/runes">Clear</a>}
    </form></search>
    <Table title={`Runes · ${visible.length} of ${rows.length}`} columns={["Rune", "Version", "Status", "Registered", "Calls", "Errors", "Startup (ms)"]}
      rows={visible.map(({ name, id, version, status, script }) => ({ key: id, cells: [
        <a href={asLink("/runes", id)}>{name}</a>, version ?? "Local", state(status), sum(script, "registered"),
        sum(script, "calls"), sum(script, "errors"), script ? number(script.loadMs, 2) : "—",
      ] }))} empty={query ? "No Runes match this search." : "No installed or loaded Runes were reported."} />
  </>;
}

export function RuneDetails({ item, tools, logs }: { item: RuneEntry; tools: { id: string; title: string }[]; logs: Log[] }) {
  const { script } = item;
  return <div className="stack">
    <div className="grid"><Card title="Runtime">
      <Details values={{
        Version: item.version ?? "Local", Status: state(item.status), Entry: script?.path,
        "Load duration": script ? `${number(script.loadMs, 2)} ms` : null,
        "Run since": script ? <Utc value={script.started} /> : null, "Log entries": script?.logCount,
      }} />
      {script?.lastError && <p className="note error">{script.lastError}</p>}
    </Card>{tools.length > 0 && <Card title="Tools"><ul>{tools.map((tool) => <li key={tool.id}><a href={asLink("/tools", tool.id)}>{tool.title}</a></li>)}</ul></Card>}</div>
    <Table title="Rune callbacks" columns={["Callback", "Registered", "Calls", "Errors", "Sync total (ms)", "Sync peak (ms)"]}
      rows={Object.entries(script?.activity ?? {}).map(([kind, row]) => ({ key: kind, cells: [
        kind, row.registered, row.calls, row.errors, number(row.syncMs, 3), number(row.maxMs, 3),
      ] }))} empty={script ? "This Rune has no instrumented callbacks." : "Callback telemetry is available for Runes loaded by the Node runtime."} />
    <p className="muted">Callback timing measures synchronous work. Process CPU and memory are shared by all plugins.</p>
    <Card title="Recent output"><LogLines rows={ownedLogs(logs, [item])} /></Card>
  </div>;
}

export function Server({ host, csrf }: { host: RuneDashboardServer | null | undefined; csrf: string }) {
  return <div className="stack">
    <div className="grid">
      <Card title="Paper server"><Details values={{
        Minecraft: host?.server.minecraft, Build: host?.server.version, Rune: host?.server.rune,
        "TPS (1 min)": number(host?.server.tps?.[0]), "TPS (5 min)": number(host?.server.tps?.[1]),
        "TPS (15 min)": number(host?.server.tps?.[2]),
      }} /></Card>
      <Card title="Reload Runes">
        <p>Reload scripts and dashboard tools. The dashboard connection will briefly restart.</p>
        <form method="post" action="/reload">
          <input type="hidden" name="csrf" value={csrf} />
          <p><label className="check"><input type="checkbox" name="confirm" value="yes" required />Reload all Runes</label></p>
          <button className="danger" type="submit">Request reload</button>
        </form>
      </Card>
    </div>
    <Table title="Worlds" columns={["World", "Environment", "Players", "Loaded chunks"]}
      rows={(host?.worlds ?? []).map((world) => ({ key: world.name, cells: [world.name, world.environment, world.players, world.chunks] }))}
      empty="World statistics are unavailable." />
    <Table title="Bukkit plugins" columns={["Plugin", "Version", "Status", "Listeners", "Pending Bukkit tasks", "Authors"]}
      rows={(host?.plugins ?? []).map((plugin) => ({ key: plugin.name, cells: [
        plugin.description ? <details><summary>{plugin.name}</summary>{plugin.description}</details> : plugin.name,
        plugin.version, <Badge tone={plugin.enabled ? "good" : "warn"}>{plugin.enabled ? "Enabled" : "Disabled"}</Badge>,
        plugin.listeners, plugin.pendingTasks, plugin.authors.join(", ") || "—",
      ] }))} empty="Bukkit plugin statistics are unavailable." />
  </div>;
}

export function Players({ host }: { host: RuneDashboardServer | null | undefined }) {
  return <Table title={`Players online · ${host ? `${host.server.online}/${host.server.capacity}` : "Waiting for the server"}`}
    columns={["Player", "World", "Game mode", "Ping (ms)"]}
    rows={(host?.players ?? []).map((player) => ({ key: player.name, cells: [
      <PlayerIdentity name={player.name} id={player.id} />, player.world, player.mode, player.ping,
    ] }))}
    empty={host ? "No players are connected." : "Player statistics are unavailable."} />;
}

function LogLines({ rows }: { rows: ReturnType<typeof ownedLogs> }) {
  if (!rows.length) return <p className="muted">No matching Rune logs.</p>;
  return <ol className="log-lines">{rows.map((row) => <li key={row.id}>
    <Utc value={row.at} /><Badge tone={row.level === "error" ? "bad" : row.level === "warn" ? "warn" : ""}>{row.level}</Badge>
    <div><small>{row.label}</small><pre>{row.text}</pre></div>
  </li>)}</ol>;
}

export function Logs({ rows, runes, level, query, owner }: { rows: Log[]; runes: RuneEntry[]; level: string; query: string; owner: string }) {
  const labeled = ownedLogs(rows, runes);
  const owners = [...new Map(labeled.map(({ source, label }) => [source, label])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const filtered = labeled.filter((row) => (!level || row.level === level) && (!owner || row.source === owner || row.rune === owner) &&
    (!query || row.text.toLowerCase().includes(query.toLowerCase()))).reverse();
  return <><search><form className="toolbar" action="/logs" method="get">
    <label>Search output<input type="search" name="q" defaultValue={query} /></label>
    <label>Level<select name="level" defaultValue={level}><option value="">All levels</option>
      {["error", "warn", "info", "log", "debug"].map((item) => <option key={item}>{item}</option>)}
    </select></label>
    <label>Rune<select name="rune" defaultValue={owner}><option value="">All Runes</option>
      {owners.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
    <button type="submit">Apply</button><a href="/logs" className="button">Clear</a>
  </form></search><LogLines rows={filtered} /></>;
}

type Config = ReturnType<RuneDashboardMonitor["configs"]> extends Map<string, infer Value> ? Value : never;
export function Settings({ configs, csrf, saved }: { configs: Map<string, Config>; csrf: string; saved?: boolean }) {
  if (!configs.size) return <Card title="Settings"><p className="muted">No Runes have registered settings.</p></Card>;
  return <>{saved && <p className="note" role="status">Settings saved.</p>}
    <div className="form-grid">{[...configs].map(([id, config]) => {
      const values = config.read();
      return <Card key={id} title={id}><form method="post" action={asLink("/settings", id)}>
        <input type="hidden" name="csrf" value={csrf} />
        {Object.entries(config.schema).map(([name, schema]) => <FormField key={name} name={name}
          spec={{ ...schema, required: typeof schema.default === "number", type: typeof schema.default as RuneDashboardField["type"] }} value={values[name]} />)}
        <button className="primary" type="submit">Save settings</button>
      </form></Card>;
    })}</div>
  </>;
}

export type Audit = { at: number; actor: string; target: string; operation: string; result: "Completed" | "Rejected" | "Queued" };
export function Activity({ rows }: { rows: Audit[] }) {
  return <Table title="Management activity" columns={["Time", "Owner", "Target", "Operation", "Result"]}
    rows={rows.slice().reverse().map((row, index) => ({ key: index, cells: [
      <Utc value={row.at} />, row.actor, row.target, row.operation, <Badge tone={row.result === "Rejected" ? "bad" : "good"}>{row.result}</Badge>,
    ] }))} empty="Management actions and settings changes will appear here." />;
}

export function Status({ children, back, failure }: { children: ReactNode; back: string; failure?: boolean }) {
  return <><p className={failure ? "note error" : "note"} role={failure ? "alert" : "status"}>{children}</p>
    <a className="button" href={back}>Go back</a></>;
}
