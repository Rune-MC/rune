export interface Position {
  world: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function snapshot(location: Location): Position {
  return {
    world: location.getWorld().getName(),
    x: location.getX(), y: location.getY(), z: location.getZ(),
    yaw: location.getYaw(), pitch: location.getPitch(),
  };
}

export function resolvePosition(point: Position | undefined) {
  if (!point || typeof point.world !== "string" ||
      ![point.x, point.y, point.z, point.yaw, point.pitch].every(Number.isFinite)) return null;
  const world = rune.world(point.world);
  return world ? rune.location(world, point.x, point.y, point.z, point.yaw, point.pitch) : null;
}

export function teleportTo(entity: Pick<Player, "teleport">, point: Position | undefined) {
  const target = resolvePosition(point);
  if (!target) return { ok: false, reason: "unavailable" };
  return entity.teleport(target) ? { ok: true } : { ok: false, reason: "cancelled" };
}

export function normalizePositionName(value: unknown) {
  if (typeof value !== "string") return null;
  const id = value.toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,23}$/.test(id) ? id : null;
}
