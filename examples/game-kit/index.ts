export class MatchQueue {
    private readonly queued = new Map<string, string>();

    get size(): number { return this.queued.size; }
    get partyCount(): number {
        return new Set([...this.queued.values()].filter((name) => name.startsWith("party:"))).size;
    }

    join(player: string, party?: string): void {
        this.queued.set(player, party ? "party:" + party : "player:" + player);
    }

    leave(player: string): void {
        this.queued.delete(player);
    }

    groups(capacity: number): string[][] {
        const parties = new Map<string, string[]>();
        for (const [player, party] of this.queued) {
            const members = parties.get(party) ?? [];
            members.push(player);
            parties.set(party, members);
        }
        const result = [];
        for (const members of parties.values()) {
            if (members.length > capacity) continue;
            result.push(members);
            capacity -= members.length;
        }
        return result;
    }
}

export function actionBar(players: Iterable<Player>, message: string): void {
    rune.adventure.actionBar([...players], message);
}
