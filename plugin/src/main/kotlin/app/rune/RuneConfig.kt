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
    /**
     * npm-style package name this Rune publishes itself as. When set, the
     * loader materialises `scripts/node_modules/<name>/` as a junction to
     * this Rune's folder so other Runes can `import x from "<name>/subpath"`.
     * Supports scoped names like `@hylandia/core`.
     */
    val name: String? = null,
    /**
     * When true, the loader registers this Rune's package name + imports
     * but does NOT auto-execute any entry script. Intended for shared
     * library code (db client, helpers, types) consumed by other Runes.
     */
    val library: Boolean = false,
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
    /**
     * Per-folder library declarations. Each entry is a Rune folder that
     * declared a package `name` in its rune.jsonc, with whether it should
     * be auto-executed (`library = false`) or skipped (`library = true`).
     */
    val libraries: List<LibraryDecl> = emptyList(),
)

/**
 * A Rune folder that declared an importable package name. The loader
 * materialises a junction at `scripts/node_modules/<name>/` -> [folder],
 * regardless of whether the Rune is also auto-executed (`isLibrary=false`)
 * or library-only (`isLibrary=true`).
 */
data class LibraryDecl(
    val name: String,
    val folder: java.nio.file.Path,
    val isLibrary: Boolean,
)
