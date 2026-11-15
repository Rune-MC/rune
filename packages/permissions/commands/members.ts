import { grant, membership, primary, setRule } from "../changes.ts";
import { admin, edit, expiry, fail, groups, parseContext, permissionNode, target, verb } from "./shared.ts";

@Command("permissions member", admin)
export class GroupMember {
  @Arg("target", { type: "player" }) target!: Player | null;
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    if (!this.target) return;
    const id = String(this.target.getUniqueId()).toLowerCase();
    edit(ctx, `Updated global membership for ${this.target.getName()}: ${this.group}.`, membership(id, this.group, this.enabled !== false));
  }
}

function groupGrant(ctx: CommandCtx, input: string, name: string, scope?: string, duration?: string, revoke = false) {
  const who = target(input);
  if (!who) { ctx.sender.sendMessage("Use an online player name or an offline UUID."); return; }
  const action = `${revoke ? "Revoked" : "Granted"} ${name} ${revoke ? "from" : "to"} ${who.name} (${scope ?? "global"}).`;
  edit(ctx, action, (data) => grant(who.id, name, parseContext(scope), expiry(duration), revoke)(data));
}

@Command("permissions grant", admin)
export class GrantGroup {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("context", { type: "string", optional: true }) context?: string;
  @Arg("duration", { type: "word", optional: true }) duration?: string;
  @Run run(ctx: CommandCtx) { groupGrant(ctx, this.player, this.group, this.context, this.duration); }
}

@Command("permissions revoke", admin)
export class RevokeGroup {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("context", { type: "string", optional: true }) context?: string;
  @Run run(ctx: CommandCtx) { groupGrant(ctx, this.player, this.group, this.context, undefined, true); }
}

@Command("permissions user-rule", admin)
export class UserRule {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("node", { type: "string" }) node!: string;
  @Arg("value", { type: "word", suggest: verb }) value!: string;
  @Arg("context", { type: "string", optional: true }) context?: string;
  @Arg("duration", { type: "word", optional: true }) duration?: string;
  @Run run(ctx: CommandCtx) {
    const who = target(this.player);
    if (!who) { ctx.sender.sendMessage("Use an online player name or an offline UUID."); return; }
    edit(ctx, `Updated ${who.name} ${this.node}: ${this.value}.`, (data) => {
      if (!verb.includes(this.value)) fail("Choose allow, deny, or unset.");
      const node = permissionNode(this.node);
      const context = parseContext(this.context);
      const expiresAt = expiry(this.duration);
      setRule({ type: "player", id: who.id }, node, context,
        this.value === "unset" ? undefined : { node, allow: this.value === "allow", context, expiresAt })(data);
    });
  }
}

@Command("permissions primary", admin)
export class PrimaryGroup {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("group", { type: "word", suggest: groups, optional: true }) group?: string;
  @Run run(ctx: CommandCtx) {
    const who = target(this.player);
    if (!who) { ctx.sender.sendMessage("Use an online player name or an offline UUID."); return; }
    edit(ctx, `Updated primary group for ${who.name}.`, primary(who.id, this.group));
  }
}
