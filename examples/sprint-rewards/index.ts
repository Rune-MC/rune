import { deposit } from "@rune/vault";

const config = rune.config("sprint-rewards", {
    "payout": { default: 25, min: 0, label: "Vault payout per win" },
    "quest-wins": { default: 3, min: 1, label: "Wins to complete the sprint quest" },
});

rune.events.on<{ playerId: string; name: string; elapsedSeconds: number }>(
    "sprint-arena.finished",
    ({ playerId, name }) => {
        const player = rune.player(playerId);
        if (!player) return;
        const settings = config.read();
        if (settings.payout > 0 && !deposit(player, settings.payout)) {
            console.warn(`No Vault payout for ${name}. Check the economy provider.`);
        }
        const arena = rune.services.get<{ wins(id: string): number }>("sprint-arena", 1);
        if (arena?.wins(playerId) === Math.ceil(settings["quest-wins"])) {
            player.sendMessage("Sprint quest complete!");
        }
    },
);
