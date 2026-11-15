import { actionBar, MatchQueue } from "@rune/game-kit";
import { StorageInputError } from "@rune/storage";
import { playerId, point, restore, returnKey, state, teleport, type Point } from "./state.ts";

interface Match { started: number; duration: number; finish: Point; players: Set<string> }
const config = rune.config("sprint-arena", {
  "minimum-players": { default: 2, min: 1, max: 20, label: "Minimum players" },
  "maximum-players": { default: 12, min: 1, max: 30, label: "Maximum players" },
  "round-seconds": { default: 45, min: 5, max: 300, label: "Round duration in seconds" },
});
const queue = new MatchQueue();
let match: Match | undefined;
let pending: Set<string> | undefined;

export function join(player: Player, party?: string) {
  const id = playerId(player);
  if (!state.ready()) { player.sendMessage("Arena storage is loading."); return; }
  if (match?.players.has(id) || pending?.has(id)) return;
  if (!state.value().start || !state.value().finish) {
    player.sendMessage("An operator needs to set the start and finish.");
    return;
  }
  queue.join(id, party);
  player.sendMessage(party ? `Queued with party ${party}.` : "Queued for Sprint Arena.");
}

export function leave(player: Player) {
  const id = playerId(player);
  pending?.delete(id);
  queue.leave(id);
  if (match?.players.delete(id)) restore(player);
  player.sendMessage("Left Sprint Arena.");
}

function finish(winner?: Player) {
  const active = match;
  if (!active) return;
  match = undefined;
  rune.schedule.nextTick(() => {
    for (const id of active.players) {
      const player = rune.player(id);
      if (player) restore(player);
    }
  });
  if (!winner) { rune.broadcast("Sprint Arena timed out."); return; }
  const name = winner.getName();
  const id = playerId(winner);
  const key = "wins-" + id;
  const elapsedSeconds = (Date.now() - active.started) / 1000;
  state.edit((draft) => { draft[key] = Number(draft[key] ?? 0) + 1; }, () => {
    const { adventure } = rune;
    adventure.broadcast(adventure.format`<gold>${name}</gold> won the Sprint Arena in ${elapsedSeconds.toFixed(1)}s.`);
    void rune.events.emit("sprint-arena.finished", { playerId: id, name, elapsedSeconds });
  }, (message) => console.warn("Sprint Arena could not record the winner:", message));
}

function tryStart() {
  if (pending || !state.ready()) return;
  const data = state.value();
  const { start, finish: goal } = data;
  if (typeof start !== "object" || typeof goal !== "object") return;
  const settings = config.read();
  const minimum = Math.ceil(settings["minimum-players"]);
  const maximum = Math.max(minimum, Math.floor(settings["maximum-players"]));
  const groups = queue.groups(maximum).filter((group) => group.every((id) => !data[returnKey(id)] && rune.player(id)));
  const ids = groups.flat();
  if (ids.length < minimum) return;
  const positions = ids.map((id) => [returnKey(id), point(rune.player(id)!.getLocation())] as const);
  pending = new Set(ids);
  state.edit((draft) => {
    if (positions.some(([key]) => draft[key])) throw new StorageInputError("A queued player still has an arena return location.");
    for (const [key, saved] of positions) draft[key] = saved;
  }, () => {
    const candidates = pending!;
    const racers = new Set<string>();
    for (const group of groups) {
      const moved: Player[] = [];
      const available = group.every((id) => candidates.has(id) && rune.player(id));
      if (available) {
        for (const id of group) {
          const player = rune.player(id);
          if (!player || !teleport(player, start)) break;
          moved.push(player);
        }
      }
      if (moved.length === group.length) for (const id of group) racers.add(id);
      else {
        for (const id of group) {
          const player = rune.player(id);
          if (player) restore(player);
        }
      }
    }
    pending = undefined;
    if (racers.size < minimum) {
      for (const id of racers) {
        const player = rune.player(id);
        if (player) restore(player);
      }
      return;
    }
    for (const id of racers) queue.leave(id);
    match = { started: Date.now(), duration: settings["round-seconds"], finish: goal, players: racers };
    rune.broadcast("Sprint Arena started. Reach the finish first!");
  }, (message) => {
    pending = undefined;
    console.warn("Sprint Arena start was deferred:", message);
  });
}

@Listener
export class ArenaEvents {
  @EventHandler(Events.PlayerMoveEvent)
  move(event: PlayerMoveEvent) {
    const active = match;
    if (!active?.players.has(playerId(event.getPlayer()))) return;
    const current = point(event.getTo());
    const goal = active.finish;
    if (current.world === goal.world && Math.hypot(current.x - goal.x, current.y - goal.y, current.z - goal.z) < 1.5) {
      finish(event.getPlayer());
    }
  }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) {
    const id = playerId(event.getPlayer());
    queue.leave(id);
    pending?.delete(id);
    match?.players.delete(id);
  }

  @EventHandler(Events.PlayerJoinEvent)
  join(event: PlayerJoinEvent) { restore(event.getPlayer()); }
}

rune.schedule.everyTicks(() => {
  const active = match;
  if (!active) {
    if (!pending) for (const player of rune.players()) restore(player);
    tryStart();
    return;
  }
  const remaining = Math.ceil(active.duration - (Date.now() - active.started) / 1000);
  if (remaining <= 0 || !active.players.size) { finish(); return; }
  const players = [...active.players].map((id) => rune.player(id)).filter((player): player is Player => !!player);
  actionBar(players, `Sprint Arena · ${remaining}s left`);
}, 20);

rune.services.provide("sprint-arena", 1, {
  wins: (uuid: string) => Number(state.value()["wins-" + uuid] ?? 0),
  status: () => ({ queued: queue.size, racing: match?.players.size ?? 0 }),
});

rune.dashboard.panel("sprint-arena", "Sprint Arena", () => ({
  "Queued players": queue.size,
  "Queued parties": queue.partyCount,
  "Racing players": match?.players.size ?? 0,
}));
