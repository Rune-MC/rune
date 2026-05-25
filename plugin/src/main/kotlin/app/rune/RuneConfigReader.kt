package app.rune

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import org.bukkit.plugin.java.JavaPlugin
import java.io.StringReader
import java.nio.file.Files
import java.nio.file.Path
import kotlin.streams.toList

/**
 * Walks `scripts/` for every `rune.jsonc` file (root + each script-folder)
 * and merges them into a single [MergedConfig]. Conflicts last-wins with
 * a warning so the user sees them in the log.
 *
 * Comments are stripped before Gson parses (Gson is strict JSON; `.jsonc`
 * is the de-facto VS Code convention with `//` and `/* */`).
 */
class RuneConfigReader(private val plugin: JavaPlugin) {

    private val gson = Gson()

    fun load(scriptsDir: Path): MergedConfig {
        if (!Files.exists(scriptsDir)) return MergedConfig(emptyMap(), emptyMap())

        val configs = mutableListOf<Pair<Path, RuneConfig>>()
        Files.walk(scriptsDir, /* maxDepth */ 3).use { stream ->
            stream
                .filter { Files.isRegularFile(it) && it.fileName.toString() == "rune.jsonc" }
                .toList()
                .forEach { path ->
                    parseOne(path)?.let { configs.add(path to it) }
                }
        }

        return merge(configs)
    }

    private fun parseOne(path: Path): RuneConfig? {
        return try {
            val raw = Files.readString(path)
            // JSONC = JSON + comments + trailing commas. Gson's lenient
            // mode covers arrays' trailing commas but NOT objects', and
            // its comment handling is inconsistent across versions. So
            // we just pre-strip both ourselves before parsing.
            val sanitized = stripTrailingCommas(stripJsonComments(raw))
            val reader = JsonReader(StringReader(sanitized))
            reader.setStrictness(Strictness.LENIENT)
            gson.fromJson<RuneConfig>(reader, RuneConfig::class.java) ?: RuneConfig()
        } catch (e: JsonSyntaxException) {
            plugin.logger.warning("rune.jsonc parse error at $path: ${e.message}")
            null
        } catch (e: Throwable) {
            plugin.logger.warning("rune.jsonc read failed at $path: ${e.message}")
            null
        }
    }

    /**
     * Drop any `,` that's immediately followed by `}` or `]` (optionally
     * with whitespace between). String-aware so commas inside string
     * literals are left alone.
     */
    private fun stripTrailingCommas(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        var inString = false
        while (i < s.length) {
            val c = s[i]
            if (inString) {
                sb.append(c)
                if (c == '\\' && i + 1 < s.length) {
                    sb.append(s[i + 1]); i += 2; continue
                }
                if (c == '"') inString = false
                i++; continue
            }
            if (c == '"') {
                inString = true; sb.append(c); i++; continue
            }
            if (c == ',') {
                var j = i + 1
                while (j < s.length && s[j].isWhitespace()) j++
                if (j < s.length && (s[j] == '}' || s[j] == ']')) {
                    // skip the comma -- the closing brace/bracket comes next
                    i++; continue
                }
            }
            sb.append(c); i++
        }
        return sb.toString()
    }

    private fun merge(configs: List<Pair<Path, RuneConfig>>): MergedConfig {
        if (configs.isEmpty()) return MergedConfig(emptyMap(), emptyMap(), emptyMap())

        val mergedPlugins = LinkedHashMap<String, PluginDep>()
        val pluginOrigin = LinkedHashMap<String, Path>()
        val mergedAliases = LinkedHashMap<String, String>()
        val aliasOrigin = LinkedHashMap<String, Path>()
        val mergedMaven = LinkedHashMap<String, String>()

        for ((path, cfg) in configs) {
            for ((alias, coords) in cfg.maven) {
                mergedMaven[alias] = coords
            }
            for ((name, dep) in cfg.plugins) {
                val prior = pluginOrigin[name]
                if (prior != null) {
                    plugin.logger.warning(
                        "rune.jsonc: plugin '$name' redeclared in $path (first seen in $prior); last-wins"
                    )
                }
                mergedPlugins[name] = dep
                pluginOrigin[name] = path
            }
            for ((alias, target) in cfg.aliases) {
                val prior = aliasOrigin[alias]
                if (prior != null && mergedAliases[alias] != target) {
                    plugin.logger.warning(
                        "rune.jsonc: alias '$alias' redeclared in $path " +
                            "(was '${mergedAliases[alias]}' in $prior, now '$target'); last-wins"
                    )
                }
                mergedAliases[alias] = target
                aliasOrigin[alias] = path
            }
        }
        // Also fold plugin shortcut aliases ("PlaceholderAPI" -> alias "papi")
        // into the alias map so the bootstrap can install them with the
        // same machinery.
        for ((name, dep) in mergedPlugins) {
            val alias = dep.alias ?: continue
            val pkg = dep.`package` ?: continue
            if (alias in mergedAliases && mergedAliases[alias] != pkg) {
                plugin.logger.warning(
                    "rune.jsonc: alias '$alias' for plugin '$name' conflicts with " +
                        "existing alias '${mergedAliases[alias]}'; last-wins"
                )
            }
            mergedAliases[alias] = pkg
        }
        return MergedConfig(mergedPlugins, mergedAliases, mergedMaven)
    }

    /**
     * Strip `//` line comments and `/* */` block comments. Naive: doesn't
     * understand comments inside strings, but for config files that's
     * fine -- legitimate `//` inside a JSON string is rare.
     */
    private fun stripJsonComments(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        var inString = false
        while (i < s.length) {
            val c = s[i]
            if (inString) {
                sb.append(c)
                if (c == '\\' && i + 1 < s.length) {
                    sb.append(s[i + 1])
                    i += 2
                    continue
                }
                if (c == '"') inString = false
                i++
                continue
            }
            if (c == '"') {
                inString = true
                sb.append(c)
                i++
                continue
            }
            if (c == '/' && i + 1 < s.length) {
                val n = s[i + 1]
                if (n == '/') {
                    // line comment
                    i += 2
                    while (i < s.length && s[i] != '\n') i++
                    continue
                }
                if (n == '*') {
                    // block comment
                    i += 2
                    while (i + 1 < s.length && !(s[i] == '*' && s[i + 1] == '/')) i++
                    i += 2
                    continue
                }
            }
            sb.append(c)
            i++
        }
        return sb.toString()
    }
}
