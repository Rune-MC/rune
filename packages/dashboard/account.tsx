/** @jsxImportSource react */
import { Card } from "./ui.tsx";

export function Credentials({ csrf, setup, needsCode, error }: { csrf: string; setup: boolean; needsCode: boolean; error?: string }) {
  return <html lang="en"><head>
    <meta charSet="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{setup ? "Create owner · Rune" : "Sign in · Rune"}</title><link rel="stylesheet" href="/assets/dashboard.css" />
  </head><body><main className="auth-page">
    <h1>Rune Console</h1>
    <Card title={setup ? "Create the dashboard owner" : "Sign in"}>
      {setup && <p>The first account gets full access to this server’s dashboard.</p>}
      {error && <p className="note error" role="alert">{error}</p>}
      <form method="post" action={setup ? "/setup" : "/login"}>
        <input type="hidden" name="csrf" value={csrf} />
        <label className="field">Username or email<input name="login" autoComplete="username" required minLength={3} maxLength={160} /></label>
        <label className="field">Password<input name="password" type="password" autoComplete={setup ? "new-password" : "current-password"}
          required minLength={setup ? 15 : undefined} maxLength={1024} /></label>
        {setup && <small>Use at least 15 characters.</small>}
        {setup && needsCode && <label className="field">Server setup token<input name="setup-token" type="password" required maxLength={1024} /></label>}
        <p><button className="primary" type="submit">{setup ? "Create owner" : "Sign in"}</button></p>
      </form>
    </Card>
  </main></body></html>;
}

export function Account({ login, csrf }: { login: string; csrf: string }) {
  return <div className="form-grid">
    <Card title="Dashboard owner"><p><strong>{login}</strong> has full dashboard access.</p>
      <form action="/logout" method="post"><input name="csrf" type="hidden" value={csrf} />
        <button type="submit">Sign out</button></form>
      <form className="section" action="/logout-all" method="post"><input name="csrf" type="hidden" value={csrf} />
        <button type="submit">Sign out of all sessions</button></form>
    </Card>
    <Card title="Change password">
      <p>Changing your password revokes existing sessions.</p>
      <form action="/account/password" method="post">
        <input name="csrf" type="hidden" value={csrf} />
        <label className="field">Current password<input type="password" name="old-password" autoComplete="current-password" required maxLength={1024} /></label>
        <label className="field">New password<input type="password" name="new-password" autoComplete="new-password" required minLength={15} maxLength={1024} /></label>
        <button type="submit" className="primary">Change password</button>
      </form>
    </Card>
  </div>;
}
