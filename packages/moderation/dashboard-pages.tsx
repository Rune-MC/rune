/** @jsxImportSource rune:dashboard */
import { Card, Details, Operations, PlayerIdentity, Table } from "rune:dashboard";
import { channels, policy } from "./chat.ts";
import { active, caseStatus, kinds, type Case, type ModerationState } from "./model.ts";
import { directory, online, person } from "./platform.ts";

const date = (at: number) => new Date(at).toISOString().slice(0, 19).replace("T", " ") + " UTC";
const link = (context: RuneDashboardPageContext, page: string, id: string | number) =>
  context.href(page) + "?" + new URLSearchParams({ id: String(id) });
const search = (context: RuneDashboardPageContext) => context.query("q")?.trim().slice(0, 128) ?? "";

function CaseRows({ rows, context }: { rows: Case[]; context: RuneDashboardPageContext }) {
  return <Table title={`Cases · ${rows.length} found`} columns={["Case", "Action", "Target", "Reason", "State", "Created"]}
    rows={rows.slice(0, 150).map((row) => ({
      key: row.id, cells: [<a href={link(context, "cases", row.id)}>#{row.id}</a>, row.kind,
        row.kind === "ipban" ? row.target.name : <PlayerIdentity {...row.target} />, row.reason, caseStatus(row), date(row.at)],
    }))} />;
}

export function ReportPage(context: RuneDashboardPageContext, data: ModerationState) {
  const selected = data.reports.find((row) => row.id === Number(context.query("id")));
  const status = context.query("status") ?? "all";
  const q = search(context).toLowerCase();
  const rows = [...data.reports].reverse().filter((row) =>
    (status === "closed" ? row.resolved : status === "open" ? !row.resolved : true) &&
    (!q || [String(row.id), row.target.name, row.reporter.name, row.reason].some((value) => value.toLowerCase().includes(q))));
  return <div className="stack">
    <search aria-label="Filter reports"><form className="toolbar" action={context.href("reports")}>
      <label>Report ID, player, or reason<input name="q" defaultValue={q} maxLength={128} /></label>
      <label>Status<select name="status" defaultValue={status}><option value="all">All reports</option><option value="open">Open</option><option value="closed">Resolved</option></select></label>
      <button type="submit">Filter reports</button>
    </form></search>
    <Table title={`Reports · ${rows.length} found`} columns={["Report", "Target", "Reporter", "Reason", "Status"]}
      rows={rows.slice(0, 150).map((row) => ({
        key: row.id, cells: [<a href={link(context, "reports", row.id)}>#{row.id}</a>, <PlayerIdentity {...row.target} />,
          <PlayerIdentity {...row.reporter} />, row.reason, row.resolved ? "Resolved" : row.assigned ? "Claimed by " + row.assigned.name : "Open"],
      }))} />
    {selected && <>
      <Card title={`Report #${selected.id}`}><Details values={{ Created: date(selected.at), Reason: selected.reason,
        "Assigned to": selected.assigned?.name ?? "Unassigned", Resolution: selected.resolved?.reason ?? "—",
        "Resolved by": selected.resolved?.actor.name ?? "—", "Resolved at": selected.resolved ? date(selected.resolved.at) : "—" }} /></Card>
      <Operations context={context} items={[{ id: "review-report", label: "Review report", defaults: { report: selected.id, operation: selected.resolved ? "reopen" : selected.assigned ? "resolve" : "claim" } }]} />
    </>}
  </div>;
}

