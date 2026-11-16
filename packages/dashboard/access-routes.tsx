/** @jsxImportSource react */
import { AuthError, normalizeLogin, type Account } from "@rune/web-auth";
import { ManageAccess, ShareCode } from "./access-ui.tsx";
import { InvalidForm, RequestError } from "./actions.ts";
import { authErrorStatus, type createDashboardAuth } from "./auth.ts";
import { Enrollment } from "./enrollment.tsx";
import { Status } from "./pages.tsx";
import { builtInRoles, permissionLabels, type AccessTool, type Permission, type Role } from "./permissions.ts";
import { AccessInputError, type Access } from "./users.ts";

export type Session = { account: Account; access: Access; origin: string; csrf: string };
export type PageOptions = { subtitle?: string; interactive?: boolean; status?: number };
export type SignedInHandler = (ctx: ServeContext, session: Session) => ReturnType<ServeHandler>;
type Node = import("react").ReactNode;
type Services = {
  auth: ReturnType<typeof createDashboardAuth>;
  guardOwner: (handler: SignedInHandler) => ServeHandler;
  origin: (ctx: ServeContext) => string | null;
  anonymousCsrf: (ctx: ServeContext) => string;
  form: (ctx: ServeContext, origin: string, csrf: string) => Promise<URLSearchParams>;
  page: (ctx: ServeContext, session: Session, title: string, active: string, node: Node, options?: PageOptions) => ServeHandlerResult;
  reply: (ctx: ServeContext, node: Node, status?: number) => ServeHandlerResult;
  redirect: (ctx: ServeContext, path: string) => ServeHandlerResult;
  record: (target: string, operation: string, result: "Completed", actor: string) => void;
  tools: () => Iterable<AccessTool>;
};
const pathFor = (key: "user" | "role", value: string) => "/access?" + new URLSearchParams({ [key]: value });
const custom = (role: Role) => !builtInRoles.some(({ id }) => id === role.id);
function validateFields(form: URLSearchParams, fields: string[], repeated: string[] = []) {
  for (const key of new Set(form.keys())) {
    if (key === "csrf") continue;
    if (!fields.includes(key) || (!repeated.includes(key) && form.getAll(key).length !== 1)) {
      throw new InvalidForm("The form contains an unexpected or repeated field.");
    }
  }
}

