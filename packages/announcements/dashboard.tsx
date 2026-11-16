/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";

export function registerDashboard(read: () => Record<string, string>, settings: () => { enabled: boolean; "interval-seconds": number },
  send: (name: string) => void) {
  return rune.dashboard.register({
    id: "announcements", title: "Announcements", navigation: [{ page: "messages" }],
    metrics: () => ({ "Saved messages": Object.keys(read()).length, Rotation: settings().enabled, "Interval (seconds)": settings()["interval-seconds"] }),
    pages: {
      messages: { title: "Announcements", render(context) {
        const entries = Object.entries(read()).sort(([a], [b]) => a.localeCompare(b));
        const selected = context.query("id");
        return <div className="stack">
          <Table title="Saved announcements" columns={["ID", "MiniMessage text"]} rows={entries.map(([id, message]) => ({
            key: id, cells: [<a href={context.href("messages") + "?id=" + encodeURIComponent(id)}>{id}</a>, message],
          }))} />
          {selected && Object.hasOwn(read(), selected) && context.action("send", { id: selected })}
        </div>;
      } },
    },
    actions: { send: {
      title: "Send announcement", confirm: "Send this announcement to players who opted in",
      fields: { id: { type: "string", label: "Announcement ID", required: true, maxLength: 32 } },
      run({ id }) { send(String(id)); return `Sent ${id}.`; },
    } },
  });
}
