import { reachable, rulesFor, type Group } from "./model.ts";
import {
  change, emptyGroup, PermissionInputError, startBackend, state, type PermissionState,
} from "./backend.ts";

const metadataKey = "rune-permissions-attachment";
const playerId = (player: Player) => String(player.getUniqueId());
const memberships = (id: string) => state().members[id] ?? [];
const groupMap = (data = state()) => new Map(Object.entries(data.groups));

function owningPlugin() {
  return rune.bukkit.getPluginManager().getPlugin("Rune") as Plugin;
}

function detach(player: Player, plugin: Plugin) {
  for (const metadata of player.getMetadata(metadataKey)) {
    if (metadata.getOwningPlugin()?.getName() !== plugin.getName()) continue;
    try { player.removeAttachment(metadata.value() as PermissionAttachment); }
    catch (error) { console.warn("Could not remove previous Rune permissions attachment", error); }
  }
  player.removeMetadata(metadataKey, plugin);
}

function apply(player: Player) {
  const plugin = owningPlugin();
  detach(player, plugin);
  const rules = rulesFor(groupMap(), memberships(playerId(player)));
  if (!rules.size) return;
  const attachment = player.addAttachment(plugin);
  try {
    for (const [node, allowed] of rules) attachment.setPermission(node, allowed);
    player.setMetadata(metadataKey, new bukkit.metadata.FixedMetadataValue(plugin, attachment));
  } catch (error) {
    player.removeAttachment(attachment);
    throw error;
  }
}

function refresh() {
  for (const player of rune.players()) apply(player);
}

@Listener
export class PermissionsLifecycle {
  @EventHandler(Events.PlayerJoinEvent)
  join(event: PlayerJoinEvent) { apply(event.getPlayer()); }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) { detach(event.getPlayer(), owningPlugin()); }
}

rune.schedule.nextTick(refresh);
startBackend(refresh);
rune.services.provide("permissions", 1, {
  groups: (id: string) => [...reachable(groupMap(), ["default", ...memberships(id)])].sort(),
  rules: (id: string) => Object.fromEntries(rulesFor(groupMap(), memberships(id))),
});

const admin = { permission: "rune.admin" };
function operator(ctx: CommandCtx) {
  if (ctx.sender.isOp()) return true;
  ctx.sender.sendMessage("Only server operators can edit permission groups.");
  return false;
}
function groupId(input: string) {
  const id = input.toLowerCase();
  return /^[a-z][a-z0-9-]{0,31}$/.test(id) ? id : null;
}
function lookup(data: PermissionState, input: string): { id: string; group: Group } {
  const id = groupId(input);
  if (id && Object.hasOwn(data.groups, id)) return { id, group: data.groups[id] };
  throw new PermissionInputError("Unknown permission group.");
}
const suggest = () => Object.keys(state().groups).sort();
function edit(ctx: CommandCtx, transform: (data: PermissionState) => void, success: string) {
  if (!operator(ctx)) return;
  change(transform, (message) => ctx.sender.sendMessage(message), success);
}

@Command("permissions", { ...admin, description: "Manage permission groups" })
export class ListGroups {
  @Run run({ sender }: CommandCtx) { sender.sendMessage("Groups: " + suggest().join(", ")); }
}

@Command("permissions create", admin)
export class CreateGroup {
  @Arg("group", { type: "word" }) group!: string;
  @Run run(ctx: CommandCtx) {
    const id = groupId(this.group);
    if (!id) { ctx.sender.sendMessage("Choose a group name of 1–32 letters, digits, or hyphens."); return; }
    edit(ctx, (data) => {
      if (Object.hasOwn(data.groups, id)) throw new PermissionInputError("Group already exists.");
      data.groups[id] = emptyGroup();
    }, `Created ${id}.`);
  }
}

@Command("permissions delete", admin)
export class DeleteGroup {
  @Arg("group", { type: "word", suggest }) group!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, (data) => {
      const { id } = lookup(data, this.group);
      if (id === "default") throw new PermissionInputError("The default group is required.");
      delete data.groups[id];
      for (const group of Object.values(data.groups)) group.parents = group.parents.filter((parent) => parent !== id);
      for (const [member, groups] of Object.entries(data.members)) {
        const keep = groups.filter((group) => group !== id);
        if (keep.length) data.members[member] = keep;
        else delete data.members[member];
      }
    }, "Deleted group.");
  }
}

@Command("permissions inherit", admin)
export class AddParent {
  @Arg("group", { type: "word", suggest }) group!: string;
  @Arg("parent", { type: "word", suggest }) parent!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    edit(ctx, (data) => {
      const child = lookup(data, this.group);
      const parent = lookup(data, this.parent);
      const parents = new Set(child.group.parents);
      if (this.enabled === false) parents.delete(parent.id);
      else {
        if (child.id === parent.id || reachable(groupMap(data), [parent.id]).has(child.id)) {
          throw new PermissionInputError("That inheritance would create a cycle.");
        }
        parents.add(parent.id);
      }
      child.group.parents = [...parents];
    }, "Updated inheritance.");
  }
}

@Command("permissions rule", admin)
export class EditPermissionRule {
  @Arg("group", { type: "word", suggest }) group!: string;
  @Arg("node", { type: "word" }) node!: string;
  @Arg("value", { type: "word", suggest: ["allow", "deny", "unset"] }) value!: string;
  @Run run(ctx: CommandCtx) {
    const node = this.node.toLowerCase();
    if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(node) || node.length > 128 ||
        !["allow", "deny", "unset"].includes(this.value)) {
      ctx.sender.sendMessage("Use an exact dotted permission and allow, deny, or unset.");
      return;
    }
    edit(ctx, (data) => {
      const { group } = lookup(data, this.group);
      if (this.value === "unset") delete group.rules[node];
      else group.rules[node] = this.value === "allow";
    }, "Updated permission.");
  }
}

@Command("permissions member", admin)
export class EditGroupMember {
  @Arg("target", { type: "player" }) target!: Player | null;
  @Arg("group", { type: "word", suggest }) group!: string;
  @Arg("enabled", { type: "bool", optional: true }) enabled?: boolean;
  @Run run(ctx: CommandCtx) {
    if (!this.target) return;
    const id = playerId(this.target);
    const target = this.target.getName();
    edit(ctx, (data) => {
      const entry = lookup(data, this.group);
      if (entry.id === "default") throw new PermissionInputError("Everyone already belongs to default.");
      const updated = new Set(data.members[id] ?? []);
      if (this.enabled === false) updated.delete(entry.id);
      else updated.add(entry.id);
      if (updated.size) data.members[id] = [...updated];
      else delete data.members[id];
    }, `Updated groups for ${target}.`);
  }
}

@Command("permissions inspect", admin)
export class InspectPlayerGroups {
  @Arg("target", { type: "player" }) target!: Player | null;
  @Run run({ sender }: CommandCtx) {
    if (!this.target) return;
    const id = playerId(this.target);
    sender.sendMessage([...reachable(groupMap(), ["default", ...memberships(id)])].sort().join(", "));
    const permissions = rulesFor(groupMap(), memberships(id));
    sender.sendMessage(`${permissions.size} explicit permission rules.`);
  }
}
