import { createHash, randomBytes } from "node:crypto";
import { document, type RecordStore, type StoredRecord } from "@rune/storage";
import { authAccountKey, normalizeLogin, revokeAccountSessions } from "@rune/web-auth";
import { builtInRoles, permissionsFor, type Permission, type Role } from "./permissions.ts";

export const namespace = "rune-dashboard";
export const ownerSlot = namespace + ":owner";
type Invite = { digest: string; expiresAt: number };
type Member = { login: string; roles: string[]; disabled: boolean; createdAt: number; invitation?: Invite; credential?: StoredRecord };
type Directory = { members: Record<string, Member>; roles: Role[] };
type LegacyOwner = { lookup: string; value: string };
export type DashboardUser = Omit<Member, "credential" | "invitation"> & { status: "active" | "disabled" | "invited" | "expired"; expiresAt?: number };
export type Access = { owner: boolean; roles: string[]; allows(permission: Permission): boolean };

export class AccessInputError extends Error {}
const fail = (message: string): never => { throw new AccessInputError(message); };
const keyFor = (login: string) => authAccountKey(namespace, login);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerValue = (row: StoredRecord) => JSON.parse(row.value) as LegacyOwner;
const accountId = (row: StoredRecord) => (JSON.parse(row.value) as { id: string }).id;
const rolesFor = (state: Directory) => [...builtInRoles, ...state.roles];
const asUser = ({ login, roles, disabled, createdAt, invitation, credential }: Member): DashboardUser => ({
  login, roles, disabled, createdAt, expiresAt: invitation?.expiresAt,
  status: credential ? disabled ? "disabled" : "active" : invitation && invitation.expiresAt > Date.now() ? "invited" : "expired",
});

function memberFor(state: Directory, login: string) {
  return state.members[keyFor(login)] ?? fail("Dashboard user not found.");
}

function checkedRoles(state: Directory, ids: string[]) {
  const roles = [...new Set(ids)];
  const available = new Set(rolesFor(state).map(({ id }) => id));
  if (!roles.length || roles.some((id) => !available.has(id))) fail("Assign at least one available role.");
  return roles;
}

export function createUserDirectory(storage: RecordStore) {
  const access = document<Directory>(storage, namespace + ":access", () => ({ members: {}, roles: [] }));
  const owner = () => storage.get(ownerSlot);
  const validInvite = (member: Member | undefined, code: string) => Boolean(member?.invitation &&
    !member.credential && member.invitation.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(code) && member.invitation.digest === digest(code));

  return {
    owner,
    async credential(key: string) {
      const master = await owner();
      if (master && ownerValue(master).lookup === key) return { ...master, value: ownerValue(master).value };
      const member = (await access.read()).members[key];
      return member && !member.disabled ? member.credential ?? null : null;
    },
    async replaceCredential(key: string, revision: string, next: StoredRecord) {
      const master = await owner();
      if (master && ownerValue(master).lookup === key) {
        return storage.replace(ownerSlot, revision, { ...next, value: JSON.stringify({ lookup: key, value: next.value }) });
      }
      try {
        await access.update((state) => {
          const member = state.members[key];
          if (!member || member.disabled || member.credential?.revision !== revision) fail("The account changed.");
          member.credential = next;
          return state;
        });
        return true;
      } catch (error) {
        if (error instanceof AccessInputError) return false;
        throw error;
      }
    },
    async provisionOwner(key: string, row: StoredRecord) {
      return storage.insert(ownerSlot, { ...row, value: JSON.stringify({ lookup: key, value: row.value }) });
    },
    async validInvitation(login: string, code: string) {
      return validInvite((await access.read()).members[keyFor(login)], code);
    },
    async redeem(key: string, code: string, row: StoredRecord) {
      try {
        await access.update((state) => {
          const member = state.members[key];
          if (!validInvite(member, code)) fail("Invalid or expired invitation.");
          member.credential = row;
          delete member.invitation;
          return state;
        });
        return true;
      } catch (error) {
        if (error instanceof AccessInputError) return false;
        throw error;
      }
    },
    async accessFor(account: { login: string; id: string }): Promise<Access | null> {
      const key = keyFor(account.login);
      const master = await owner();
      if (master) {
        const wrapped = ownerValue(master);
        if (wrapped.lookup === key && (JSON.parse(wrapped.value) as { id: string }).id === account.id) {
          return { owner: true, roles: ["Owner"], allows: () => true };
        }
      }
      const state = await access.read();
      const member = state.members[key];
      if (!member?.credential || member.disabled || accountId(member.credential) !== account.id) return null;
      const roles = rolesFor(state);
      const allowed = permissionsFor(roles, member.roles);
      return { owner: false, roles: roles.filter(({ id }) => member.roles.includes(id)).map(({ name }) => name),
        allows: (permission) => allowed.has(permission) };
    },
    async list() {
      const master = await owner();
      const state = await access.read();
      return {
        owner: master ? (JSON.parse(ownerValue(master).value) as { login: string }).login : "",
        members: Object.values(state.members).map(asUser).sort((a, b) => a.login.localeCompare(b.login)),
        roles: rolesFor(state),
      };
    },
    async invite(identifier: string, roleIds?: string[]) {
      const login = normalizeLogin(identifier);
      const key = keyFor(login);
      const master = await owner();
      if (!master || ownerValue(master).lookup === key) fail("Choose a different login.");
      const code = randomBytes(32).toString("base64url");
      const now = Date.now();
      const expiresAt = now + 24 * 60 * 60_000;
      await access.update((state) => {
        const member = state.members[key];
        if (member?.credential) fail("That user already has an account.");
        if (!member && !roleIds) fail("Dashboard invitation not found.");
        state.members[key] = { login, roles: checkedRoles(state, roleIds ?? member.roles), disabled: false, createdAt: member?.createdAt ?? now,
          invitation: { digest: digest(code), expiresAt } };
        return state;
      });
      return { login, code, expiresAt };
    },
    async assign(login: string, roles: string[]) {
      await access.update((state) => {
        memberFor(state, login).roles = checkedRoles(state, roles);
        return state;
      });
    },
    async changeStatus(login: string, operation: "disable" | "enable" | "revoke" | "remove") {
      await access.update((state) => {
        const member = memberFor(state, login);
        if (operation === "remove") {
          delete state.members[keyFor(login)];
        } else {
          if (!member.credential) return fail("The user must accept their invitation first.");
          if (operation === "revoke" || operation === "disable") member.credential = revokeAccountSessions(member.credential);
          if (operation !== "revoke") member.disabled = operation === "disable";
        }
        return state;
      });
    },
    async canRecover(login: string) {
      const member = (await access.read()).members[keyFor(login)];
      return Boolean(member?.credential && !member.disabled);
    },
    async saveRole(id: string, name: string, permissions: Permission[]) {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || builtInRoles.some((role) => role.id === id) || id === "owner") {
        fail("Use a unique role ID of up to 48 lowercase letters, digits, and hyphens.");
      }
      if (!name.trim() || name.trim().length > 64) fail("Enter a role name of 1 to 64 characters.");
      await access.update((state) => {
        state.roles = [...state.roles.filter((role) => role.id !== id), { id, name: name.trim(), permissions: [...new Set(permissions)] }];
        return state;
      });
    },
    async deleteRole(id: string) {
      await access.update((state) => {
        if (!state.roles.some((role) => role.id === id)) fail("Choose a custom role.");
        if (Object.values(state.members).some(({ roles }) => roles.includes(id))) fail("Reassign every user with this role first.");
        state.roles = state.roles.filter((role) => role.id !== id);
        return state;
      });
    },
  };
}
