export function placeholders(player: OfflinePlayer, text: string): string {
    if (!rune.bukkit.getPluginManager().isPluginEnabled("PlaceholderAPI")) return text;
    return rune.callStatic("me.clip.placeholderapi.PlaceholderAPI", "setPlaceholders", player, text);
}
