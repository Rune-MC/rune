import { backend } from "../backend.ts";
import { setLabel, setRule, type LabelKind, type Subject } from "../changes.ts";
import { expiry, fail, parseContext, permissionNode } from "../commands/shared.ts";
import type { Label, Rule } from "../model.ts";
import { server } from "../settings.ts";
import { canEdit, save, type Page } from "./menu.ts";
import { choose, confirm, expirationText, form, list, numberBetween, scopeText, wrap } from "./widgets.ts";

const access = ({ type, id }: Subject) => {
  const data = backend.value();
  return type === "group" ? data.groups[id]?.profile : data.players?.[id];
};

export function registeredNodes() {
  return rune.bukkit.getPluginManager().getPermissions().map((permission: Permission) =>
    ({ name: permission.getName(), description: permission.getDescription() }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)) as Array<{ name: string; description: string }>;
}

export function nodePicker(back: Page, select: (node: string) => void) {
  return choose("Registered permission nodes", () => registeredNodes().map(({ name, description }) => ({
    icon: "PAPER", title: name, lore: wrap(description), open: () => select(name),
  })), back);
}

export function scopeField<T extends { scope: string }>() {
  return {
    title: "Context", icon: "COMPASS" as const, value: (draft: T) => draft.scope,
    hint: "Left-click to type • Right-click for presets",
    update: (draft: T, scope: string) => ({ ...draft, scope: scopeText(parseContext(scope)) }),
    pick: (draft: T, back: Page, select: (next: T) => void) => choose("Context presets", () => {
      const worlds = rune.bukkit.getWorlds().map((world) => ({
        title: world.getName(), icon: "GRASS_BLOCK" as const, lore: [`world=${world.getName()}`],
        open: () => select({ ...draft, scope: `world=${world.getName()}` }),
      }));
      return [
        { title: "Global", icon: "NETHER_STAR", open: () => select({ ...draft, scope: "global" }) },
        { title: "This server", icon: "BEACON", open: () => select({ ...draft, scope: `server=${server}` }) },
        ...worlds,
      ];
    }, back),
  };
}

export function durationField<T extends { duration?: string }>(existing?: number) {
  return {
    title: "Duration", icon: "CLOCK" as const,
    value: (draft: T) => draft.duration ?? expirationText({ expiresAt: existing }),
    hint: "Left-click to type • Right-click for presets",
    update: (draft: T, duration: string) => { expiry(duration); return { ...draft, duration: duration || "permanent" }; },
    pick: (draft: T, back: Page, select: (next: T) => void) => choose("Duration presets", () =>
      ["permanent", "30m", "1h", "1d", "7d", "30d"].map((duration) => ({
        title: duration, icon: "CLOCK", open: () => select({ ...draft, duration }),
      })), back),
  };
}

function ruleEditor(subject: Subject, name: string, back: Page, previous?: Rule): Page {
  return form<{ node: string; allow: boolean; scope: string; duration?: string }>({
    title: previous ? "Edit rule" : "New rule",
    draft: { node: previous?.node ?? "", allow: previous?.allow ?? true, scope: scopeText(previous?.context) },
    back,
    fields: [
      {
        title: "Permission node", icon: "PAPER", value: (value) => value.node || "Choose a node",
        hint: "Left-click to type • Right-click to browse",
        update: (draft, node) => ({ ...draft, node: permissionNode(node) }),
        pick: (draft, parent, select) => nodePicker(parent, (node) => select({ ...draft, node })),
      },
      { title: "Decision", icon: "LEVER", value: (draft) => draft.allow ? "Allow" : "Deny", cycle: (draft) => ({ ...draft, allow: !draft.allow }) },
      scopeField(),
      durationField(previous?.expiresAt),
    ],
    submit: (player, draft, retry) => {
      const node = permissionNode(draft.node);
      const context = parseContext(draft.scope);
      const rule = { node, context, allow: draft.allow, expiresAt: draft.duration === undefined ? previous?.expiresAt : expiry(draft.duration) };
      save(player, `Set ${node} to ${draft.allow ? "allow" : "deny"} for ${name} (${draft.scope}).`,
        setRule(subject, node, context, rule, previous ?? null), back, retry);
    },
    extras: (menu, _draft, current) => {
      if (!previous) return;
      menu.button(51, "LAVA_BUCKET", "Remove rule", [], () =>
        confirm("Remove rule?", [previous.node, scopeText(previous.context)], current, (player) =>
          save(player, `Removed ${previous.node} for ${name} (${scopeText(previous.context)}).`,
            setRule(subject, previous.node, previous.context, undefined, previous), back, current))(menu.player), "red");
    },
  });
}

