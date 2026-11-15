import { replaceWhere } from "../model.ts";
import { admin, edit, expiry, fail, group, groups, matchesContext, parseContext, permissionNode, playerAccess, target, verb } from "./shared.ts";

@Command("permissions member", admin)
export class GroupMember {
  @Arg("target", { type: "player" }) target!: Player | null;
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    if (!this.target) return;
    const id = String(this.target.getUniqueId()).toLowerCase();
    edit(ctx, `Updated global membership for ${this.target.getName()}: ${this.group}.`, (data) => {
      const rank = group(data, this.group).id;
      if (rank === "default") fail("Everyone already belongs to default.");
      const memberships = new Set(data.members[id] ?? []);
      if (this.enabled === false) memberships.delete(rank);
      else memberships.add(rank);
      if (memberships.size) data.members[id] = [...memberships];
      else delete data.members[id];
    });
  }
}

function groupGrant(ctx: CommandCtx, input: string, name: string, scope?: string, duration?: string, revoke = false) {
  const who = target(input);
  if (!who) { ctx.sender.sendMessage("Use an online player name or an offline UUID."); return; }
  const action = `${revoke ? "Revoked" : "Granted"} ${name} ${revoke ? "from" : "to"} ${who.name} (${scope ?? "global"}).`;
  edit(ctx, action, (data) => {
    const rank = group(data, name).id;
    if (rank === "default") fail("Everyone already belongs to default.");
    const context = parseContext(scope);
    const expiresAt = expiry(duration);
    const user = playerAccess(data, who.id);
    if (!context) {
      const remaining = (data.members[who.id] ?? []).filter((item) => item !== rank);
      if (!revoke && !expiresAt) remaining.push(rank);
      if (remaining.length) data.members[who.id] = remaining;
      else delete data.members[who.id];
    }
    user.grants = replaceWhere(user.grants,
      (grant) => grant.group === rank && matchesContext(grant, context),
      revoke || (!context && !expiresAt) ? undefined : { group: rank, context, expiresAt });
  });
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
      const user = playerAccess(data, who.id);
      user.rules = replaceWhere(user.rules, (rule) => rule.node === node && matchesContext(rule, context),
        this.value === "unset" ? undefined : { node, allow: this.value === "allow", context, expiresAt });
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
    edit(ctx, `Updated primary group for ${who.name}.`, (data) => {
      const access = playerAccess(data, who.id);
      if (this.group) access.primary = group(data, this.group).id;
      else delete access.primary;
    });
  }
}
