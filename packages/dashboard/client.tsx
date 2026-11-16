/** @jsxImportSource react */
import { createRoot, hydrateRoot } from "react-dom/client";
import { Overview, type OverviewData } from "./overview.tsx";
import { PlayerPicker } from "./player-picker.tsx";

const container = document.getElementById("overview");
const state = document.getElementById("overview-state")?.textContent;
if (container && state) {
  const initial: OverviewData = JSON.parse(state);
  hydrateRoot(container, <Overview initial={initial} />);
}

for (const mount of document.querySelectorAll<HTMLElement>("[data-player-picker]")) {
  const field = mount.querySelector("input");
  if (!field) continue;
  createRoot(mount).render(<PlayerPicker id={field.id} name={field.name} value={field.value} required={field.required}
    describedBy={field.getAttribute("aria-describedby") ?? undefined} label={mount.dataset.label ?? "Player"}
    availability={mount.dataset.playerPicker === "online" ? "online" : "known"} />);
}
