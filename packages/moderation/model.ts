import { StorageInputError } from "@rune/storage";

export const timedKinds = ["ban", "ipban", "mute", "freeze"] as const;
export const kinds = [...timedKinds, "kick", "warn", "note"] as const;
export type TimedKind = typeof timedKinds[number];
export type Kind = typeof kinds[number];
export type Identity = { id: string; name: string };
export type Review = { actor: Identity; reason: string; at: number };
export type Case = { id: number; kind: Kind; target: Identity; reason: string; actor: Identity; at: number;
  expiresAt?: number; revoked?: Review };
export type Report = { id: number; target: Identity; reporter: Identity; reason: string; at: number;
  assigned?: Identity; resolved?: Review };
export type Channel = { name: string; restricted: boolean; slowSeconds: number };
export type ChatPolicy = { locked?: { reason: string; expiresAt?: number }; slowSeconds?: number; lockdown?: { reason: string; expiresAt?: number } };
export type Audit = { actor: Identity; at: number; action: string };
export type ModerationState = {
  sequence: number; cases: Case[]; reports: Report[]; channels: Record<string, Channel>;
  policies: Record<string, ChatPolicy>; audit: Audit[];
};

export function initial(): ModerationState {
  return { sequence: 0, cases: [], reports: [], channels: {
    help: { name: "Help", restricted: false, slowSeconds: 2 },
    trade: { name: "Trade", restricted: false, slowSeconds: 10 },
  }, policies: {}, audit: [] };
}

export const fail = (message: string): never => { throw new StorageInputError(message); };
export const isTimed = (kind: Kind): kind is TimedKind => (timedKinds as readonly Kind[]).includes(kind);
export const inForce = (item: { expiresAt?: number }, now = Date.now()) =>
  item.expiresAt === undefined || item.expiresAt > now;
export const active = (item: Case, now = Date.now()) => isTimed(item.kind) && !item.revoked && inForce(item, now);
export const caseStatus = (item: Case) => item.revoked ? "Revoked" : active(item) ? "Active" : isTimed(item.kind) ? "Expired" : "Recorded";

export function details(value: string) {
  const reason = value.trim();
  if (!reason || reason.length > 240 || /[\r\n]/.test(reason)) fail("Enter a reason of 1–240 characters.");
  return reason;
}

export function recordCase(data: ModerationState, input: Omit<Case, "id" | "revoked">): Case {
  if (isTimed(input.kind) && data.cases.some((entry) => entry.kind === input.kind && entry.target.id === input.target.id && active(entry, input.at))) {
    fail("A matching punishment is already active. Revoke that case before issuing a replacement.");
  }
  if (input.expiresAt !== undefined && input.expiresAt <= input.at) fail("That duration has already elapsed.");
  const entry = { ...input, id: ++data.sequence };
  data.cases.push(entry);
  return entry;
}

export function revokeCase(data: ModerationState, id: number, review: Review): Case {
  const item = data.cases.find((entry) => entry.id === id);
  if (!item) return fail("Case not found.");
  if (item.revoked) return fail("That case has already been revoked.");
  if (isTimed(item.kind) && !active(item, review.at)) return fail("That punishment has expired.");
  item.revoked = review;
  return item;
}

export function recordReport(data: ModerationState, input: Omit<Report,"id">): Report {
  if (input.target.id === input.reporter.id) fail("Choose another player to report.");
  if (data.reports.some((row) => row.reporter.id === input.reporter.id && row.target.id === input.target.id && !row.resolved)) {
    fail("You already have an open report for that player.");
  }
  const report = { ...input, id: ++data.sequence };
  data.reports.push(report);
  return report;
}

export function editReport(data: ModerationState, id: number, actor: Identity, action: "claim" | "resolve" | "reopen", at: number, reason?: string) {
  const report = data.reports.find((entry) => entry.id === id);
  if (!report) return fail("Report not found.");
  if (action === "reopen") {
    if (!report.resolved) return fail("That report is already open.");
    delete report.resolved;
    delete report.assigned;
  } else {
    if (report.resolved) return fail("That report has already been closed.");
    if (action === "resolve") report.resolved = { actor, at, reason: details(reason ?? "") };
    else if (report.assigned) return fail(`That report is assigned to ${report.assigned.name}.`);
    else report.assigned = actor;
  }
  return report;
}

export function audit(data: ModerationState, actor: Identity, at: number, action: string) {
  data.audit = [...data.audit.slice(-499), { actor, at, action }];
}
