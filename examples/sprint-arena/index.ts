import { actionBar, MatchQueue } from "@rune/game-kit";

interface Point { world: string; x: number; y: number; z: number }
interface Match { started: number; duration: number; finish: Point; players: Set<string> }

const config = rune.config("sprint-arena", {
    "minimum-players": { default: 2, min: 1, max: 20, label: "Minimum players" },
    "maximum-players": { default: 12, min: 1, max: 30, label: "Maximum players" },
    "round-seconds": { default: 45, min: 5, max: 300, label: "Round duration in seconds" },
});
const state = rune.store("sprint-arena");
const queued = new MatchQueue();
let match: Match | undefined;

function playerId(player: Player): string {
    return String(player.getUniqueId());
}

function point(location: Location): Point {
    return { world: location.getWorld().getName(), x: location.getX(), y: location.getY(), z: location.getZ() };
}

function teleport(player: Player, target: Point): boolean {
    const world = rune.world(target.world);
    if (!world) return false;
    return player.teleport(rune.location(world, target.x, target.y, target.z));
}

function restore(player: Player): void {
    const key = "return-" + playerId(player);
    const target = state.get<Point>(key);
    if (target && teleport(player, target)) state.delete(key);
}

function finish(winner?: Player): void {
    const active = match;
    if (!active) return;
    match = undefined;
    rune.schedule.nextTick(() => {
        for (const id of active.players) {
            const player = online(id);
            if (player) restore(player);
        }
    });
    if (winner) {
        const name = winner.getName();
        const elapsedSeconds = (Date.now() - active.started) / 1000;
        const winsKey = "wins-" + playerId(winner);
        state.set(winsKey, (state.get<number>(winsKey) ?? 0) + 1);
        const { adventure } = rune;
        adventure.broadcast(adventure.format`<gold>${name}</gold> won the Sprint Arena in ${elapsedSeconds.toFixed(1)}s.`);
        void rune.events.emit("sprint-arena.finished", { playerId: playerId(winner), name, elapsedSeconds });
    } else {
        rune.broadcast("Sprint Arena timed out.");
    }
}

function online(id: string): Player | null {
    return rune.player(id);
}

function tryStart(): void {
    if (match) return;
    const start = state.get<Point>("start");
    const goal = state.get<Point>("finish");
    if (!start || !goal) return;
    const settings = config.read();
    const minimum = Math.ceil(settings["minimum-players"]);
    const groups = queued.groups(Math.max(minimum, Math.floor(settings["maximum-players"])));
    if (groups.flat().length < minimum) return;
    const next: Match = { started: Date.now(), duration: settings["round-seconds"], finish: goal, players: new Set() };
    for (const group of groups) {
        const players = group.map(online).filter((player): player is Player => player !== null);
        if (players.length !== group.length || group.some((id) => state.has("return-" + id))) continue;
        const moved: Player[] = [];
        for (const player of players) {
            const returnKey = "return-" + playerId(player);
            state.set(returnKey, point(player.getLocation()));
            if (!teleport(player, start)) {
                state.delete(returnKey);
                for (const prior of moved) restore(prior);
                break;
            }
            moved.push(player);
        }
        if (moved.length === group.length) for (const id of group) next.players.add(id);
    }
    if (next.players.size < minimum) {
        for (const id of next.players) {
            const player = online(id);
            if (player) restore(player);
        }
        return;
    }
    for (const id of next.players) queued.leave(id);
    match = next;
    rune.broadcast("Sprint Arena started. Reach the finish first!");
}

rune.command({
    name: "arena",
    description: "Join or set up Sprint Arena",
    subcommands: [
        {
            name: "join",
            args: [{ name: "party", type: "word", optional: true }],
            run({ sender, args }) {
                if (!sender.isPlayer) return;
                const player = sender as unknown as Player;
                if (match?.players.has(playerId(player))) return;
                if (!state.has("start") || !state.has("finish")) {
                    sender.sendMessage("An operator needs to set the start and finish.");
                    return;
                }
                queued.join(playerId(player), args.party);
                sender.sendMessage(args.party ? `Queued with party ${args.party}.` : "Queued for Sprint Arena.");
            },
        },
        {
            name: "leave",
            run({ sender }) {
                if (!sender.isPlayer) return;
                const player = sender as unknown as Player;
                const id = playerId(player);
                queued.leave(id);
                if (match?.players.delete(id)) restore(player);
                sender.sendMessage("Left Sprint Arena.");
            },
        },
        ...(["start", "finish"] as const).map((checkpoint) => ({
            name: "set-" + checkpoint,
            permission: "rune.admin",
            run({ sender }: rune.CommandCtx) {
                if (!sender.isPlayer) return;
                state.set(checkpoint, point((sender as unknown as Player).getLocation()));
                sender.sendMessage(`Set the arena ${checkpoint}.`);
            },
        })),
    ],
});

rune.on(Events.PlayerMoveEvent, (event) => {
    const active = match;
    if (!active?.players.has(playerId(event.getPlayer()))) return;
    const current = point(event.getTo());
    const goal = active.finish;
    if (current.world === goal.world &&
        Math.hypot(current.x - goal.x, current.y - goal.y, current.z - goal.z) < 1.5) {
        finish(event.getPlayer());
    }
});
rune.on(Events.PlayerQuitEvent, (event) => {
    const id = playerId(event.getPlayer());
    queued.leave(id);
    match?.players.delete(id);
});
rune.on(Events.PlayerJoinEvent, (event) => restore(event.getPlayer()));

rune.schedule.nextTick(() => {
    for (const player of rune.players()) restore(player);
});
rune.schedule.everyTicks(() => {
    const active = match;
    if (!active) { tryStart(); return; }
    const remaining = Math.ceil(active.duration - (Date.now() - active.started) / 1000);
    if (remaining <= 0 || !active.players.size) { finish(); return; }
    const players = [...active.players].map(online).filter((player): player is Player => player !== null);
    actionBar(players, `Sprint Arena · ${remaining}s left`);
}, 20);

rune.services.provide("sprint-arena", 1, {
    wins(playerUuid: string) { return state.get<number>("wins-" + playerUuid) ?? 0; },
    status() { return { queued: queued.size, racing: match?.players.size ?? 0 }; },
});

rune.dashboard.panel("sprint-arena", "Sprint Arena", () => ({
    "Queued players": queued.size,
    "Queued parties": queued.partyCount,
    "Racing players": match?.players.size ?? 0,
}));
