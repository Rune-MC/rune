/** @jsxImportSource rune:dashboard */
import { Card, Details, Operations, PlayerIdentity, Table } from "rune:dashboard";
import { backend } from "./backend.ts";
import { enabled, scopes, templateFor } from "./chat-format.ts";
import { permissionActions } from "./dashboard-actions.ts";
import type { Access, Context, PermissionState, Scoped } from "./model.ts";
import { directory, target } from "./players.ts";
import { resolveProfile } from "./resolve.ts";
import { server } from "./settings.ts";

const link = (context: RuneDashboardPageContext, page: string, id: string) =>
  context.href(page) + "?" + new URLSearchParams({ id });
const date = (time?: number) => time === undefined ? "Permanent" : new Date(time).toISOString().slice(0, 19).replace("T", " ") + " UTC";
const scope = (value?: Context) => Object.entries(value ?? {}).map(([key, name]) => key + "=" + name).join(",") || "global";

function AccessRows({ access, existing = {} }: { access?: Access; existing?: Record<string, boolean> }) {
  const rules = [...Object.entries(existing).map(([node, allow]) => ({ node, allow }) as NonNullable<Access["rules"]>[number]), ...(access?.rules ?? [])];
  const labels = (["prefix", "suffix"] as const).flatMap((kind) => (access?.[kind] ?? []).map((label) => ({ kind, ...label })));
  const key = (id: string | number, row: Scoped) => id + ":" + scope(row.context);
  return <>
    <Table title="Permission rules" columns={["Node", "Decision", "Context", "Expires"]} rows={rules.map((row) => ({
      key: key(row.node, row), cells: [row.node, row.allow ? "Allow" : "Deny", scope(row.context), date(row.expiresAt)],
    }))} />
    <Table title="Prefixes and suffixes" columns={["Type", "Priority", "MiniMessage", "Context", "Expires"]} rows={labels.map((row) => ({
      key: key(row.kind + row.priority, row), cells: [row.kind, row.priority, row.text, scope(row.context), date(row.expiresAt)],
    }))} />
  </>;
}

function groupsPage(context: RuneDashboardPageContext, data: PermissionState) {
  const group = context.query("id") ?? "";
  const selected = Object.hasOwn(data.groups, group) ? data.groups[group] : undefined;
  const defaults = { subject: group };
  return <div className="stack">
    <Table title="Groups" columns={["Group", "Weight", "Parents", "Rules"]} rows={Object.entries(data.groups).map(([id, row]) => ({
      key: id, cells: [<a href={link(context, "groups", id)}>{id}</a>, row.weight ?? 0,
        row.parents.join(", ") || "—", Object.keys(row.rules).length + (row.profile?.rules?.length ?? 0)],
    }))} />
    {selected && <><AccessRows access={selected.profile} existing={selected.rules} />
      <Operations title={`Manage ${group}`} context={context} items={[
        { id: "weight", label: "Set weight", defaults: { group, weight: selected.weight ?? 0 } },
        { id: "inheritance", label: "Edit inheritance", defaults: { group } },
        { id: "group-rule", label: "Edit permission rule", defaults }, { id: "group-decoration", label: "Edit prefix or suffix", defaults },
        ...(group === "default" ? [] : [{ id: "delete-group", label: "Delete group", defaults: { group } }]),
      ]} /></>}
    <Operations context={context} title="Groups" items={["create-group"]} />
  </div>;
}

