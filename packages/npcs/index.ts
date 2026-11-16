import { normalizePositionName, resolvePosition, snapshot, type Position } from "@rune/positions";
import { paperRecords, StorageInputError } from "@rune/storage";

interface Npc { id: string; title: string; line: string; at: Position }
const registry = paperRecords<Npc>(rune, "npcs", "rune-npcs");
const tagPrefix = "rune-npc:";

const repeat = new Map<string, number>();
const chunk = (coordinate: number) => Math.floor(coordinate / 16);

function taggedId(entity: Entity) {
  for (const tag of entity.getScoreboardTags()) {
    if (tag.startsWith(tagPrefix)) return tag.slice(tagPrefix.length);
  }
  return null;
}

function updateEntity(npc: Npc) {
  const world = rune.world(npc.at.world);
  const cx = chunk(npc.at.x);
  const cz = chunk(npc.at.z);
  if (!world?.isChunkLoaded(cx, cz)) return;
  const found = world.getChunkAt(cx, cz).getEntities().filter((entity) => taggedId(entity) === npc.id);
  let entity = found[0];
  if (!entity) {
    const location = resolvePosition(npc.at);
    if (!location) return;
    const villager = world.spawnEntity(location, rune.entityType.VILLAGER as unknown as EntityType) as Villager;
    villager.addScoreboardTag(tagPrefix + npc.id);
    villager.setAI(false);
    villager.setSilent(true);
    villager.setCollidable(false);
    villager.setGravity(false);
    villager.setInvulnerable(true);
    villager.setRemoveWhenFarAway(false);
    villager.setPersistent(false);
    entity = villager;
  }
  entity.setCustomName(npc.title);
  entity.setCustomNameVisible(true);
  for (const duplicate of found.slice(1)) duplicate.remove();
}

function removeEntity(npc: Npc) {
  const world = rune.world(npc.at.world);
  const x = chunk(npc.at.x), z = chunk(npc.at.z);
  if (!world?.isChunkLoaded(x, z)) return;
  for (const entity of world.getChunkAt(x, z).getEntities()) {
    if (taggedId(entity) === npc.id) entity.remove();
  }
}

rune.schedule.nextTick(() => {
  for (const npc of Object.values(registry.value())) updateEntity(npc);
});

registry.onChange((previous, next) => {
  for (const [id, npc] of Object.entries(previous)) {
    if (!Object.hasOwn(next, id) || JSON.stringify(next[id].at) !== JSON.stringify(npc.at)) removeEntity(npc);
  }
  for (const [id, npc] of Object.entries(next)) {
    if (JSON.stringify(previous[id]) !== JSON.stringify(npc)) updateEntity(npc);
  }
});

@Listener
export class NpcEvents {
  @EventHandler(Events.ChunkLoadEvent)
  load(event: ChunkLoadEvent) {
    const loaded = event.getChunk();
    const world = loaded.getWorld().getName();
    const x = loaded.getX(), z = loaded.getZ();
    rune.schedule.nextTick(() => {
      for (const npc of Object.values(registry.value())) {
        if (npc.at.world === world && chunk(npc.at.x) === x && chunk(npc.at.z) === z) updateEntity(npc);
      }
    });
  }

  @EventHandler(Events.PlayerInteractEntityEvent, { priority: "HIGH", ignoreCancelled: true })
  interact(event: PlayerInteractEntityEvent) {
    const id = taggedId(event.getRightClicked());
    if (!id) return;
    const data = registry.value();
    const npc = Object.hasOwn(data, id) ? data[id] : undefined;
    if (!npc) return;
    event.setCancelled(true);
    if (String(event.getHand()) !== "HAND") return;
    const player = event.getPlayer();
    const playerId = String(player.getUniqueId());
    const now = Date.now();
    if ((repeat.get(playerId) ?? 0) > now) return;
    repeat.set(playerId, now + 350);
    if (npc.line) rune.adventure.send(player, rune.adventure.format`<gold>${npc.title}</gold>: ${npc.line}`);
    void rune.events.emit("npcs.interact", { npcId: id, playerId, playerName: player.getName() });
  }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) { repeat.delete(String(event.getPlayer().getUniqueId())); }
}

const suggestions = () => Object.keys(registry.value()).sort();
function find(data: Record<string, Npc>, input: string) {
  const id = normalizePositionName(input);
  if (!id || !Object.hasOwn(data, id)) throw new StorageInputError("NPC not found.");
  return data[id];
}

@Command("npc", { description: "Manage interactive NPCs" })
export class ListNpcs {
  @Run run({ sender }: CommandCtx) {
    if (!sender.hasPermission("rune.npcs.list")) {
      sender.sendMessage("Requires rune.npcs.list.");
      return;
    }
    sender.sendMessage("NPCs: " + (suggestions().join(", ") || "none"));
  }
}

@Command("npc list", { permission: "rune.npcs.list" })
export class NpcList {
  @Run run(ctx: CommandCtx) { new ListNpcs().run(ctx); }
}

@Command("npc create", { permission: "rune.npcs.create" })
export class CreateNpc {
  @Arg("id", { type: "word" }) id!: string;
  @Arg("title", { type: "greedy", optional: true }) title?: string;
  @Run run({ sender }: CommandCtx) {
    if (!sender.isPlayer) { sender.sendMessage("Stand where the NPC should spawn."); return; }
    const id = normalizePositionName(this.id);
    if (!id) { sender.sendMessage("Choose a unique NPC ID (1–24 letters, digits, underscores or hyphens)."); return; }
    const title = this.title?.trim() || id;
    if (title.length > 64) { sender.sendMessage("Titles can be up to 64 characters."); return; }
    const npc = { id, title, line: "", at: snapshot((sender as unknown as Player).getLocation()) };
    registry.edit((data) => {
      if (Object.hasOwn(data, id)) throw new StorageInputError("That NPC ID is already in use.");
      data[id] = npc;
    }, () => sender.sendMessage(`Created NPC ${id}.`), (message) => sender.sendMessage(message));
  }
}

@Command("npc say", { permission: "rune.npcs.say" })
export class SetNpcDialogue {
  @Arg("id", { type: "word", suggest: suggestions }) id!: string;
  @Arg("line", { type: "greedy", optional: true }) line?: string;
  @Run run(ctx: CommandCtx) {
    const line = this.line?.trim() ?? "";
    if (line.length > 300) { ctx.sender.sendMessage("Dialogue can be up to 300 characters."); return; }
    registry.edit((data) => { find(data, this.id).line = line; },
      () => ctx.sender.sendMessage("Dialogue saved."), (message) => ctx.sender.sendMessage(message));
  }
}

@Command("npc remove", { permission: "rune.npcs.remove" })
export class RemoveNpc {
  @Arg("id", { type: "word", suggest: suggestions }) id!: string;
  @Run run(ctx: CommandCtx) {
    registry.edit((data) => {
      const npc = find(data, this.id);
      delete data[npc.id];
      return npc.id;
    }, (id) => ctx.sender.sendMessage(`Removed ${id}.`), (message) => ctx.sender.sendMessage(message));
  }
}
