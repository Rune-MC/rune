/** @jsxImportSource rune:dashboard */
import { active, caseStatus, type ModerationState } from "./model.ts";

export function ModerationSummary(context: RuneDashboardPageContext, data: ModerationState) {
  const open = data.reports.filter((report) => !report.resolved).length;
  return <><p>{open} open reports · {data.cases.filter((entry) => active(entry)).length} active punishments</p>
    <a href={context.href("reports")}>Review player reports</a></>;
}

export function ReportPage(context: RuneDashboardPageContext, data: ModerationState) {
  const reports = data.reports.slice().sort((left, right) =>
    Number(Boolean(left.resolved)) - Number(Boolean(right.resolved)) || right.id - left.id).slice(0, 50);
  const selectedId = Number(context.query("id"));
  const selected = reports.find((report) => report.id === selectedId && !report.resolved);
  return <div className="stack">
    {reports.length === 0 ? <p>No reports have been submitted.</p> :
      <div className="table-wrapper" role="region" tabIndex={0} aria-label="Recent player reports">
        <table><caption>Recent player reports</caption><thead><tr>
          {["Report", "Target", "Reporter", "Reason", "Status"].map((heading) => <th key={heading} scope="col">{heading}</th>)}
        </tr></thead><tbody>{reports.map((report) => <tr key={report.id}>
          <th scope="row">{report.resolved ? `#${report.id}` : <a href={context.href("reports") + "?id=" + report.id}>#{report.id}</a>}</th>
          <td>{report.target.name}</td><td>{report.reporter.name}</td><td>{report.reason}</td>
          <td>{report.resolved ? "Resolved" : report.assigned ? "Assigned to " + report.assigned.name : "Open"}</td>
        </tr>)}</tbody></table>
      </div>}
    {selected && <section className="stack"><h2>Resolve report #{selected.id}</h2>
      <p>{selected.reason}</p>{context.action("resolve-report", { report: selected.id })}
    </section>}
  </div>;
}

export function CasePage(data: ModerationState) {
  const cases = data.cases.slice(-50).reverse();
  if (!cases.length) return <p>No moderation cases have been recorded.</p>;
  return <div className="table-wrapper" role="region" aria-label="Recent moderation cases" tabIndex={0}>
    <table><caption>Recent moderation cases</caption><thead><tr>
      {["Case", "Action", "Target", "Reason", "State", "Created"].map((heading) => <th key={heading} scope="col">{heading}</th>)}
    </tr></thead><tbody>{cases.map((entry) => <tr key={entry.id}>
      <th scope="row">#{entry.id}</th><td>{entry.kind}</td><td>{entry.target.name}</td><td>{entry.reason}</td>
      <td>{caseStatus(entry)}</td><td><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toISOString()}</time></td>
    </tr>)}</tbody></table>
  </div>;
}
