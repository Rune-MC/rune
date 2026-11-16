/** @jsxImportSource rune:dashboard */
import { Details, Card, Operations, Table } from "rune:dashboard";

type Options = { enabled: boolean; "interval-seconds": number };
export function registerDashboard(read: () => Record<string, string>, config: { read(): Options; update(changes: Partial<Options>): void },
  send: (name: string) => void, edit: (name: string, message?: string) => Promise<void>) {
  const id = { type: "string", label: "Announcement ID", required: true, maxLength: 32 } as const;
  return rune.dashboard.register({
    id: "announcements", title: "Announcements", navigation: [{ page: "messages" }],
    metrics: () => ({ "Saved messages": Object.keys(read()).length, Rotation: config.read().enabled, "Interval (seconds)": config.read()["interval-seconds"] }),
    pages: { messages: { title: "Announcements", render(context) {
      const data = read();
      const selected = context.query("id") ?? "";
      const message = Object.hasOwn(data, selected) ? data[selected] : undefined;
      const options = config.read();
      return <div className="stack">
        <Card title="Automatic rotation"><Details values={{ Enabled: options.enabled, "Interval (seconds)": options["interval-seconds"] }} /></Card>
        <Table title="Saved announcements" columns={["ID", "MiniMessage text"]} rows={Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
          key, cells: [<a href={context.href("messages") + "?id=" + encodeURIComponent(key)}>{key}</a>, value],
        }))} />
        <Operations context={context} items={[
          { id: "save", label: message === undefined ? "Create announcement" : "Update this announcement", defaults: message === undefined ? {} : { id: selected, message } },
          ...(message === undefined ? [] : [
            { id: "send", label: "Send this announcement", defaults: { id: selected } },
            { id: "delete", label: "Delete this announcement", defaults: { id: selected } },
          ]),
          { id: "rotation", label: "Configure rotation", defaults: { enabled: options.enabled, interval: options["interval-seconds"] } },
        ]} />
      </div>;
    } } },
    actions: {
      save: {
        title: "Save announcement", fields: { id, message: { type: "string", label: "MiniMessage text", required: true, multiline: true, maxLength: 400 } },
        async run({ id, message }) { await edit(String(id), String(message)); return `Saved announcement ${id}.`; },
      },
      send: {
        title: "Send announcement", confirm: "Send this announcement to players who opted in", fields: { id },
        run({ id }) { send(String(id)); return `Sent announcement ${id}.`; },
      },
      delete: {
        title: "Delete announcement", confirm: "Remove this saved announcement", fields: { id },
        async run({ id }) { await edit(String(id)); return `Deleted announcement ${id}.`; },
      },
      rotation: {
        title: "Configure rotation", fields: { enabled: { type: "boolean", label: "Rotate messages" },
          interval: { type: "number", label: "Seconds between announcements", min: 15, max: 3600, required: true } },
        run({ enabled, interval }) { config.update({ enabled: enabled === true, "interval-seconds": Number(interval) }); return "Updated rotation."; },
      },
    },
  });
}
