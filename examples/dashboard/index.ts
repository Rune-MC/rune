const password = process.env.RUNE_DASHBOARD_TOKEN;
if (!password) throw new Error("Set RUNE_DASHBOARD_TOKEN to enable the local Rune dashboard");

rune.dashboard.start({ token: password });
