# @rune/dashboard

Start a local Rune dashboard for script state, logs, reloads, settings,
and panels provided by other Runes.

## Install and sign in

1. Set `RUNE_DASHBOARD_TOKEN` in the Paper server environment to a password
   of at least 24 characters.
2. Copy this directory into `plugins/Rune/scripts/` and restart Paper.
3. On the server, open `http://127.0.0.1:8777` and sign in as `rune` using
   the token as the password.

The dashboard listens on loopback. To use it from another machine,
forward the port over SSH.

```sh
ssh -L 8777:127.0.0.1:8777 user@minecraft-host
```

Keep the token in the server environment. Treat it like a server
administrator password because the dashboard can reload Runes and change settings.
