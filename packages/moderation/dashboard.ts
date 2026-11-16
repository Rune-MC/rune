import { channels } from "./chat.ts";
import { moderationActions } from "./dashboard-actions.ts";
import { active } from "./model.ts";
import { backend } from "./platform.ts";

export function registerDashboard() {
  return rune.dashboard.register({
    id: "moderation", title: "Moderation", description: "Manage punishments, reports, chat channels, and server policies.",
    navigation: [{}, { page: "cases" }, { page: "reports" }, { page: "players", label: "Player history" }, { page: "chat", label: "Chat moderation" }],
    metrics: () => ({
      "Active punishments": backend.value().cases.filter((entry) => active(entry)).length,
      "Recorded cases": backend.value().cases.length,
      "Open reports": backend.value().reports.filter((entry) => !entry.resolved).length,
      "Chat channels": Object.keys(channels()).length,
    }),
    pages: {
      cases: { title: "Moderation cases", async render(context) {
        return (await import("./dashboard-pages.tsx")).CasePage(context, backend.value());
      } },
      reports: { title: "Player reports", async render(context) {
        return (await import("./dashboard-pages.tsx")).ReportPage(context, backend.value());
      } },
      players: { title: "Player history", async render(context) {
        return (await import("./dashboard-pages.tsx")).PlayersPage(context, backend.value());
      } },
      chat: { title: "Chat moderation", async render(context) {
        return (await import("./dashboard-pages.tsx")).ChatPage(context);
      } },
      audit: { title: "Moderation audit", async render() {
        return (await import("./dashboard-pages.tsx")).AuditPage(backend.value());
      } },
    },
    actions: moderationActions,
  });
}
