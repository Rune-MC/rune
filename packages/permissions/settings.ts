export const options = rune.config("permissions", {
  "decorate-display-name": { default: true, label: "Add labels to the Paper display name" },
  "decorate-tab-list": { default: true, label: "Add labels to the tab list" },
  "stack-prefixes": { default: false, label: "Show ranked prefixes from multiple groups" },
  "stack-suffixes": { default: false, label: "Show ranked suffixes from multiple groups" },
});

export const server = process.env.RUNE_PERMISSIONS_SERVER?.trim() || "default";
