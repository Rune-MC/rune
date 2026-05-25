package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.Path

/**
 * Creates a new script folder under `plugins/Rune/scripts/<name>/` from a
 * bundled language-specific template. The template tree lives at
 * `resources/templates/<lang>/`; each file gets its `__SCRIPT_NAME__`
 * placeholder replaced with the user's chosen name.
 *
 * Wired to the in-game `/rune new <name> [lang]` command. Language
 * surface today is only `ts` (libnode backend); structure is set up so
 * adding `py` / `lua` / etc. is a copy-the-template-folder job.
 */
class ScriptScaffolder(private val plugin: JavaPlugin) {

    fun availableLanguages(): List<String> = listOf("ts")

    /**
     * Result describes what happened so the caller can format a friendly
     * sender message. [created] is the absolute path of the new folder on
     * success; [error] is non-null on failure.
     */
    data class Result(val created: Path?, val error: String?)

    fun create(scriptsDir: Path, name: String, lang: String): Result {
        if (name.isBlank() || !name.matches(Regex("^[a-zA-Z0-9._-]+$"))) {
            return Result(null, "invalid script name '$name' (use letters, digits, '.', '-', '_')")
        }
        if (lang !in availableLanguages()) {
            return Result(null, "unknown language '$lang'. available: ${availableLanguages().joinToString()}")
        }
        val files = TEMPLATE_FILES[lang] ?: emptyList()
        if (files.isEmpty()) {
            return Result(null, "no template files registered for language '$lang'")
        }

        val dest = scriptsDir.resolve(name)
        if (Files.exists(dest)) {
            return Result(null, "script folder already exists: $dest")
        }
        Files.createDirectories(dest)

        for (file in files) {
            val resource = "/templates/$lang/$file"
            val stream = javaClass.getResourceAsStream(resource)
                ?: return Result(null, "template missing in jar: $resource")
            val body = stream.use { it.readBytes().toString(Charsets.UTF_8) }
            val substituted = body.replace("__SCRIPT_NAME__", name)
            Files.writeString(dest.resolve(file), substituted)
        }
        plugin.logger.info("scaffolded $lang script at $dest")
        return Result(dest, null)
    }

    companion object {
        // Per-language list of template filenames. Each must exist at
        // /templates/<lang>/<file> in the plugin jar.
        private val TEMPLATE_FILES: Map<String, List<String>> = mapOf(
            "ts" to listOf("index.ts", "rune.jsonc"),
        )
    }
}
