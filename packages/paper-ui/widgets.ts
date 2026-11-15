import { tell, type Click, type Icon, type Page, type MenuInstance, type MenuToolkit } from "./menus.ts";

export type Row = { title: string; icon: Icon; lore?: string[]; color?: string; search?: string;
  open?: Page; preview?: () => Component | undefined };
type ListOptions = { title: string; rows: () => Row[]; back: Page; filter?: boolean; extras?: (menu: MenuInstance) => void };
const grid = [10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 28, 29, 30, 31, 32, 33, 34, 37, 38, 39, 40, 41, 42, 43];

export function createWidgets({ Menu, prompt }: MenuToolkit) {
  function list({ title, rows, back, filter = true, extras }: ListOptions): Page {
    const navigation = new WeakMap<Player, { page: number; query: string }>();
    function show(player: Player, rawPage: number, query: string) {
      const menu = new Menu(player, title, back);
      const matches = rows().filter((row) => [row.title, row.search, ...row.lore ?? []]
        .some((value) => value?.toLowerCase().includes(query.toLowerCase())));
      const total = Math.max(1, Math.ceil(matches.length / grid.length));
      const page = Math.min(total - 1, Math.max(0, rawPage));
      navigation.set(player, { page, query });
      const reopen = () => show(player, page, query);
      menu.item(4, { icon: "BOOK", title, lore: [`${matches.length} result(s) • Page ${page + 1} of ${total}`] });
      if (!matches.length) menu.item(22, { icon: "PAPER", title: "No results", lore: [query ? "Try a different search." : "There are no entries yet."] });
      matches.slice(page * grid.length, (page + 1) * grid.length).forEach((row, index) => {
        const action = row.open ? () => row.open?.(player) : undefined;
        menu.item(grid[index], { ...row, action, preview: row.preview?.() });
      });
      if (page > 0) menu.button(47, "ARROW", "Previous page", [], () => show(player, page - 1, query));
      if (page + 1 < total) menu.button(51, "ARROW", "Next page", [], () => show(player, page + 1, query));
      if (filter) menu.button(49, "COMPASS", "Search", [query || "Filter by name or details", ...(query ? ["Right-click to clear"] : [])],
        (click) => {
          if (click === "right") show(player, 0, "");
          else prompt(player, "Search this list", "Enter a search term, or type !clear.", reopen, (value) => show(player, 0, value === "!clear" ? "" : value));
        });
      extras?.(menu);
      menu.open();
    }
    return (player) => {
      const position = navigation.get(player);
      show(player, position?.page ?? 0, position?.query ?? "");
    };
  }

  function choose(title: string, rows: () => Row[], back: Page): Page {
    return list({ title, rows, back });
  }

  function confirm(title: string, details: string[], back: Page, action: (player: Player) => void): Page {
    return (player) => {
      const menu = new Menu(player, "Confirm", back);
      menu.item(13, { icon: "REDSTONE_BLOCK", title, lore: details, color: "red" });
      menu.button(21, "GRAY_DYE", "Cancel", [], () => back(player));
      menu.button(23, "RED_DYE", "Confirm", details, () => action(player), "red");
      menu.open();
    };
  }

  type Field<T> = {
    title: string; icon: Icon; value: (draft: T) => string; hint?: string;
    update?: (draft: T, value: string) => T;
    cycle?: (draft: T) => T;
    preview?: (draft: T) => Component | undefined;
    pick?: (draft: T, back: Page, set: (next: T) => void) => Page;
  };

  function form<T>(options: {
    title: string; draft: T; fields: Field<T>[]; back: Page;
    submitLabel?: string;
    submit: (player: Player, draft: T, recover: Page) => void; extras?: (menu: MenuInstance, draft: T, current: Page) => void;
  }): Page {
    const { title, fields, back } = options;
    const fieldSlots = [11, 13, 15, 20, 22, 24, 29, 31, 33];
    function show(draft: T): Page {
      return (player) => {
        const menu = new Menu(player, title, back);
        const current = show(draft);
        menu.item(4, { icon: "WRITABLE_BOOK", title, lore: options.submitLabel ? [] : ["Changes take effect when you select Save."] });
        fields.forEach((field, index) => {
          const { icon, hint, update, cycle, pick } = field;
          const apply = (next: T) => show(next)(player);
          const action = (click: Click) => {
            if (cycle) { apply(cycle(draft)); return; }
            if (pick && (!update || click === "right")) { pick(draft, current, apply)(player); return; }
            if (update) prompt(player, field.title, hint ?? "Enter a value.", current, (input) => apply(update(draft, input)));
          };
          menu.item(fieldSlots[index], {
            icon, title: field.title, lore: [field.value(draft), ...(hint ? [hint] : [])],
            action, preview: field.preview?.(draft),
          });
        });
        menu.button(49, "LIME_DYE", options.submitLabel ?? "Save", [], () => {
          try { options.submit(player, draft, current); }
          catch (error) { tell(player, error instanceof Error ? error.message : "Invalid changes.", "red"); }
        }, "green");
        options.extras?.(menu, draft, current);
        menu.open();
      };
    }
    return show(options.draft);
  }

  return { list, choose, confirm, form };
}

export function wrap(text: string, width = 46) {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const boundary = space > 0 ? space : width;
    lines.push(rest.slice(0, boundary));
    rest = rest.slice(boundary).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}
