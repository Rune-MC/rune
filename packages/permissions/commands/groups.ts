import { createGroup, deleteGroup, groupWeight, inherit, setRule } from "../changes.ts";
import { admin, edit, expiry, fail, groups, parseContext, permissionNode, verb } from "./shared.ts";

@Command("permissions", { ...admin, description: "Manage groups, permissions, and player labels" })
export class ListGroups {
  @Run run({ sender }: CommandCtx) {
    sender.sendMessage("Groups: " + groups().join(", "));
    if (sender.isPlayer) sender.sendMessage("Open the Permissions Manager with /permissions gui.");
  }
}

@Command("permissions create", admin)
export class CreateGroup {
  @Arg("group", { type: "word" }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Created group ${this.group}.`, createGroup(this.group));
  }
}

@Command("permissions delete", admin)
export class DeleteGroup {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Deleted group ${this.group}.`, deleteGroup(this.group));
  }
}

@Command("permissions weight", admin)
export class GroupWeight {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("weight", { type: "int", min: -100000, max: 100000 }) weight!: number;
  @Run run(ctx: CommandCtx) { edit(ctx, `Set ${this.group} weight to ${this.weight}.`, groupWeight(this.group, this.weight)); }
}

@Command("permissions inherit", admin)
export class InheritGroup {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("parent", { type: "word", suggest: groups }) parent!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Updated inheritance for ${this.group}: ${this.parent}.`, inherit(this.group, this.parent, this.enabled !== false));
  }
}

@Command("permissions rule", admin)
export class GroupRule {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("node", { type: "string" }) node!: string;
  @Arg("value", { type: "word", suggest: verb }) value!: string;
  @Arg("context", { type: "string", optional: true }) context?: string;
  @Arg("duration", { type: "word", optional: true }) duration?: string;
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
