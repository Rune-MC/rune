/** @jsxImportSource react */
import { Badge, Card, Table, Utc } from "./ui.tsx";
import { builtInRoles, type Permission, type Role } from "./permissions.ts";
import type { DashboardUser } from "./users.ts";

const change = (key: string) => "/access?" + new URLSearchParams({ user: key });
const roleLink = (key: string) => "/access?" + new URLSearchParams({ role: key });
function NamedForm({ id, title, route, csrf, children }: { id: string; title: string; route: string; csrf: string; children: import("react").ReactNode }) {
  return <form action={"/access/" + route} method="post" aria-labelledby={id}>
    <input type="hidden" name="csrf" value={csrf} />
    <fieldset><legend id={id}>{title}</legend>{children}</fieldset>
  </form>;
}

function Roles({ roles, assigned = [] }: { roles: Role[]; assigned?: string[] }) {
  return <fieldset><legend>Roles</legend><div className="role-checks">
    {roles.map((role) => <label className="check" key={role.id}>
      <input type="checkbox" name="role" value={role.id} defaultChecked={assigned.includes(role.id)} />{role.name}
    </label>)}
  </div></fieldset>;
}

function UserSettings({ user, roles, csrf }: { user: DashboardUser; roles: Role[]; csrf: string }) {
  const pending = user.status === "invited" || user.status === "expired";
  return <Card title={user.login}>
    <NamedForm id="assign-roles" title="Assign roles" route="assign" csrf={csrf}>
      <input type="hidden" name="login" value={user.login} />
      <Roles roles={roles} assigned={user.roles} />
      <button className="primary" type="submit">Save roles</button>
    </NamedForm>
    <div className="account-operations">
      {pending && <NamedForm id="renew-invite" title="Invitation" route="renew" csrf={csrf}>
        <input type="hidden" name="login" value={user.login} />
        <button type="submit">Generate new invitation</button>
      </NamedForm>}
      {!pending && <>
        <NamedForm id="sessions" title="Sessions" route="revoke" csrf={csrf}>
          <input type="hidden" name="login" value={user.login} />
          <button type="submit">Sign user out everywhere</button>
        </NamedForm>
        <NamedForm id="status" title="Account status" route={user.disabled ? "enable" : "disable"} csrf={csrf}>
          <input type="hidden" name="login" value={user.login} />
          <button className={user.disabled ? "" : "danger"} type="submit">{user.disabled ? "Enable account" : "Disable account"}</button>
        </NamedForm>
        {!user.disabled && <NamedForm id="recovery" title="Password recovery" route="recovery" csrf={csrf}>
          <input type="hidden" name="login" value={user.login} />
          <button type="submit">Generate recovery code</button>
        </NamedForm>}
      </>}
      <NamedForm id="remove-account" title={pending ? "Cancel invitation" : "Remove account"} route="remove" csrf={csrf}>
        <input type="hidden" name="login" value={user.login} />
        <p><label className="check"><input type="checkbox" name="confirm" value="yes" required />Confirm {pending ? "cancellation" : "removal"}</label></p>
        <button className="danger" type="submit">{pending ? "Cancel invitation" : "Remove account"}</button>
      </NamedForm>
    </div>
  </Card>;
}

export function ManageAccess({ csrf, owner, members, roles, selected, role, permissions, notice }: {
  csrf: string; owner: string; members: DashboardUser[]; roles: Role[]; selected?: DashboardUser; role?: Role;
  permissions: Record<Permission, string>; notice?: string;
}) {
  const permissionRows = Object.entries(permissions) as [Permission, string][];
  const roleNames = (ids: string[]) => roles.filter((entry) => ids.includes(entry.id)).map(({ name }) => name).join(", ");
  return <div className="stack">
    {notice && <p className="note" role="status">{notice}</p>}
    <Table title="Dashboard users" columns={["Login", "Roles", "Status", "Invitation expires"]}
      rows={[{ key: "#owner", cells: [owner, "Owner", <Badge tone="good">Active</Badge>, "—"] }, ...members.map((member) => ({
        key: member.login, cells: [<a href={change(member.login)}>{member.login}</a>, roleNames(member.roles),
          <Badge tone={member.status === "active" ? "good" : "warn"}>{member.status}</Badge>,
          member.expiresAt ? <Utc value={member.expiresAt} /> : "—"],
      }))]} />
    {selected && <UserSettings user={selected} roles={roles} csrf={csrf} />}
    <Card title="Add a dashboard user">
      <NamedForm id="invite-user" title="Create an invitation" route="invite" csrf={csrf}>
        <label className="field">Username or email<input name="login" autoComplete="off" required minLength={3} maxLength={160} /></label>
        <Roles roles={roles} assigned={["viewer"]} />
        <button className="primary" type="submit">Create invitation</button>
      </NamedForm>
    </Card>
    <Table title="Roles" columns={["Role", "Type", "Permissions"]} rows={roles.map((entry) => {
      const builtIn = builtInRoles.some(({ id }) => id === entry.id);
      return { key: entry.id, cells: [builtIn ? entry.name : <a href={roleLink(entry.id)}>{entry.name}</a>,
        builtIn ? "Built in" : "Custom", entry.permissions.map((key) => permissions[key] ?? key).join(", ") || "Account access only"] };
    })} />
    <Card title={role ? `Edit ${role.name}` : "Create a custom role"}>
      <NamedForm id="edit-role" title="Role permissions" route="role" csrf={csrf}>
        {role ? <input type="hidden" name="id" value={role.id} /> :
          <label className="field">Role ID<input name="id" pattern="[a-z][a-z0-9\\-]{0,47}" required maxLength={48} /></label>}
        <label className="field">Role name<input name="name" defaultValue={role?.name} required maxLength={64} /></label>
        <fieldset><legend>Permissions</legend><div className="role-checks">
          {permissionRows.map(([key, label]) => <label className="check" key={key}>
            <input type="checkbox" name="permission" value={key} defaultChecked={role?.permissions.includes(key)} />{label}
          </label>)}
        </div></fieldset>
        <button className="primary" type="submit">Save role</button>
      </NamedForm>
      {role && <div className="account-operations">
        <a href="/access">Create another role</a>
        <NamedForm id="delete-role" title="Delete this role" route="delete-role" csrf={csrf}>
          <input type="hidden" name="id" value={role.id} />
          <p><label className="check"><input type="checkbox" name="confirm" value="yes" required />Confirm removal</label></p>
          <button className="danger" type="submit">Delete role</button>
        </NamedForm>
      </div>}
    </Card>
  </div>;
}

export function ShareCode({ code, login, kind, expiresAt }: { code: string; login: string; kind: "join" | "reset"; expiresAt: number }) {
  return <Card title={kind === "join" ? "Invitation created" : "Recovery code created"}>
    <p>Give this one-time code to <strong>{login}</strong> for the <a href={"/" + kind}>{kind === "join" ? "Accept invitation" : "Reset password"}</a> page.</p>
    <label className="field">{kind === "join" ? "Invitation code" : "Recovery code"}<input className="mono" readOnly value={code} /></label>
    <p>Expires <Utc value={expiresAt} />. This code is shown once.</p>
    <a href={change(login)}>Return to {login}</a>
  </Card>;
}
