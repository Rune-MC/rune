import { channels } from "./chat.ts";
import { active } from "./model.ts";
import { backend } from "./platform.ts";
import { review } from "./reports.ts";

export function registerDashboard() {
  return rune.dashboard.register({
    id: "moderation",
    title: "Moderation",
    description: "Review player reports and recent moderation cases.",
    navigation: [{}, { page: "reports", label: "Player reports" }, { page: "cases", label: "Moderation cases" }],
    metrics: () => ({
      "Active punishments": backend.value().cases.filter((entry) => active(entry)).length,
      "Recorded cases": backend.value().cases.length,
      "Open reports": backend.value().reports.filter((entry) => !entry.resolved).length,
      "Chat channels": Object.keys(channels()).length,
    }),
    overview: {
      title: "Moderation",
      async render(context) {
        const { ModerationSummary } = await import("./dashboard-pages.tsx");
        return ModerationSummary(context, backend.value());
      },
    },
    pages: {
      reports: {
        title: "Player reports",
        async render(context) {
          const { ReportPage } = await import("./dashboard-pages.tsx");
          return ReportPage(context, backend.value());
        },
      },
      cases: {
        title: "Moderation cases",
        async render() {
          const { CasePage } = await import("./dashboard-pages.tsx");
          return CasePage(backend.value());
        },
      },
    },
    actions: {
      "resolve-report": {
        title: "Resolve report",
        confirm: "Close this report with the resolution below",
        fields: {
          report: { type: "number", label: "Report ID", required: true, min: 1 },
          resolution: { type: "string", label: "Resolution", required: true, maxLength: 240, multiline: true },
        },
        run({ report, resolution }) {
          if (typeof report !== "number" || !Number.isSafeInteger(report)) throw new Error("Enter a valid report ID.");
          return new Promise<string>((done, reject) => {
            review(rune.bukkit.getConsoleSender(), report, "resolve", String(resolution),
              () => done(`Resolved report #${report}.`), (message) => reject(new Error(message)));
          });
        },
      },
    },
  });
}
