import { matchesScope, reachable, type Context, type Label, type PermissionState, type Rule, type Scoped } from "./model.ts";

interface Origin { source: string; weight: number; direct: boolean }
type Candidate<T> = T & Origin;
type PermissionResult = { allowed: boolean; source: string; node: string };
const specificity = (value: Scoped) => Number(Boolean(value.context?.world)) + Number(Boolean(value.context?.server));
const compareScope = (a: Scoped, b: Scoped) => specificity(b) - specificity(a);
const compareOrigin = (a: Origin, b: Origin) => Number(b.direct) - Number(a.direct);
const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const deterministic = (a: Origin, b: Origin) => b.weight - a.weight || byName(a.source, b.source);
const patterns = (node: string) => {
  const result = [node];
  for (let i = node.lastIndexOf("."); i >= 0; i = node.lastIndexOf(".", i - 1)) {
    if (i === 0) break;
    result.push(node.slice(0, i) + ".*");
  }
  result.push("*");
  return result;
};

export function resolveProfile(data: PermissionState, id: string, context: Context = {}, now = Date.now()) {
  const user = data.players?.[id];
  const lookup = new Map(Object.entries(data.groups));
  const roots = [
    ...(data.members[id] ?? []),
    ...(user?.grants ?? []).filter((grant) => matchesScope(grant, context, now)).map((grant) => grant.group),
  ].filter((group) => lookup.has(group));
  const sortGroup = (a: string, b: string) => (lookup.get(b)?.weight ?? 0) - (lookup.get(a)?.weight ?? 0) || byName(a, b);
  const groups = [...reachable(lookup, ["default", ...roots])].sort(sortGroup);
  const primary = user?.primary && groups.includes(user.primary) ? user.primary : roots.sort(sortGroup)[0] ?? "default";
  const rules = new Map<string, Array<Candidate<Rule>>>();
  const labels: Record<"prefix" | "suffix", Array<Candidate<Label>>> = { prefix: [], suffix: [] };
  function add(rule: Rule, origin: Origin) {
    if (!matchesScope(rule, context, now)) return;
    const current = rules.get(rule.node);
    const value = { ...rule, ...origin };
    if (current) current.push(value);
    else rules.set(rule.node, [value]);
  }
  function decoration(origin: Origin, profile?: { prefix?: Label[]; suffix?: Label[] }) {
    for (const kind of ["prefix", "suffix"] as const) {
      for (const label of profile?.[kind] ?? []) {
        if (matchesScope(label, context, now)) labels[kind].push({ ...label, ...origin });
      }
    }
  }
  for (const source of groups) {
    const group = lookup.get(source)!;
    const origin = { source, weight: group.weight ?? 0, direct: false };
    for (const [node, allow] of Object.entries(group.rules)) add({ node, allow }, origin);
    for (const rule of group.profile?.rules ?? []) add(rule, origin);
    decoration(origin, group.profile);
  }
  const direct = { source: "player", weight: 0, direct: true };
  for (const rule of user?.rules ?? []) add(rule, direct);
  decoration(direct, user);

  function explain(input: string): PermissionResult | undefined {
    const node = input.toLowerCase();
    const all = patterns(node).flatMap((pattern) => rules.get(pattern) ?? []);
    const best = all.sort((a, b) => compareOrigin(a, b) || compareScope(a, b) ||
      Number(!b.node.endsWith("*")) - Number(!a.node.endsWith("*")) ||
      b.node.length - a.node.length || b.weight - a.weight || Number(a.allow) - Number(b.allow) ||
      byName(a.source, b.source))[0];
    return best && { allowed: best.allow, source: best.source, node: best.node };
  }
  function exactRules(registered: Iterable<string> = []) {
    const concrete = [...rules.keys()].filter((node) => !node.endsWith("*"));
    const expand = concrete.length !== rules.size;
    const nodes = new Set(expand ? [...concrete, ...registered] : concrete);
    const result = new Map<string, boolean>();
    for (const node of nodes) {
      const match = explain(node);
      if (match) result.set(node, match.allowed);
    }
    return result;
  }
  function style(kind: "prefix" | "suffix", stack = false) {
    const items = labels[kind].sort((a, b) => b.priority - a.priority || compareScope(a, b) ||
      compareOrigin(a, b) || deterministic(a, b));
    const sources = new Set<string>();
    const text = new Set<string>();
    for (const item of items) {
      const source = item.direct ? "" : item.source;
      if (sources.has(source) || text.has(item.text)) continue;
      sources.add(source);
      text.add(item.text);
      if (!stack) break;
    }
    return [...text];
  }
  return { groups, primary, explain, exactRules, style };
}

export function nextExpiration(data: PermissionState, now: number) {
  let next = Infinity;
  function visit(values?: Scoped[]) {
    for (const value of values ?? []) {
      if (value.expiresAt !== undefined && value.expiresAt > now) next = Math.min(next, value.expiresAt);
    }
  }
  for (const access of [...Object.values(data.groups).map((group) => group.profile), ...Object.values(data.players ?? {})]) {
    visit(access?.prefix);
    visit(access?.suffix);
    visit(access?.rules);
  }
  for (const player of Object.values(data.players ?? {})) visit(player.grants);
  return next;
}
