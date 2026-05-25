package app.rune

/**
 * Parsed `rune.jsonc` schema. Lives in any script-folder under `scripts/`
 * (including the root); on enable, all of them are walked and merged into
 * a single [MergedConfig].
 *
 * Example file:
 *   {
 *     "plugins": {
 *       "PlaceholderAPI": {
 *         "alias":    "papi",
 *         "package":  "me.clip.placeholderapi",
 *         "required": true
 *       }
 *     },
 *     "aliases": {
 *       "inventory": "bukkit.inventory",
 *       "mm":        "kyori.adventure.text.minimessage"
 *     }
 *   }
 */
data class RuneConfig(
    /** Map of Bukkit plugin name -> dep spec. Key matches plugin.yml `name`. */
    val plugins: Map<String, PluginDep> = emptyMap(),
    /** Map of `globalName` -> dotted path on globalThis (e.g. "bukkit.inventory"). */
    val aliases: Map<String, String> = emptyMap(),
    /**
     * Optional Maven coords for dev-time type extraction when a plugin
     * isn't installed on the server. Map of alias -> "group:artifact:version".
     * NOT YET IMPLEMENTED -- recorded so the plugin can warn the user the
     * feature is planned but not active. Scenario B in the design.
     */
    val maven: Map<String, String> = emptyMap(),
)

data class PluginDep(
    /** Optional shortcut global (e.g. `papi` -> me.clip.placeholderapi proxy). */
    val alias: String? = null,
    /**
     * Root package for ClassGraph type extraction. Required in v1; phase-2
     * will auto-derive from the plugin's main class in plugin.yml.
     */
    val `package`: String? = null,
    /**
     * If true and the plugin isn't loaded, the owning script folder is
     * skipped at load time. If false, the script still loads -- the user
     * is expected to handle the absent dep gracefully.
     */
    val required: Boolean = true,
)

/**
 * Result of merging every `rune.jsonc` under `scripts/`. Conflicts (e.g.
 * two configs declaring different `alias` for `inventory`) are resolved
 * last-wins with a warning at parse time.
 */
data class MergedConfig(
    val plugins: Map<String, PluginDep>,
    val aliases: Map<String, String>,
    val maven: Map<String, String> = emptyMap(),
)
