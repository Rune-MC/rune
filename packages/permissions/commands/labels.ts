import { contexts, priorities, subjects } from "./suggestions.ts";
import { setLabel, type LabelKind, type Subject } from "../changes.ts";
import { permit, edit, groups, parseContext, target } from "./shared.ts";

const priorityArg = { type: "int", min: -100000, max: 100000, suggest: priorities } as const;

function label(ctx: CommandCtx, subject: string, kind: LabelKind, priority: number, input: string, scope?: string) {
  const text = input.trim();
  if (!text || text.length > 160) { ctx.sender.sendMessage("Use 1–160 characters of MiniMessage."); return; }
  if (text !== "-") {
    try { rune.adventure.miniMessage(text); }
    catch { ctx.sender.sendMessage("That label contains invalid MiniMessage."); return; }
  }
  const person = subject.startsWith("user:") ? target(subject.slice(5)) : undefined;
  if (!person && subject.startsWith("user:")) {
    ctx.sender.sendMessage("Use a known player name or UUID.");
    return;
  }
  edit(ctx, `Updated ${kind} ${priority} for ${subject} (${scope ?? "global"}).`, (data) => {
    const context = parseContext(scope);
    const owner: Subject = person ? { type: "player", id: person.id } :
      { type: "group", id: subject.replace(/^group:/, "") };
    setLabel(owner, kind, priority, context, text === "-" ? undefined : { priority, text, context })(data);
  });
}

@Command("permissions prefix", permit("label.prefix"))
export class Prefix {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("priority", priorityArg) priority!: number;
  @Arg("text", { type: "greedy", suggest: ["-"] }) text!: string;
  @Run run(ctx: CommandCtx) { label(ctx, this.group, "prefix", this.priority, this.text); }
}

@Command("permissions suffix", permit("label.suffix"))
export class Suffix {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("priority", priorityArg) priority!: number;
  @Arg("text", { type: "greedy", suggest: ["-"] }) text!: string;
  @Run run(ctx: CommandCtx) { label(ctx, this.group, "suffix", this.priority, this.text); }
}

@Command("permissions label", permit("label.set"))
export class ScopedLabel {
  @Arg("subject", { type: "string", suggest: subjects }) subject!: string;
  @Arg("kind", { type: "word", suggest: ["prefix", "suffix"] }) kind!: LabelKind;
  @Arg("priority", priorityArg) priority!: number;
  @Arg("context", { type: "string", suggest: contexts }) context!: string;
  @Arg("text", { type: "greedy", suggest: ["-"] }) text!: string;
  @Run run(ctx: CommandCtx) {
    if (this.kind !== "prefix" && this.kind !== "suffix") { ctx.sender.sendMessage("Choose prefix or suffix."); return; }
    label(ctx, this.subject, this.kind, this.priority, this.text, this.context);
  }
}
