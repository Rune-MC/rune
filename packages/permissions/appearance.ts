const names = [
  { key: "rune-permissions-display", read: (p: Player) => p.displayName(), write: (p: Player, name: Component) => p.displayName(name) },
  { key: "rune-permissions-tab", read: (p: Player) => p.playerListName(), write: (p: Player, name: Component) => p.playerListName(name) },
];

export function ownedMetadata(player: Player, plugin: Plugin, key: string) {
  return player.getMetadata(key).find((entry) => entry.getOwningPlugin()?.getName() === plugin.getName());
}

export function putMetadata(player: Player, plugin: Plugin, key: string, value: unknown) {
  player.setMetadata(key, new bukkit.metadata.FixedMetadataValue(plugin, value));
}

export function decorateName(
  player: Player, plugin: Plugin, prefix: string[], suffix: string[], active: readonly boolean[],
) {
  for (const [index, target] of names.entries()) {
    const current = target.read(player);
    const prior = ownedMetadata(player, plugin, target.key)?.value() as Component | undefined;
    const original = ownedMetadata(player, plugin, target.key + "-base")?.value() as Component | undefined;
    const ours = prior && current.equals(prior);
    const base = ours && original ? original : current;
    if (!active[index] || (!prefix.length && !suffix.length)) {
      if (ours) target.write(player, base);
      player.removeMetadata(target.key, plugin);
      player.removeMetadata(target.key + "-base", plugin);
      continue;
    }
    let styled = rune.adventure.text("");
    for (const label of prefix) styled = styled.append(rune.adventure.miniMessage(label)).append(rune.adventure.text(" "));
    styled = styled.append(base);
    for (const label of suffix) styled = styled.append(rune.adventure.text(" ")).append(rune.adventure.miniMessage(label));
    if (!current.equals(styled)) target.write(player, styled);
    putMetadata(player, plugin, target.key, styled);
    putMetadata(player, plugin, target.key + "-base", base);
  }
}
