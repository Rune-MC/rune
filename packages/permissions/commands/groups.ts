import { contexts, durations, possibleParents, priorities, ranks, ruleNodes } from "./suggestions.ts";
import { createGroup, deleteGroup, groupWeight, inherit, setRule } from "../changes.ts";
import { permit, edit, expiry, fail, groups, parseContext, permissionNode, verb } from "./shared.ts";

@Command("permissions", { description: "Manage groups, permissions, and player labels" })
export class ListGroups {
  @Run run({ sender }: CommandCtx) {
    if (!sender.hasPermission(permit("group.list").permission)) {
      sender.sendMessage("Requires rune.permissions.group.list.");
      return;
    }
    sender.sendMessage("Groups: " + groups().join(", "));
    if (sender.isPlayer && sender.hasPermission(permit("gui").permission)) sender.sendMessage("Open the Permissions Manager with /permissions gui.");
  }
}

@Command("permissions groups", permit("group.list"))
export class Groups {
  @Run run(ctx: CommandCtx) { new ListGroups().run(ctx); }
}

@Command("permissions create", permit("group.create"))
export class CreateGroup {
  @Arg("group", { type: "word" }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Created group ${this.group}.`, createGroup(this.group));
  }
}

@Command("permissions delete", permit("group.delete"))
export class DeleteGroup {
  @Arg("group", { type: "word", suggest: ranks }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Deleted group ${this.group}.`, deleteGroup(this.group));
  }
}

@Command("permissions weight", permit("group.weight"))
export class GroupWeight {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("weight", { type: "int", min: -100000, max: 100000, suggest: priorities }) weight!: number;
  @Run run(ctx: CommandCtx) { edit(ctx, `Set ${this.group} weight to ${this.weight}.`, groupWeight(this.group, this.weight)); }
}

@Command("permissions inherit", permit("group.inherit"))
export class InheritGroup {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("parent", { type: "word", suggest: possibleParents }) parent!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Updated inheritance for ${this.group}: ${this.parent}.`, inherit(this.group, this.parent, this.enabled !== false));
  }
}

@Command("permissions rule", permit("rule.group"))
export class GroupRule {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("node", { type: "string", suggest: ruleNodes }) node!: string;
  @Arg("value", { type: "word", suggest: verb }) value!: string;
  @Arg("context", { type: "string", suggest: contexts, optional: true }) context?: string;
  @Arg("duration", { type: "word", suggest: durations, optional: true }) duration?: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Updated ${this.group} ${this.node}: ${this.value} (${this.context ?? "global"}).`, (data) => {
      const node = permissionNode(this.node);
      const context = parseContext(this.context);
      const expiresAt = expiry(this.duration);
      if (!verb.includes(this.value)) fail("Choose allow, deny, or unset.");
      setRule({ type: "group", id: this.group }, node, context,
        this.value === "unset" ? undefined : { node, allow: this.value === "allow", context, expiresAt })(data);
    });
  }
}