export function rules(subject: Subject, name: string, back: Page): Page {
  return (player) => {
    const edit = canEdit(player);
    const page: Page = list({
      title: `${name} rules`, back,
      rows: () => {
        const legacy = subject.type === "group" ? backend.value().groups[subject.id]?.rules ?? {} : {};
        const entries: Rule[] = [...Object.entries(legacy).map(([node, allow]) => ({ node, allow })), ...access(subject)?.rules ?? []];
        return entries.sort((a, b) => a.node.localeCompare(b.node)).map((rule) => ({
          title: rule.node, icon: rule.allow ? "LIME_DYE" : "RED_DYE", color: rule.allow ? "green" : "red",
          lore: [rule.allow ? "Allow" : "Deny", scopeText(rule.context), expirationText(rule), ...(edit ? ["Click to edit"] : [])],
          open: edit ? ruleEditor(subject, name, page, rule) : undefined,
        }));
      },
      extras: (menu) => {
        if (edit) menu.button(0, "WRITABLE_BOOK", "New rule", [], () => ruleEditor(subject, name, page)(player), "green");
      },
    });
    page(player);
  };
}

function preview(text: string) {
  try { return text ? rune.adventure.miniMessage(text) : undefined; }
  catch { return undefined; }
}

function labelEditor(subject: Subject, name: string, kind: LabelKind, back: Page, previous?: Label): Page {
  return form<{ text: string; priority: number; scope: string }>({
    title: previous ? `Edit ${kind}` : `New ${kind}`, back,
    draft: { text: previous?.text ?? "", priority: previous?.priority ?? 0, scope: scopeText(previous?.context) },
    fields: [
      { title: "MiniMessage text", icon: "NAME_TAG", value: (draft) => draft.text.slice(0, 46) || "Enter label text",
        hint: "Example: <gold>[Guide]</gold>", update: (draft, text) => ({ ...draft, text }),
        preview: (draft) => preview(draft.text) },
      { title: "Priority", icon: "COMPARATOR", value: (draft) => String(draft.priority), hint: "Higher priorities display first.",
        update: (draft, text) => ({ ...draft, priority: numberBetween(text, -100000, 100000) }) },
      scopeField(),
    ],
    submit: (player, draft, retry) => {
      if (!draft.text || draft.text.length > 160) fail("Use 1–160 characters of MiniMessage.");
      if (!preview(draft.text)) fail("That label contains invalid MiniMessage.");
      const context = parseContext(draft.scope);
      save(player, `Saved ${name} ${kind} at priority ${draft.priority} (${draft.scope}).`,
        setLabel(subject, kind, draft.priority, context, { text: draft.text, priority: draft.priority, context, expiresAt: previous?.expiresAt }, previous ?? null), back, retry);
    },
    extras: (menu, _draft, current) => {
      if (!previous) return;
      menu.button(51, "LAVA_BUCKET", `Remove ${kind}`, [], () =>
        confirm(`Remove ${kind}?`, [name, `Priority ${previous.priority}`, scopeText(previous.context)], current, (player) =>
          save(player, `Removed ${name} ${kind} at priority ${previous.priority} (${scopeText(previous.context)}).`,
            setLabel(subject, kind, previous.priority, previous.context, undefined, previous), back, current))(menu.player), "red");
    },
  });
}

export function labels(subject: Subject, name: string, kind: LabelKind, back: Page): Page {
  return (player) => {
    const edit = canEdit(player);
    const page: Page = list({
      title: `${name} ${kind}es`, back,
      rows: () => [...access(subject)?.[kind] ?? []].sort((a, b) => b.priority - a.priority).map((label) => ({
        title: `Priority ${label.priority}`, icon: "NAME_TAG", lore: [scopeText(label.context), ...wrap(label.text)],
        preview: () => preview(label.text), open: edit ? labelEditor(subject, name, kind, page, label) : undefined,
      })),
      extras: (menu) => {
        if (edit) menu.button(0, "WRITABLE_BOOK", `New ${kind}`, [], () => labelEditor(subject, name, kind, page)(player), "green");
      },
    });
    page(player);
  };
}