function playersPage(context: RuneDashboardPageContext, data: PermissionState) {
  const id = context.query("id") ?? "";
  const q = context.query("q")?.slice(0, 128) ?? "";
  const selected = id ? target(id) : undefined;
  const world = context.query("world")?.slice(0, 80) || selected?.world;
  const serverName = context.query("server")?.slice(0, 80) || server;
  const node = context.query("node")?.slice(0, 128).trim() ?? "";
  const access = selected && data.players?.[selected.id];
  const effective = selected && resolveProfile(data, selected.id, { server: serverName, world });
  const match = effective && node ? effective.explain(node) : undefined;
  const players = directory().filter((person) => person.name.toLowerCase().includes(q.toLowerCase()) || person.id.includes(q.toLowerCase()));
  return <div className="stack">
    <search aria-label="Find permission profiles"><form className="toolbar" action={context.href("players")}>
      <label>Player name or UUID<input name="q" defaultValue={q} maxLength={128} /></label><button type="submit">Find players</button>
    </form></search>
    <Table title={`Players · ${players.length} found`} columns={["Player", "Status", "Groups"]} rows={players.slice(0, 100).map((row) => ({
      key: row.id, cells: [<a href={link(context, "players", row.id)}><PlayerIdentity {...row} /></a>, row.online ? "Online" : "Offline",
        data.members[row.id]?.join(", ") || "default"],
    }))} />
    {selected && effective && <>
      <Card title={`Effective access · ${selected.name}`}>
        <Details values={{ "Primary group": effective.primary, Groups: effective.groups.join(", "), Prefix: effective.style("prefix").join(" ") || "—",
          Suffix: effective.style("suffix").join(" ") || "—" }} />
        <search aria-label="Check a permission"><form className="toolbar" action={context.href("players")}>
          <input type="hidden" name="id" value={selected.id} />
          <label>Permission node<input name="node" defaultValue={node} maxLength={128} required /></label>
          <label>Server<input name="server" defaultValue={serverName} maxLength={80} /></label>
          <label>World<input name="world" defaultValue={world} maxLength={80} /></label>
          <button type="submit">Check permission</button>
        </form></search>
        {node && <p>{match ? `${match.allowed ? "Allowed" : "Denied"} by ${match.source} (${match.node}).` : "No Rune Permissions rule matches this node."}</p>}
      </Card>
      <Table title="Group grants" columns={["Group", "Context", "Expires"]} rows={[
        ...(data.members[selected.id] ?? []).map((group) => ({ group } as NonNullable<NonNullable<PermissionState["players"]>[string]["grants"]>[number])),
        ...(access?.grants ?? []),
      ].map((row) => ({ key: row.group + ":" + scope(row.context), cells: [row.group, scope(row.context), date(row.expiresAt)] }))} />
      <AccessRows access={access} />
      <Operations context={context} title={`Manage ${selected.name}`} items={[
        ...["membership", "primary", "move-rank"].map((action, index) => ({ id: action, label: ["Grant or revoke group", "Set primary group", "Promote or demote"][index],
          defaults: { player: selected.id, ...(action === "primary" && access?.primary ? { group: access.primary } : {}) } })),
        { id: "player-rule", label: "Edit direct permission", defaults: { subject: selected.id } },
        { id: "player-decoration", label: "Edit prefix or suffix", defaults: { subject: selected.id } },
      ]} />
    </>}
  </div>;
}

export function registerDashboard() {
  return rune.dashboard.register({
    id: "permissions", title: "Permissions",
    navigation: [{}, { page: "groups" }, { page: "players", label: "Permission profiles" }, { page: "tracks" }, { page: "chat" }],
    metrics: () => {
      const data = backend.value();
      return { Groups: Object.keys(data.groups).length, Tracks: Object.keys(data.tracks ?? {}).length,
        "Player profiles": new Set([...Object.keys(data.members), ...Object.keys(data.players ?? {})]).size, "Chat formats": scopes().length };
    },
    pages: {
      groups: { title: "Permission groups", render: (context) => groupsPage(context, backend.value()) },
      players: { title: "Permission profiles", render: (context) => playersPage(context, backend.value()) },
      tracks: { title: "Promotion tracks", render(context) {
        const tracks = backend.value().tracks ?? {};
        const track = context.query("id") ?? "";
        return <div className="stack">
          <Table title="Tracks" columns={["Track", "Group order"]} rows={Object.entries(tracks).map(([name, groups]) => ({
            key: name, cells: [<a href={link(context, "tracks", name)}>{name}</a>, groups.join(" → ")],
          }))} />
        <Operations context={context} items={[
            { id: "save-track", label: "Save promotion track", defaults: Object.hasOwn(tracks, track) ? { track, groups: tracks[track].join(", ") } : {} },
            ...(Object.hasOwn(tracks, track) ? [
              { id: "delete-track", label: "Delete track", defaults: { track } },
              { id: "move-rank", label: "Promote or demote player", defaults: { track } },
            ] : []),
          ]} />
        </div>;
      } },
      chat: { title: "Chat formats", render(context) {
        const selected = context.query("id") ?? "";
        const formats = scopes();
        return <div className="stack">
          <Table title={enabled() ? "Chat formatting enabled" : "Chat formatting disabled"} columns={["Scope", "MiniMessage template"]} rows={formats.map((id) => ({
            key: id, cells: [<a href={link(context, "chat", id)}>{id}</a>, templateFor(id)],
          }))} />
          <Operations context={context} items={[
            ...(formats.includes(selected) ? [
              { id: "format", label: "Edit chat format", defaults: { scope: selected, template: templateFor(selected) } },
              { id: "preview-format", label: "Preview chat text", defaults: { scope: selected, template: templateFor(selected) } },
              { id: "reset-format", label: "Reset chat format", defaults: { scope: selected } },
            ] : []),
            { id: "enable-formatting", label: "Set chat formatting status", defaults: { enabled: enabled() } },
          ]} />
        </div>;
      } },
      audit: { title: "Permissions audit", render: () => <Table title="Recent permission changes" columns={["Time", "Actor", "Change"]}
        rows={[...(backend.value().audit ?? [])].reverse().map((row, index) => ({ key: index, cells: [date(row.at), row.actor, row.action] }))} /> },
    },
    actions: permissionActions,
  });
}
