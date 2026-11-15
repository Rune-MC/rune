import { replaceWhere } from "../model.ts";
import { admin, edit, fail, groupAccess, groups, matchesContext, parseContext, playerAccess, target } from "./shared.ts";

const priorities = { type: "int", min: -100000, max: 100000 } as const;
type Kind = "prefix" | "suffix";

function label(ctx: CommandCtx, subject: string, kind: Kind, priority: number, input: string, scope?: string) {
  const text = input.trim();
  if (!text || text.length > 160) { ctx.sender.sendMessage("Use 1–160 characters of MiniMessage."); return; }
  if (text !== "-") {
    try { rune.adventure.miniMessage(text); }
    catch { ctx.sender.sendMessage("That label contains invalid MiniMessage."); return; }
  }
  const person = subject.startsWith("user:") ? target(subject.slice(5)) : undefined;
  if (!person && subject.startsWith("user:")) {
    ctx.sender.sendMessage("Use an online player name or an offline UUID.");
    return;
  }
  edit(ctx, `Updated ${kind} ${priority} for ${subject} (${scope ?? "global"}).`, (data) => {
    const context = parseContext(scope);
    const access = person ? playerAccess(data, person.id) : groupAccess(data, subject.replace(/^group:/, ""));
    access[kind] = replaceWhere(access[kind], (item) => item.priority === priority && matchesContext(item, context),
      text === "-" ? undefined : { priority, text, context });
  });
}

@Command("permissions prefix", admin)
export class Prefix {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("priority", priorities) priority!: number;
  @Arg("text", { type: "greedy" }) text!: string;
  @Run run(ctx: CommandCtx) { label(ctx, this.group, "prefix", this.priority, this.text); }
}

@Command("permissions suffix", admin)
export class Suffix {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("priority", priorities) priority!: number;
  @Arg("text", { type: "greedy" }) text!: string;
  @Run run(ctx: CommandCtx) { label(ctx, this.group, "suffix", this.priority, this.text); }
}

@Command("permissions label", admin)
export class ScopedLabel {
  @Arg("subject", { type: "string" }) subject!: string;
  @Arg("kind", { type: "word", suggest: ["prefix", "suffix"] }) kind!: Kind;
  @Arg("priority", priorities) priority!: number;
  @Arg("context", { type: "string" }) context!: string;
  @Arg("text", { type: "greedy" }) text!: string;
  @Run run(ctx: CommandCtx) {
    if (this.kind !== "prefix" && this.kind !== "suffix") { ctx.sender.sendMessage("Choose prefix or suffix."); return; }
    label(ctx, this.subject, this.kind, this.priority, this.text, this.context);
  }
}
