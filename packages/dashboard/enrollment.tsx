/** @jsxImportSource react */
import { Card } from "./ui.tsx";

export function Enrollment({ csrf, kind, error }: { csrf: string; kind: "join" | "reset"; error?: string }) {
  const accepting = kind === "join";
  const title = accepting ? "Accept invitation" : "Reset password";
  return <html lang="en"><head>
    <meta charSet="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{title + " · Rune"}</title><link rel="stylesheet" href="/assets/dashboard.css" />
  </head><body><main className="auth-page">
    <h1>Rune Console</h1>
    <Card title={title}>
      {error && <p className="note error" role="alert">{error}</p>}
      <form method="post" action={"/" + kind} aria-labelledby="enrollment">
        <input type="hidden" name="csrf" value={csrf} />
        <fieldset><legend id="enrollment">Set your dashboard password</legend>
          {accepting && <label className="field">Invited username or email<input name="login" autoComplete="username" required minLength={3} maxLength={160} /></label>}
          <label className="field">{accepting ? "Invitation code" : "Recovery code"}<input name="code" required minLength={43} maxLength={43}
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
          <label className="field">New password<input name="password" type="password" autoComplete="new-password"
            required minLength={15} maxLength={1024} aria-describedby="password-length" /></label>
          <p id="password-length"><small>Use at least 15 characters.</small></p>
          <button className="primary" type="submit">{title}</button>
        </fieldset>
      </form>
      <p><a href="/login">Back to sign in</a></p>
    </Card>
  </main></body></html>;
}
