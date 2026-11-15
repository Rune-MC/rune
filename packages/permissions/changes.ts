import { emptyGroup, reachable, replaceWhere, type Context, type Grant, type Label, type PermissionState, type Rule } from "./model.ts";
import { fail, group, groupAccess, matchesContext, named, playerAccess } from "./validation.ts";

export type Subject = { type: "group" | "player"; id: string };
export type LabelKind = "prefix" | "suffix";
type Change = (data: PermissionState) => void;

export function trackRank(steps: string[], memberships: Set<string>) {
  for (let index = steps.length - 1; index >= 0; index--) {
    if (memberships.has(steps[index])) return index;
  }
  return -1;
}

export const createGroup = (name: string): Change => (data) => {
  const id = named(name);
  if (Object.hasOwn(data.groups, id)) fail("Group already exists.");
  data.groups[id] = emptyGroup();
};

export const deleteGroup = (name: string): Change => (data) => {
  const { id } = group(data, name);
  if (id === "default") fail("The default group is required.");
  delete data.groups[id];
  for (const value of Object.values(data.groups)) value.parents = value.parents.filter((parent) => parent !== id);
  for (const [member, ranks] of Object.entries(data.members)) {
    const kept = ranks.filter((rank) => rank !== id);
    if (kept.length) data.members[member] = kept;
    else delete data.members[member];
  }
  for (const user of Object.values(data.players ?? {})) {
    if (user.primary === id) delete user.primary;
    if (user.grants) user.grants = user.grants.filter((grant) => grant.group !== id);
  }
  for (const [key, steps] of Object.entries(data.tracks ?? {})) {
    const kept = steps.filter((step) => step !== id);
    if (kept.length) data.tracks![key] = kept;
    else delete data.tracks![key];
  }
};

export const groupWeight = (name: string, weight: number): Change => (data) => {
  group(data, name).value.weight = weight;
};

export const inherit = (name: string, parent: string, enabled: boolean): Change => (data) => {
  const child = group(data, name);
  const parentId = group(data, parent).id;
  const parents = new Set(child.value.parents);
  if (enabled) {
    if (reachable(new Map(Object.entries(data.groups)), [parentId]).has(child.id)) fail("That inheritance would create a cycle.");
    parents.add(parentId);
  } else parents.delete(parentId);
  child.value.parents = [...parents];
};

function removeRule(data: PermissionState, subject: Subject, node: string, context?: Context) {
  if (subject.type === "group" && !context) delete group(data, subject.id).value.rules[node];
  const access = subject.type === "group" ? groupAccess(data, subject.id) : playerAccess(data, subject.id);
  access.rules = replaceWhere(access.rules, (rule) => rule.node === node && matchesContext(rule, context));
  return access;
}

export const setRule = (subject: Subject, node: string, context?: Context, value?: Rule, previous?: Rule | null): Change => (data) => {
  const current = (key: string, scope?: Context) => {
    const holder = subject.type === "group" ? group(data, subject.id).value : undefined;
    const access = holder ? holder.profile : data.players?.[subject.id];
    const found = access?.rules?.find((rule) => rule.node === key && matchesContext(rule, scope));
    if (found) return found;
    if (holder && !scope && Object.hasOwn(holder.rules, key)) return { node: key, allow: holder.rules[key], expiresAt: undefined };
    return undefined;
  };
  if (previous) {
    const old = current(previous.node, previous.context);
    if (!old || old.allow !== previous.allow || old.expiresAt !== previous.expiresAt) fail("This rule changed. Reopen it and try again.");
    removeRule(data, subject, previous.node, previous.context);
  }
  if (previous !== undefined && current(node, context)) fail("A rule already uses that node and context.");
  const access = removeRule(data, subject, node, context);
  if (value) access.rules!.push(value);
};

export const setLabel = (subject: Subject, kind: LabelKind, priority: number, context?: Context, value?: Label, previous?: Label | null): Change => (data) => {
  const access = subject.type === "group" ? groupAccess(data, subject.id) : playerAccess(data, subject.id);
  const matches = (label: Label, id: number, scope?: Context) => label.priority === id && matchesContext(label, scope);
  if (previous) {
    const old = access[kind]?.find((label) => matches(label, previous.priority, previous.context));
    if (!old || old.text !== previous.text || old.expiresAt !== previous.expiresAt) fail("This label changed. Reopen it and try again.");
    access[kind] = replaceWhere(access[kind], (label) => matches(label, previous.priority, previous.context));
  }
  if (previous !== undefined && access[kind]?.some((label) => matches(label, priority, context))) fail("A label already uses that priority and context.");
  access[kind] = replaceWhere(access[kind], (label) => matches(label, priority, context), value);
};

