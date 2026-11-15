export function regionsAt(location: Location): ReadonlySet<string> {
    const plugins = rune.bukkit.getPluginManager();
    if (!plugins.isPluginEnabled("WorldGuard") || !plugins.isPluginEnabled("WorldEdit")) {
        throw new Error("WorldGuard and WorldEdit are required for region lookups");
    }
    const worldguard = rune.callStatic("com.sk89q.worldguard.WorldGuard", "getInstance");
    const adapted = rune.callStatic("com.sk89q.worldedit.bukkit.BukkitAdapter", "adapt", location);
    const query = worldguard.getPlatform().getRegionContainer().createQuery();
    const result = query.getApplicableRegions(adapted);
    if (result.isVirtual()) throw new Error("WorldGuard returned virtual region data");
    const regions = new Set<string>();
    const iterator = result.getRegions().iterator();
    while (iterator.hasNext()) regions.add(iterator.next().getId());
    return regions;
}