export function CasePage(context: RuneDashboardPageContext, data: ModerationState) {
  const selected = data.cases.find((row) => row.id === Number(context.query("id")));
  const kind = context.query("kind") ?? "";
  const q = search(context);
  const activeOnly = context.query("active") === "yes";
  const rows = [...data.cases].reverse().filter((row) =>
    (!kind || row.kind === kind) && (!activeOnly || active(row)) &&
    (!q || [row.target.name, row.target.id, row.reason, String(row.id)].some((value) => value.toLowerCase().includes(q.toLowerCase()))));
  return <div className="stack">
    <search aria-label="Filter cases"><form className="toolbar" action={context.href("cases")}>
      <label>Search cases<input name="q" defaultValue={q} maxLength={128} /></label>
      <label>Action<select name="kind" defaultValue={kind}><option value="">All actions</option>{kinds.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="check"><input type="checkbox" name="active" value="yes" defaultChecked={activeOnly} />Active only</label>
      <button type="submit">Filter cases</button>
    </form></search>
    <CaseRows rows={rows} context={context} />
    {selected && <Card title={`Case #${selected.id}`}><Details values={{ Target: selected.target.name, Action: selected.kind, Reason: selected.reason,
      Actor: selected.actor.name, Created: date(selected.at), State: caseStatus(selected), Expires: selected.expiresAt ? date(selected.expiresAt) : "—",
      "Revoked by": selected.revoked?.actor.name ?? "—", "Revocation reason": selected.revoked?.reason ?? "—" }} /></Card>}
    <Operations context={context} items={[
      { id: "issue-case", label: "Issue moderation action" },
      { id: "ip-ban", label: "Ban IP address" },
      ...(selected && active(selected) ? [{ id: "revoke-case", label: "Revoke this punishment", defaults: { case: selected.id } }] : []),
    ]} />
  </div>;
}

export function PlayersPage(context: RuneDashboardPageContext, data: ModerationState) {
  const id = context.query("id");
  const q = search(context);
  const players = directory().filter((row) => (row.name + " " + row.id).toLowerCase().includes(q.toLowerCase()));
  let selected: ReturnType<typeof person> | undefined;
  if (id) {
    try { selected = person(id); }
    catch { return <p role="alert">Player was not found.</p>; }
  }
  const live = selected ? online(selected.id) : undefined;
  const location = live?.getLocation();
  return <div className="stack">
    <search aria-label="Find players"><form className="toolbar" action={context.href("players")}>
      <label>Player name or UUID<input name="q" defaultValue={q} maxLength={128} /></label><button type="submit">Find players</button>
    </form></search>
    <Table title={`Players · ${players.length} found`} columns={["Player", "UUID"]} rows={players.slice(0, 100).map((row) => ({
      key: row.id, cells: [<a href={link(context, "players", row.id)}><PlayerIdentity {...row} /></a>, row.id],
    }))} />
    {selected && <>
      <Card title={selected.name}><Details values={{ UUID: selected.id, Status: live ? "Online" : "Offline",
        ...(live && location ? { World: location.getWorld().getName(), Position: [location.getBlockX(), location.getBlockY(), location.getBlockZ()].join(", "),
          "Game mode": String(live.getGameMode()), "Ping (ms)": live.getPing() } : {}) }} /></Card>
      <Card title={`Moderation history · ${selected.name}`}><CaseRows context={context} rows={[...data.cases].reverse().filter((row) => row.target.id === selected.id)} /></Card>
      <Operations context={context} items={[
        { id: "issue-case", label: "Issue moderation action", defaults: { target: selected.id } },
        ...(live ? [{ id: "teleport-staff", label: "Teleport staff to this player", defaults: { target: selected.id } }] : []),
      ]} />
    </>}
  </div>;
}

export function ChatPage(context: RuneDashboardPageContext) {
  const all = channels();
  const channel = context.query("id") ?? "";
  const selected = channel !== "global" && channel !== "staff" && Object.hasOwn(all, channel) ? all[channel] : undefined;
  const current = policy();
  const policyLabel = (value: typeof current.locked) => value ? value.reason + " · " + (value.expiresAt ? date(value.expiresAt) : "Permanent") : "Disabled";
  return <div className="stack">
    <Card title="Server chat policy"><Details values={{ "Public chat lock": policyLabel(current.locked), "Join lockdown": policyLabel(current.lockdown),
      "Global slow mode": (current.slowSeconds ?? 0) + "s" }} /></Card>
    <Table title="Chat channels" columns={["Channel", "Name", "Access", "Slow mode"]} rows={Object.entries(all).map(([id, row]) => ({
      key: id, cells: [id === "global" || id === "staff" ? id : <a href={link(context, "chat", id)}>{id}</a>,
        row.name, row.restricted ? "Permission required" : "Public", row.slowSeconds + "s"],
    }))} />
    <Operations context={context} items={[
      { id: "save-channel", label: selected ? "Update this channel" : "Create custom channel",
        defaults: selected ? { channel, name: selected.name, delay: selected.slowSeconds, restricted: selected.restricted } : { delay: 0 } },
      ...(selected ? [{ id: "delete-channel", label: "Delete this channel", defaults: { channel } }] : []),
      { id: "slow-mode", label: "Set global slow mode", defaults: { seconds: current.slowSeconds ?? 0 } },
      { id: "set-lock", label: "Set chat lock or join lockdown" }, { id: "clear-chat", label: "Clear chat" },
    ]} />
  </div>;
}

export function AuditPage(data: ModerationState) {
  return <Table title="Recent moderation actions" columns={["Time", "Actor", "Action"]}
    rows={[...data.audit].reverse().map((row, index) => ({ key: index, cells: [date(row.at), <PlayerIdentity {...row.actor} />, row.action] }))} />;
}