export const membership = (id: string, name: string, enabled: boolean): Change => (data) => {
  const rank = group(data, name).id;
  if (rank === "default") fail("Everyone already belongs to default.");
  const memberships = new Set(data.members[id] ?? []);
  if (enabled) memberships.add(rank);
  else memberships.delete(rank);
  if (memberships.size) data.members[id] = [...memberships];
  else delete data.members[id];
};

export const grant = (id: string, name: string, context?: Context, expiresAt?: number, revoke = false): Change => (data) => {
  const rank = group(data, name).id;
  if (rank === "default") fail("Everyone already belongs to default.");
  if (!context) membership(id, rank, !revoke && expiresAt === undefined)(data);
  const user = playerAccess(data, id);
  user.grants = replaceWhere(user.grants, (entry) => entry.group === rank && matchesContext(entry, context),
    revoke || (!context && expiresAt === undefined) ? undefined : { group: rank, context, expiresAt });
};

export const editGrant = (id: string, next?: Grant, previous?: Grant): Change => (data) => {
  const find = (entry: Grant): Grant | undefined => {
    const existing = data.players?.[id]?.grants?.find((grant) => grant.group === entry.group && matchesContext(grant, entry.context));
    if (existing) return existing;
    if (!entry.context && data.members[id]?.includes(entry.group)) return { group: entry.group };
    return undefined;
  };
  if (previous) {
    const old = find(previous);
    if (!old || old.expiresAt !== previous.expiresAt) fail("This grant changed. Reopen it and try again.");
    grant(id, previous.group, previous.context, undefined, true)(data);
  }
  if (next) {
    if (find(next)) fail("A grant already uses that group and context.");
    grant(id, next.group, next.context, next.expiresAt)(data);
  }
};

export const primary = (id: string, name?: string): Change => (data) => {
  const access = playerAccess(data, id);
  if (name) access.primary = group(data, name).id;
  else delete access.primary;
};

export const setTrack = (name: string, groups: string[], previous?: string[] | null): Change => (data) => {
  const id = named(name);
  const tracks = data.tracks ??= {};
  if (previous === null && Object.hasOwn(tracks, id)) fail("That track already exists.");
  if (previous && JSON.stringify(tracks[id]) !== JSON.stringify(previous)) fail("This track changed. Reopen it and try again.");
  const steps = groups.map((key) => group(data, key).id);
  if (!steps.length || steps.length > 32 || new Set(steps).size !== steps.length || steps.includes("default")) {
    fail("Use 1–32 different groups excluding default.");
  }
  tracks[id] = steps;
};

export const deleteTrack = (name: string, previous?: string[]): Change => (data) => {
  const id = named(name);
  if (!Object.hasOwn(data.tracks ?? {}, id)) fail("Unknown promotion track.");
  if (previous && JSON.stringify(data.tracks![id]) !== JSON.stringify(previous)) fail("This track changed. Reopen it and try again.");
  delete data.tracks![id];
};

export const moveTrack = (id: string, track: string, step: 1 | -1, previousSteps?: string[], previousRank?: number): Change => (data) => {
  const name = named(track);
  const steps = Object.hasOwn(data.tracks ?? {}, name) ? data.tracks![name] : undefined;
  if (!steps?.length) fail("Unknown promotion track.");
  const prior = new Set(data.members[id] ?? []);
  const old = trackRank(steps, prior);
  if (previousSteps && (JSON.stringify(steps) !== JSON.stringify(previousSteps) || old !== previousRank)) {
    fail("The track or player rank changed. Reopen it and try again.");
  }
  if ((step === -1 && old === -1) || (step === 1 && old === steps.length - 1)) fail("Player is already at the end of this track.");
  for (const oldRank of steps) prior.delete(oldRank);
  const destination = steps[old + step];
  if (destination) prior.add(destination);
  if (prior.size) data.members[id] = [...prior];
  else delete data.members[id];
};
