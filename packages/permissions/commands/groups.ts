import { emptyGroup, reachable, replaceWhere } from "../model.ts";
import { admin, edit, expiry, fail, group, groupAccess, groups, matchesContext, named, parseContext, permissionNode, verb } from "./shared.ts";

@Command("permissions", { ...admin, description: "Manage groups, permissions, and player labels" })
export class ListGroups {
  @Run run({ sender }: CommandCtx) { sender.sendMessage("Groups: " + groups().join(", ")); }
}

@Command("permissions create", admin)
export class CreateGroup {
  @Arg("group", { type: "word" }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Created group ${this.group}.`, (data) => {
      const id = named(this.group);
      if (Object.hasOwn(data.groups, id)) fail("Group already exists.");
      data.groups[id] = emptyGroup();
    });
  }
}

@Command("permissions delete", admin)
export class DeleteGroup {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Deleted group ${this.group}.`, (data) => {
      const { id } = group(data, this.group);
      if (id === "default") fail("The default group is required.");
      delete data.groups[id];
      for (const value of Object.values(data.groups)) value.parents = value.parents.filter((parent) => parent !== id);
      for (const [member, ranks] of Object.entries(data.members)) {
        const kept = ranks.filter((rank) => rank !== id);
        if (kept.length) data.members[member] = kept;
        else delete data.members[member];
      }
      for (const user of Object.values(data.players ?? {})) {
        if (user.primary === id) delete user.primary;
        if (user.grants) user.grants = user.grants.filter((grant) => grant.group !== id);
      }
      for (const [key, steps] of Object.entries(data.tracks ?? {})) {
        const kept = steps.filter((step) => step !== id);
        if (kept.length) data.tracks![key] = kept;
        else delete data.tracks![key];
      }
    });
  }
}

@Command("permissions weight", admin)
export class GroupWeight {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("weight", { type: "int", min: -100000, max: 100000 }) weight!: number;
  @Run run(ctx: CommandCtx) { edit(ctx, `Set ${this.group} weight to ${this.weight}.`, (data) => { group(data, this.group).value.weight = this.weight; }); }
}

@Command("permissions inherit", admin)
export class InheritGroup {
  @Arg("group", { type: "word", suggest: groups }) group!: string;
  @Arg("parent", { type: "word", suggest: groups }) parent!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Updated inheritance for ${this.group}: ${this.parent}.`, (data) => {
      const child = group(data, this.group);
      const parent = group(data, this.parent);
      const parents = new Set(child.value.parents);
      if (this.enabled === false) parents.delete(parent.id);
      else {
        if (reachable(new Map(Object.entries(data.groups)), [parent.id]).has(child.id)) fail("That inheritance would create a cycle.");
        parents.add(parent.id);
      }
      child.value.parents = [...parents];
    });
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
      const holder = group(data, this.group).value;
      const node = permissionNode(this.node);
      const context = parseContext(this.context);
      const expiresAt = expiry(this.duration);
      if (!verb.includes(this.value)) fail("Choose allow, deny, or unset.");
      const access = groupAccess(data, this.group);
      if (!context) delete holder.rules[node];
      access.rules = replaceWhere(access.rules, (item) => item.node === node && matchesContext(item, context),
        this.value === "unset" ? undefined : { node, allow: this.value === "allow", context, expiresAt });
    });
  }
}