export function registerAccessRoutes(app: ServeApp, services: Services) {
  const { auth, guardOwner, origin, anonymousCsrf, form, page, reply, redirect, record, tools } = services;
  const { directory } = auth;
  const render = (ctx: ServeContext, session: Session, content: Node, status = 200) =>
    page(ctx, session, "Users & roles", "/access", content, { status });

  for (const kind of ["join", "reset"] as const) {
    const enrollment: ServeHandler = async (ctx) => {
      const url = origin(ctx);
      if (!url) return ctx.text("Open Rune Console through its loopback address.", 403);
      const csrf = anonymousCsrf(ctx);
      const view = (status = 200, error?: string) => reply(ctx, <Enrollment csrf={csrf} kind={kind} error={error} />, status);
      try {
        if (!(await auth.hasOwner())) return redirect(ctx, "/setup");
        if (ctx.req.method === "GET") return view();
        const values = await form(ctx, url, csrf);
        validateFields(values, kind === "join" ? ["login", "code", "password"] : ["code", "password"]);
        const code = values.get("code")?.trim() ?? "";
        const password = values.get("password") ?? "";
        if (kind === "join") {
          const account = await auth.registerInvite(values.get("login") ?? "", password, code);
          record(account.login, "Accept invitation", "Completed", account.login);
        } else {
          await auth.resetPassword(code, password);
        }
        return redirect(ctx, "/login?" + (kind === "join" ? "joined" : "reset") + "=1");
      } catch (error) {
        if (error instanceof AuthError) return view(authErrorStatus(error), error.message);
        if (error instanceof InvalidForm) return view(400, error.message);
        if (error instanceof RequestError) return view(error.status, error.message);
        console.error("Dashboard enrollment failed:", error);
        return view(503, "The authentication store is unavailable. Check the server log.");
      }
    };
    app.get("/" + kind, enrollment);
    app.post("/" + kind, enrollment);
  }

  app.get("/access", guardOwner(async (ctx, session) => {
    const state = await directory.list();
    const selected = state.members.find(({ login }) => login === ctx.query("user"));
    const role = state.roles.find((role) => custom(role) && role.id === ctx.query("role"));
    const labels = permissionLabels(tools());
    for (const key of role?.permissions ?? []) labels[key] ??= key;
    const notice = ctx.query("saved") === "1" ? "Access settings saved." : undefined;
    return render(ctx, session, <ManageAccess {...state} csrf={session.csrf} selected={selected} role={role} permissions={labels} notice={notice} />);
  }));

  const write = (route: string, perform: (ctx: ServeContext, session: Session, values: URLSearchParams) => Promise<ServeHandlerResult>) => {
    app.post("/access/" + route, guardOwner(async (ctx, session) => {
      try {
        return await perform(ctx, session, await form(ctx, session.origin, session.csrf));
      } catch (error) {
        if (error instanceof AccessInputError || error instanceof AuthError || error instanceof InvalidForm) {
          return render(ctx, session, <Status failure back="/access">{error.message}</Status>, error instanceof AuthError ? authErrorStatus(error) : 422);
        }
        throw error;
      }
    }));
  };

  for (const operation of ["invite", "renew"] as const) {
    write(operation, async (ctx, session, values) => {
      validateFields(values, operation === "invite" ? ["login", "role"] : ["login"], ["role"]);
      const invitation = await directory.invite(values.get("login") ?? "", operation === "invite" ? values.getAll("role") : undefined);
      record(invitation.login, "Create invitation", "Completed", session.account.login);
      return render(ctx, session, <ShareCode {...invitation} kind="join" />);
    });
  }

  write("assign", async (ctx, session, values) => {
    validateFields(values, ["login", "role"], ["role"]);
    const login = normalizeLogin(values.get("login"));
    await directory.assign(login, values.getAll("role"));
    record(login, "Assign dashboard roles", "Completed", session.account.login);
    return redirect(ctx, pathFor("user", login) + "&saved=1");
  });

  const operations = { disable: "Disable account", enable: "Enable account", revoke: "Revoke user sessions", remove: "Remove account or invitation" } as const;
  for (const operation of ["disable", "enable", "revoke", "remove"] as const) {
    write(operation, async (ctx, session, values) => {
      validateFields(values, operation === "remove" ? ["login", "confirm"] : ["login"]);
      if (operation === "remove" && values.get("confirm") !== "yes") throw new InvalidForm("Confirm removal first.");
      const login = normalizeLogin(values.get("login"));
      await directory.changeStatus(login, operation);
      record(login, operations[operation], "Completed", session.account.login);
      return redirect(ctx, (operation === "remove" ? "/access?" : pathFor("user", login) + "&") + "saved=1");
    });
  }

  write("recovery", async (ctx, session, values) => {
    validateFields(values, ["login"]);
    const login = normalizeLogin(values.get("login"));
    const code = await auth.recoveryCode(login);
    if (!code) throw new InvalidForm("Choose an active dashboard account.");
    record(login, "Create recovery code", "Completed", session.account.login);
    return render(ctx, session, <ShareCode login={login} code={code} kind="reset" expiresAt={Date.now() + 900_000} />);
  });

  write("role", async (ctx, session, values) => {
    validateFields(values, ["id", "name", "permission"], ["permission"]);
    const id = values.get("id") ?? "";
    const permissions = values.getAll("permission");
    const labels = permissionLabels(tools());
    const previous = (await directory.list()).roles.find((role) => custom(role) && role.id === id);
    if (permissions.some((key) => !Object.hasOwn(labels, key) && !previous?.permissions.includes(key as Permission))) {
      throw new InvalidForm("Choose available permissions.");
    }
    await directory.saveRole(id, values.get("name") ?? "", permissions as Permission[]);
    record(id, "Save dashboard role", "Completed", session.account.login);
    return redirect(ctx, pathFor("role", id) + "&saved=1");
  });

  write("delete-role", async (ctx, session, values) => {
    validateFields(values, ["id", "confirm"]);
    if (values.get("confirm") !== "yes") throw new InvalidForm("Confirm removal first.");
    const id = values.get("id") ?? "";
    await directory.deleteRole(id);
    record(id, "Delete dashboard role", "Completed", session.account.login);
    return redirect(ctx, "/access?saved=1");
  });
}
