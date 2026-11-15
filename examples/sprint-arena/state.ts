import { paperRecords } from "@rune/storage";

export interface Point { world: string; x: number; y: number; z: number }
export const state = paperRecords<Point | number>(rune, "sprint-arena", "sprint-arena");
export const returnKey = (id: string) => "return-" + id;
export const playerId = (player: Player) => String(player.getUniqueId());

export function point(location: Location): Point {
  return { world: location.getWorld().getName(), x: location.getX(), y: location.getY(), z: location.getZ() };
}

export function teleport(player: Player, target: Point): boolean {
  const world = rune.world(target.world);
  return !!world && player.teleport(rune.location(world, target.x, target.y, target.z));
}

const restoring = new Set<string>();
export function restore(player: Player) {
  const key = returnKey(playerId(player));
  const saved = state.value()[key];
  if (!saved || typeof saved !== "object" || restoring.has(key) || !teleport(player, saved)) return;
  restoring.add(key);
  state.edit((draft) => {
    if (JSON.stringify(draft[key]) === JSON.stringify(saved)) delete draft[key];
  }, () => restoring.delete(key), (message) => {
    restoring.delete(key);
    console.warn("Sprint Arena return location still needs clearing:", message);
  });
}
