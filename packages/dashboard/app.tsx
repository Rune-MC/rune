/** @jsxImportSource react */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Account as Owner } from "@rune/web-auth";
import { Account, Credentials } from "./account.tsx";
import { InvalidForm, readFields } from "./actions.ts";
import { authRequest, contentType, createDashboardAuth, loopbackOrigin, selectAuthStorage } from "./auth.ts";
import { Overview, type OverviewData } from "./overview.tsx";
import { Activity, Logs, Players, RuneDetails, Runes, Server, Settings, Status, asLink, type Audit } from "./pages.tsx";
import { ActionForm, Operations, ToolHome, type Contribution } from "./tools.tsx";
import { Card, Details, Shell, Table } from "./ui.tsx";
import { avatar } from "./avatars.ts";
import { PlayerIdentity } from "./identity.tsx";
import { createPlayerDirectory, findPlayerOptions } from "./players.ts";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  // A no-referrer policy makes browsers send Origin: null on same-origin form posts.
  "Referrer-Policy": "same-origin",
};
const html = (node: React.ReactNode) => "<!doctype html>" + renderToStaticMarkup(node);
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const onMain = <T,>(fn: () => T) => rune.runOnMain(fn) as Promise<Awaited<T>>;
const path = (id: string) => asLink("/tools", id);
const text = (ctx: ServeContext, name: string) => ctx.query(name)?.slice(0, 160) ?? "";

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function startConsole(port: number) {
  const storage = await selectAuthStorage();
  const auth = createDashboardAuth(storage);
  const stylesheet = readFileSync(new URL("./dashboard.css", import.meta.url), "utf8");
  const client = readFileSync(new URL("./web/dashboard.js", import.meta.url), "utf8");
  const setupCode = process.env.RUNE_DASHBOARD_SETUP_TOKEN ?? process.env.RUNE_DASHBOARD_TOKEN;
  const secret = randomBytes(32);
  const audit = rune.store("dashboard-activity");
  const monitor = rune.dashboard.monitor({ ...jsxRuntime, react: React, components: { Card, Details, Table, Operations, PlayerIdentity } });
  const playerOptions = createPlayerDirectory();
  let auditRows = audit.get<Audit[]>("rows") ?? [];

  function record(target: string, operation: string, result: Audit["result"], actor: string) {
    auditRows = [...auditRows.slice(-199), { at: Date.now(), target, operation, result, actor }];
    try { audit.set("rows", auditRows); } catch (error) { console.warn("Could not persist dashboard activity:", error); }
  }

  function sign(ctx: ServeContext, owner: Owner | null) {
    const cookie = owner && Object.entries(ctx.req.headers).find(([key]) => key.toLowerCase() === "cookie")?.[1];
    return createHmac("sha256", secret).update(owner ? owner.id + ":" + (cookie ?? "") : "pre-authentication").digest("hex");
  }

  const reply = (ctx: ServeContext, node: React.ReactNode, code = 200) => ctx.html(html(node), code, headers);
  const redirect = (ctx: ServeContext, destination: string, resource?: Response) => {
    const cookie = resource?.headers.get("set-cookie");
    return ctx.text("", 303, { ...headers, Location: destination, ...(cookie ? { "Set-Cookie": cookie } : {}) });
  };

  function page(ctx: ServeContext, title: string, active: string, children: React.ReactNode, options: { subtitle?: string; interactive?: boolean; status?: number } = {}) {
    const tools = [...monitor.contributions().values()].flatMap((module) => module.navigation.map(({ page, label }) => ({
      href: page ? asLink(path(module.id), page) : path(module.id), label,
    })));
    return reply(ctx, <Shell title={title} active={active} tools={tools} {...options}>{children}</Shell>, options.status);
  }

  function pluginContext(ctx: ServeContext, module: Contribution, csrf: string): RuneDashboardPageContext {
    return {
      query: (key) => ctx.query(key), href: (key) => key ? asLink(path(module.id), key) : path(module.id),
      action: (id, defaults) => <ActionForm module={module} action={id} defaults={defaults} csrf={csrf} />, onMain,
    };
  }

  async function renderTool(page: RuneDashboardPage, ctx: ServeContext, module: Contribution, csrf: string) {
    const node = await onMain(() => page.render(pluginContext(ctx, module, csrf)));
    const markup = await onMain(() => renderToStaticMarkup(node, { identifierPrefix: module.id + "-" }));
    return <div dangerouslySetInnerHTML={{ __html: markup }} />;
  }

  async function form(ctx: ServeContext, origin: string, csrf: string) {
    if (contentType(ctx) !== "application/x-www-form-urlencoded") throw new RequestError(415, "Submit this action through its form.");
    if (ctx.req.bytes().length > 16 * 1024) throw new RequestError(413, "The form is too large.");
    try { auth.handlers(origin).checkOrigin(authRequest(ctx, origin, "/")); }
    catch { throw new RequestError(403, "Request origin denied."); }
    const values = new URLSearchParams(await ctx.req.text());
    if (values.getAll("csrf").length !== 1 || !same(values.get("csrf") ?? "", csrf)) {
      throw new RequestError(403, "This form expired. Reload the page and try again.");
    }
    return values;
  }

  type Session = { owner: Owner; origin: string; csrf: string };
  const guarded = (handle: (ctx: ServeContext, session: Session) => ServeHandlerResult | Promise<ServeHandlerResult>) =>
    async (ctx: ServeContext) => {
      const origin = loopbackOrigin(ctx);
      if (!origin) return ctx.text("Open Rune Console through its loopback address.", 403, headers);
      try {
        const owner = await auth.handlers(origin).authenticate(authRequest(ctx, origin, "/"));
        if (!owner) return redirect(ctx, await auth.hasOwner() ? "/login" : "/setup");
        return await handle(ctx, { owner, origin, csrf: sign(ctx, owner) });
      } catch (error) {
        if (error instanceof RequestError || error instanceof InvalidForm) {
          return page(ctx, "Request rejected", "", <Status back="/" failure>{error.message}</Status>,
            { status: error instanceof RequestError ? error.status : 400 });
        }
        console.error("Dashboard request failed:", error);
        return ctx.text("The dashboard could not complete this request. Check the server log.", 503, headers);
      }
    };

  const credentials = (setup: boolean) => async (ctx: ServeContext) => {
    const origin = loopbackOrigin(ctx);
    if (!origin) return ctx.text("Open Rune Console through its loopback address.", 403, headers);
    const csrf = sign(ctx, null);
    const view = (error?: string, status = 200) =>
      reply(ctx, <Credentials csrf={csrf} setup={setup} needsCode={Boolean(setupCode)} error={error} />, status);
    try {
      const hasOwner = await auth.hasOwner();
      if (setup && hasOwner || !setup && !hasOwner) return redirect(ctx, hasOwner ? "/login" : "/setup");
      if (ctx.req.method === "GET") {
        if (await auth.handlers(origin).authenticate(authRequest(ctx, origin, "/"))) return redirect(ctx, "/");
        return view();
      }
      const values = await form(ctx, origin, csrf);
      if (setup && setupCode && !same(values.get("setup-token") ?? "", setupCode)) return view("Incorrect server setup token.", 403);
      const credentials = { login: values.get("login") ?? "", password: values.get("password") ?? "" };
      const routes = auth.handlers(origin);
      if (setup) {
        const registered = await routes.handle(authRequest(ctx, origin, "/auth/register", "POST", credentials));
        if (!registered.ok) {
          if (registered.status === 409 && await auth.hasOwner()) return redirect(ctx, "/login");
          return view((await registered.json()).error, registered.status);
        }
        record("Dashboard", "Create owner", "Completed", credentials.login);
      }
      const result = await routes.handle(authRequest(ctx, origin, "/auth/sign-in", "POST", credentials));
      if (!result.ok) return setup ? redirect(ctx, "/login") : view((await result.json()).error, result.status);
      return redirect(ctx, "/", result);
    } catch (error) {
      if (error instanceof RequestError) return view(error.message, error.status);
      console.error("Dashboard authentication failed:", error);
      return view("The authentication store is unavailable. Check the server log.", 503);
    }
  };

  const overview = (): OverviewData => ({ snapshot: monitor.snapshot(), samples: monitor.samples() });
  const accountAction = (route: string, operation: string, payload?: (values: URLSearchParams) => Record<string, string>) =>
    guarded(async (ctx, session) => {
      const values = await form(ctx, session.origin, session.csrf);
      const response = await auth.handlers(session.origin)
        .handle(authRequest(ctx, session.origin, "/auth/" + route, "POST", payload?.(values)));
      if (!response.ok) return page(ctx, "Account", "/account", <Status back="/account" failure>{(await response.json()).error}</Status>, { status: response.status });
      record("Dashboard", operation, "Completed", session.owner.login);
      return redirect(ctx, "/login", response);
    });

  let server: ReturnType<typeof rune.serve>;
  try {
    server = rune.serve({ port, host: "127.0.0.1" }, (app) => {
      app.get("/assets/dashboard.css", (ctx) => ctx.text(stylesheet, 200, { ...headers, "Content-Type": "text/css; charset=utf-8" }));
      app.get("/assets/dashboard.js", (ctx) => ctx.text(client, 200, { ...headers, "Content-Type": "application/javascript; charset=utf-8" }));
      app.get("/setup", credentials(true));
      app.post("/setup", credentials(true));
      app.get("/login", credentials(false));
      app.post("/login", credentials(false));
      app.get("/account", guarded((ctx, session) => page(ctx, "Account", "/account", <Account login={session.owner.login} csrf={session.csrf} />)));
      app.post("/logout", accountAction("sign-out", "Sign out"));
      app.post("/logout-all", accountAction("sign-out-everywhere", "Revoke all sessions"));
      app.post("/account/password", accountAction("change-password", "Change password", (values) => ({
        oldPassword: values.get("old-password") ?? "", newPassword: values.get("new-password") ?? "",
      })));

      app.get("/api/overview", guarded((ctx) => ctx.json(overview(), 200, headers)));
      app.get("/api/player-options", guarded(async (ctx) => {
        const availability = ctx.query("availability") === "online" ? "online" : "known";
        const query = ctx.query("q")?.slice(0, 64) ?? "";
        const selected = ctx.query("selected")?.slice(0, 36) ?? "";
        const directory = await onMain(() => playerOptions(availability));
        return ctx.json(findPlayerOptions(directory, query, availability, selected), 200, headers);
      }));
      app.get("/avatars/:id", guarded(async (ctx) => {
        const { body, maxAge } = await avatar(ctx.param("id") ?? "", ctx.query("name") ?? undefined);
        return { status: 200, headers: { ...headers, "Content-Type": "image/png", ...(maxAge ? { "Cache-Control": `private, max-age=${maxAge}` } : {}) }, body };
      }));
      app.get("/", guarded(async (ctx, session) => {
        const initial = overview();
        const state = JSON.stringify(initial).replaceAll("<", "\\u003c");
        const panels = await onMain(() => [...monitor.panels()].map(([id, panel]) => {
          try { return <Card key={id} title={panel.title}><Details values={panel.read()} /></Card>; }
          catch (error) {
            console.warn("Dashboard panel failed:", id, error);
            return <Card key={id} title={panel.title}><p role="alert">Panel unavailable.</p></Card>;
          }
        }));
        const widgets = await Promise.all([...monitor.contributions().values()].flatMap((module) => {
          const widget = module.overview;
          if (!widget) return [];
          return renderTool(widget, ctx, module, session.csrf)
            .then((node) => <Card key={module.id} title={widget.title}>{node}</Card>)
            .catch((error) => {
              console.warn("Rune dashboard widget failed:", module.id, error);
              return <Card key={module.id} title={widget.title}><p role="alert">Widget unavailable.</p></Card>;
            });
        }));
        return page(ctx, "Overview", "/", <>
          <div id="overview" dangerouslySetInnerHTML={{ __html: renderToString(<Overview initial={initial} />) }} />
          <script id="overview-state" type="application/json" dangerouslySetInnerHTML={{ __html: state }} />
          {panels.length + widgets.length > 0 && <div className="grid section">{panels}{widgets}</div>}
        </>, { interactive: true, subtitle: initial.snapshot?.host?.server.version });
      }));
      app.get("/server", guarded((ctx, session) => page(ctx, "Server", "/server",
        <Server host={monitor.snapshot()?.host} csrf={session.csrf} />)));
      app.get("/players", guarded((ctx) => page(ctx, "Players", "/players", <Players host={monitor.snapshot()?.host} />)));
      app.get("/runes", guarded(async (ctx) => page(ctx, "Runes", "/runes", <Runes rows={await monitor.runes()} query={text(ctx, "q")} />)));
      app.get("/runes/:id", guarded(async (ctx) => {
        const rune = (await monitor.runes()).find((item) => item.id === ctx.param("id"));
        if (!rune) throw new RequestError(404, "Rune unavailable.");
        const script = rune.script?.path;
        const tools = [...monitor.contributions().values()].filter((module) => script && module.owner === script);
        const logs = monitor.logs().filter((log) => script && log.rune === script).slice(-30).reverse();
        return page(ctx, rune.name, "/runes", <RuneDetails item={rune} tools={tools} logs={logs} />);
      }));
      app.get("/logs", guarded(async (ctx) => page(ctx, "Logs", "/logs",
        <Logs rows={monitor.logs()} runes={await monitor.runes()} query={text(ctx, "q")} level={text(ctx, "level")} owner={text(ctx, "rune")} />)));
      app.get("/settings", guarded((ctx, session) => page(ctx, "Settings", "/settings",
        <Settings configs={monitor.configs()} csrf={session.csrf} saved={ctx.query("saved") === "1"} />)));
      app.get("/activity", guarded((ctx) => page(ctx, "Activity", "/activity", <Activity rows={auditRows} />)));
      app.post("/settings/:id", guarded(async (ctx, session) => {
        const values = await form(ctx, session.origin, session.csrf);
        const id = ctx.param("id") ?? "";
        const config = monitor.configs().get(id);
        if (!config) throw new RequestError(404, "Settings unavailable.");
        const schema = Object.fromEntries(Object.entries(config.schema).map(([name, field]) => [name, {
          ...field, type: typeof field.default as RuneDashboardField["type"], required: typeof field.default === "number",
        }]));
        try { await onMain(() => config.update(readFields(values, schema))); }
        catch (error) {
          record(id, "Save settings", "Rejected", session.owner.login);
          throw new InvalidForm(error instanceof Error ? error.message : "Settings could not be saved.");
        }
        record(id, "Save settings", "Completed", session.owner.login);
        return redirect(ctx, "/settings?saved=1");
      }));
      app.post("/reload", guarded(async (ctx, session) => {
        if ((await form(ctx, session.origin, session.csrf)).get("confirm") !== "yes") throw new InvalidForm("Confirm the reload before continuing.");
        record("Server", "Reload all Runes", "Queued", session.owner.login);
        monitor.reload();
        return page(ctx, "Reload requested", "/server", <Status back="/server">Return after Rune reloads.</Status>, { status: 202 });
      }));
      app.get("/tools/:id", guarded(async (ctx, session) => {
        const module = monitor.contributions().get(ctx.param("id") ?? "");
        if (!module) throw new RequestError(404, "Rune tool unavailable.");
        let metrics: Record<string, RuneDashboardValue | null> | undefined;
        let metricsFailed = false;
        try { metrics = module.metrics && await onMain(module.metrics); }
        catch (error) { metricsFailed = true; console.warn("Rune tool metrics failed:", module.id, error); }
        return page(ctx, module.title, path(module.id), <ToolHome module={module} metrics={metrics} metricsFailed={metricsFailed}
          context={pluginContext(ctx, module, session.csrf)} />,
          { subtitle: module.description, interactive: true });
      }));
      app.get("/tools/:id/:page", guarded(async (ctx, session) => {
        const module = monitor.contributions().get(ctx.param("id") ?? "");
        const pageId = ctx.param("page") ?? "";
        const selected = module?.pages.get(pageId);
        if (!module || !selected) throw new RequestError(404, "Rune tool page unavailable.");
        const content = await renderTool(selected, ctx, module, session.csrf);
        const active = module.navigation.some((link) => link.page === pageId) ? asLink(path(module.id), pageId) : path(module.id);
        return page(ctx, selected.title, active, <><p><a href={path(module.id)}>{module.title}</a></p>{content}</>, { subtitle: module.description, interactive: true });
      }));
      app.post("/tools/:id/actions/:action", guarded(async (ctx, session) => {
        const values = await form(ctx, session.origin, session.csrf);
        const module = monitor.contributions().get(ctx.param("id") ?? "");
        const action = module?.actions.get(ctx.param("action") ?? "");
        if (!module || !action) throw new RequestError(404, "Rune action unavailable.");
        const href = path(module.id);
        const referrer = Object.entries(ctx.req.headers).find(([key]) => key.toLowerCase() === "referer")?.[1];
        let back = href;
        if (referrer) {
          try {
            const url = new URL(referrer);
            const pages = [href, ...[...module.pages.keys()].map((id) => asLink(href, id))];
            if (url.origin === session.origin && pages.includes(url.pathname)) back = url.pathname + url.search;
          } catch { /* Fall back to the tool home for malformed referrers. */ }
        }
        try {
          if (action.confirm && values.get("confirm") !== "yes") throw new InvalidForm("Confirm this action before continuing.");
          const result = await onMain(() => action.run(readFields(values, action.fields), { onMain }));
          record(module.title, action.title, "Completed", session.owner.login);
          return page(ctx, action.title, href, <Status back={back}>{result ?? "Action completed."}</Status>);
        } catch (error) {
          record(module.title, action.title, "Rejected", session.owner.login);
          console.warn("Rune dashboard action failed:", module.id, action.title, error);
          return page(ctx, action.title, href, <Status back={back} failure>{error instanceof Error ? error.message : "Action failed."}</Status>, { status: 422 });
        }
      }));
    });
  } catch (error) {
    monitor.close();
    throw error;
  }
  monitor.ready();
  const prune = rune.schedule.everyMs(() => void auth.prune().catch((error) => console.warn("Dashboard session cleanup failed:", error)), 3600_000);
  return { close() { rune.schedule.cancel(prune); monitor.close(); server.close(); } };
}
