/** @jsxImportSource react */
import { hydrateRoot } from "react-dom/client";
import { Overview, type OverviewData } from "./overview.tsx";

const container = document.getElementById("overview");
const state = document.getElementById("overview-state")?.textContent;
if (container && state) {
  const initial: OverviewData = JSON.parse(state);
  hydrateRoot(container, <Overview initial={initial} />);
}
