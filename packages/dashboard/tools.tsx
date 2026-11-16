/** @jsxImportSource react */
import { useId } from "react";
import { ChevronRight } from "lucide-react";
import { Card, Details, FormField } from "./ui.tsx";
import { asLink } from "./pages.tsx";

export type Contribution = ReturnType<RuneDashboardMonitor["contributions"]> extends Map<string, infer Value> ? Value : never;

type Operation = string | { id: string; key?: string; label?: string; defaults?: Record<string, RuneDashboardValue> };
export function Operations({ context, items, title = "Manage" }: { context: RuneDashboardPageContext; items: Operation[]; title?: string }) {
  const available = items.flatMap((item) => {
    const operation = typeof item === "string" ? { id: item } : item;
    const form = context.action(operation.id, operation.defaults);
    return form == null ? [] : [<details key={operation.key ?? operation.id} className="operation">
      <summary><ChevronRight size={16} aria-hidden="true" />{operation.label ?? operation.id.replaceAll("-", " ")}</summary>
      {form}
    </details>];
  });
  return available.length ? <section className="operations"><h2>{title}</h2>{available}</section> : null;
}

export function ActionForm({ module, action, csrf, defaults = {} }: {
  module: Contribution; action: string; csrf: string; defaults?: Record<string, RuneDashboardValue>;
}) {
  const actionSpec = module.actions.get(action);
  const legend = useId();
  if (!actionSpec) throw new Error("Dashboard action is unavailable: " + action);
  return <form className="card" method="post" aria-labelledby={legend} action={asLink(asLink("/tools", module.id) + "/actions", action)}>
    <input type="hidden" name="csrf" value={csrf} />
    <fieldset><legend id={legend}>{actionSpec.title}</legend>
      {actionSpec.description && <p>{actionSpec.description}</p>}
      {Object.entries(actionSpec.fields).map(([name, spec]) =>
        <FormField key={name} name={name} spec={spec} value={defaults[name] ?? spec.default} />)}
      {actionSpec.confirm && <p><label className="check"><input type="checkbox" name="confirm" value="yes" required />{actionSpec.confirm}</label></p>}
      <button className={actionSpec.confirm ? "danger" : "primary"} type="submit">{actionSpec.title}</button>
    </fieldset>
  </form>;
}

export function ToolHome({ module, metrics, metricsFailed, context }: {
  module: Contribution; metrics?: Record<string, RuneDashboardValue | null>; metricsFailed: boolean; context: RuneDashboardPageContext;
}) {
  const root = asLink("/tools", module.id);
  return <div className="stack">
    {module.pages.size > 0 && <Card title="Pages">
      <ul>{[...module.pages].map(([id, page]) => <li key={id}><a href={asLink(root, id)}>{page.title}</a></li>)}</ul>
    </Card>}
    {metricsFailed && <p role="alert" className="note error">This Rune’s metrics could not be read.</p>}
    {metrics && <Card title="Live metrics"><Details values={metrics} /></Card>}
    <Operations context={context} items={[...module.actions].map(([id, action]) => ({ id, label: action.title }))} />
  </div>;
}
