import { normalizePositionName, resolvePosition, snapshot, type Position } from "@rune/positions";

interface Npc { id: string; title: string; line: string; at: Position }
const registry = rune.store("rune-npcs");
const tagPrefix = "rune-npc:";
const admin = { permission: "rune.admin" };
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
  for (const npc of registry.values() as Npc[]) updateEntity(npc);
});

@Listener
export class NpcEvents {
  @EventHandler(Events.ChunkLoadEvent)
  load(event: ChunkLoadEvent) {
    const loaded = event.getChunk();
    const world = loaded.getWorld().getName();
    const x = loaded.getX(), z = loaded.getZ();
    rune.schedule.nextTick(() => {
      for (const npc of registry.values() as Npc[]) {
        if (npc.at.world === world && chunk(npc.at.x) === x && chunk(npc.at.z) === z) updateEntity(npc);
      }
    });
  }

  @EventHandler(Events.PlayerInteractEntityEvent, { priority: "HIGH", ignoreCancelled: true })
  interact(event: PlayerInteractEntityEvent) {
    const id = taggedId(event.getRightClicked());
    if (!id) return;
    const npc = registry.get<Npc>(id);
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

const suggestions = () => registry.keys().sort();
function find(ctx: CommandCtx, input: string) {
  const id = normalizePositionName(input);
  const npc = id && registry.get<Npc>(id);
  if (npc) return npc;
  ctx.sender.sendMessage("NPC not found.");
  return null;
}

@Command("npc", { ...admin, description: "Manage interactive NPCs" })
export class ListNpcs {
  @Run run({ sender }: CommandCtx) { sender.sendMessage("NPCs: " + (suggestions().join(", ") || "none")); }
}

@Command("npc create", admin)
export class CreateNpc {
  @Arg("id", { type: "word" }) id!: string;
  @Arg("title", { type: "greedy", optional: true }) title?: string;
  @Run run({ sender }: CommandCtx) {
    if (!sender.isPlayer) { sender.sendMessage("Stand where the NPC should spawn."); return; }
    const id = normalizePositionName(this.id);
    if (!id || registry.has(id)) { sender.sendMessage("Choose a unique NPC ID (1–24 letters, digits, underscores or hyphens)."); return; }
    const title = this.title?.trim() || id;
    if (title.length > 64) { sender.sendMessage("Titles can be up to 64 characters."); return; }
    const npc = { id, title, line: "", at: snapshot((sender as unknown as Player).getLocation()) };
    registry.set(id, npc);
    updateEntity(npc);
    sender.sendMessage(`Created NPC ${id}.`);
  }
}

@Command("npc say", admin)
export class SetNpcDialogue {
  @Arg("id", { type: "word", suggest: suggestions }) id!: string;
  @Arg("line", { type: "greedy", optional: true }) line?: string;
  @Run run(ctx: CommandCtx) {
    const npc = find(ctx, this.id);
    if (!npc) return;
    const line = this.line?.trim() ?? "";
    if (line.length > 300) { ctx.sender.sendMessage("Dialogue can be up to 300 characters."); return; }
    registry.set(npc.id, { ...npc, line });
    ctx.sender.sendMessage("Dialogue saved.");
  }
}

@Command("npc remove", admin)
export class RemoveNpc {
  @Arg("id", { type: "word", suggest: suggestions }) id!: string;
  @Run run(ctx: CommandCtx) {
    const npc = find(ctx, this.id);
    if (!npc) return;
    registry.delete(npc.id);
    removeEntity(npc);
    ctx.sender.sendMessage(`Removed ${npc.id}.`);
  }
}
