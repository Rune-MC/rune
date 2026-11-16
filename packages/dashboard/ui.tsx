/** @jsxImportSource react */
import { useId, type ReactNode } from "react";
import { NavIcon } from "./identity.tsx";
import type { Permission } from "./permissions.ts";
import type { Access } from "./users.ts";

export const number = (value?: number | null, digits = 1) =>
  value != null && Number.isFinite(value) ? new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(value) : "Unavailable";

export function bytes(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return number(value / 1024 ** unit) + " " + units[unit];
}

export function elapsed(value?: number | null) {
  if (value == null) return "Unavailable";
  const seconds = Math.floor(Math.max(0, value) / 1000);
  const whole = (count: number, unit: string) => count ? count + unit : "";
  return [whole(Math.floor(seconds / 86400), "d"), whole(Math.floor(seconds % 86400 / 3600), "h"),
    whole(Math.floor(seconds % 3600 / 60), "m"), seconds % 60 + "s"].filter(Boolean).join(" ");
}

export function Utc({ value }: { value: number }) {
  const iso = new Date(value).toISOString();
  return <time dateTime={iso}>{iso.replace("T", " ").slice(0, 19)} UTC</time>;
}

export function Badge({ children, tone = "" }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "" }) {
  return <span className={`badge dot ${tone}`}>{children}</span>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card"><h2>{title}</h2>{children}</section>;
}

export function Details({ values }: { values: Record<string, ReactNode> }) {
  return <dl>{Object.entries(values).map(([key, value]) => <Pair key={key} label={key} value={value} />)}</dl>;
}

function Pair({ label, value }: { label: string; value: ReactNode }) {
  return <><dt>{label}</dt><dd>{typeof value === "boolean" ? String(value) : value ?? "Unavailable"}</dd></>;
}

export function Table({ title, columns, rows, empty = "No entries to display." }: {
  title: string; columns: string[]; rows: { key: string | number; cells: ReactNode[] }[]; empty?: string;
}) {
  if (!rows.length) return <Card title={title}><p className="muted">{empty}</p></Card>;
  return <div className="table-wrapper" role="region" tabIndex={0} aria-label={title}>
    <table>
      <caption>{title}</caption>
      <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{rows.map(({ key, cells }) => <tr key={key}>
        <th scope="row">{cells[0]}</th>
        {cells.slice(1).map((cell, index) => <td key={columns[index + 1]} data-numeric={typeof cell === "number" || undefined}>{cell ?? "Unavailable"}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Shell({ title, subtitle, active, tools, children, interactive, access }: {
  title: string; subtitle?: string; active: string; tools: { href: string; label: string }[]; children: ReactNode; interactive?: boolean; access: Access;
}) {
  const items: [string, string, Permission][] = [
    ["/", "Overview", "overview:view"], ["/runes", "Runes", "runes:view"], ["/server", "Server", "server:view"], ["/players", "Players", "players:view"],
    ["/logs", "Logs", "logs:view"], ["/settings", "Settings", "settings:view"], ["/activity", "Activity", "activity:view"],
  ];
  const navigation = items.filter(([, , permission]) => access.allows(permission)).map(([href, label]) => [href, label]);
  if (access.owner) navigation.push(["/access", "Users & roles"]);
  navigation.push(["/account", "Account"]);
  return <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title + " · Rune"}</title>
      <link rel="stylesheet" href="/assets/dashboard.css" />
      {interactive && <script src="/assets/dashboard.js" defer />}
    </head>
    <body>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell">
        <aside className="sidebar">
          <a className="brand" href="/"><span className="brand-mark" aria-hidden="true" />Rune Console</a>
          <nav aria-label="Console">
            <div className="nav-section"><h2>Server</h2>
              {navigation.map(([href, label]) => <a key={href} href={href} aria-current={active === href ? "page" : undefined}><NavIcon path={href} />{label}</a>)}
            </div>
            {tools.length > 0 && <div className="nav-section"><h2>Rune tools</h2>
              {tools.map(({ href, label }) => <a key={href} href={href} aria-current={active === href ? "page" : undefined}><NavIcon path={href} />{label}</a>)}
            </div>}
          </nav>
        </aside>
        <main id="main">
          <header className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>
          {children}
        </main>
      </div>
    </body>
  </html>;
}

export function FormField({ name, spec, value }: {
  name: string; spec: RuneDashboardField; value?: RuneDashboardValue;
}) {
  const id = useId();
  const helpId = spec.description ? id + "-help" : undefined;
  const attributes = { id, name, required: spec.required, "aria-describedby": helpId };
  if (spec.type === "boolean") return <div className="field">
    <label className="check"><input {...attributes} type="checkbox" value="true" defaultChecked={value === true} />{spec.label ?? name}</label>
    {spec.description && <small id={helpId}>{spec.description}</small>}
  </div>;
  return <div className="field">
    <label htmlFor={id}>{spec.label ?? name}</label>
    {spec.description && <small id={helpId}>{spec.description}</small>}
    {spec.type === "string" && spec.player ? <div data-player-picker={spec.player} data-label={spec.label ?? name}>
      <input {...attributes} defaultValue={String(value ?? "")} maxLength={spec.maxLength ?? 36} placeholder="Player name or UUID"
        autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    </div> : spec.choices ? <select {...attributes} defaultValue={String(value ?? "")}>
      <option value="">Select a value</option>
      {Object.entries(spec.choices).map(([choice, label]) => <option key={choice} value={choice}>{label}</option>)}
    </select> : spec.type === "number" ?
      <input {...attributes} type="number" defaultValue={String(value ?? "")} step="any" min={spec.min} max={spec.max} /> :
      spec.multiline ? <textarea {...attributes} defaultValue={String(value ?? "")} maxLength={spec.maxLength ?? 4096} /> :
        <input {...attributes} defaultValue={String(value ?? "")} maxLength={spec.maxLength ?? 4096} />}
  </div>;
}
