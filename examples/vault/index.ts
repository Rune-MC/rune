interface Economy {
    getBalance(player: OfflinePlayer): number;
    depositPlayer(player: OfflinePlayer, amount: number): {
        transactionSuccess(): boolean;
    };
}

export function vaultEconomy(): Economy | undefined {
    if (!rune.bukkit.getPluginManager().isPluginEnabled("Vault")) return undefined;
    const economyClass = rune.javaClass<Economy>("net.milkbowl.vault.economy.Economy");
    return rune.bukkit.getServicesManager().getRegistration(economyClass)?.getProvider();
}

export function deposit(player: OfflinePlayer, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) throw new RangeError("Use a positive amount");
    return vaultEconomy()?.depositPlayer(player, amount).transactionSuccess() ?? false;
}
