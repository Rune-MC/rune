/** @jsxImportSource react */
import { Card, Details, FormField } from "./ui.tsx";
import { asLink } from "./pages.tsx";

export type Contribution = ReturnType<RuneDashboardMonitor["contributions"]> extends Map<string, infer Value> ? Value : never;

export function ActionForm({ module, action, csrf, defaults = {} }: {
  module: Contribution; action: string; csrf: string; defaults?: Record<string, RuneDashboardValue>;
}) {
  const actionSpec = module.actions.get(action);
  if (!actionSpec) throw new Error("Dashboard action is unavailable: " + action);
  return <form className="card" method="post" action={asLink(asLink("/tools", module.id) + "/actions", action)}>
    <input type="hidden" name="csrf" value={csrf} />
    <fieldset><legend>{actionSpec.title}</legend>
      {actionSpec.description && <p>{actionSpec.description}</p>}
      {Object.entries(actionSpec.fields).map(([name, spec]) =>
        <FormField key={name} name={name} spec={spec} value={defaults[name] ?? spec.default} />)}
      {actionSpec.confirm && <p><label className="check"><input type="checkbox" name="confirm" value="yes" required />{actionSpec.confirm}</label></p>}
      <button className={actionSpec.confirm ? "danger" : "primary"} type="submit">{actionSpec.title}</button>
    </fieldset>
  </form>;
}

export function ToolHome({ module, metrics, metricsFailed, csrf }: {
  module: Contribution; metrics?: Record<string, RuneDashboardValue | null>; metricsFailed: boolean; csrf: string;
}) {
  const root = asLink("/tools", module.id);
  return <div className="stack">
    {module.pages.size > 0 && <Card title="Pages">
      <ul>{[...module.pages].map(([id, page]) => <li key={id}><a href={asLink(root, id)}>{page.title}</a></li>)}</ul>
    </Card>}
    {metricsFailed && <p role="alert" className="note error">This Rune’s metrics could not be read.</p>}
    {metrics && <Card title="Live metrics"><Details values={metrics} /></Card>}
    {module.actions.size > 0 && <div className="form-grid">{[...module.actions.keys()].map((id) =>
      <ActionForm key={id} module={module} action={id} csrf={csrf} />)}</div>}
  </div>;
}
