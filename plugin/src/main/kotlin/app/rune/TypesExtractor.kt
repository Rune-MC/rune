package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Drops the bundled developer-experience files (`rune.d.ts`, `tsconfig.json`)
 * next to the user's scripts so VS Code / `tsc` resolve them automatically.
 *
 * Both files are plugin-version-pinned and overwritten on every enable. To
 * customise compiler options for a specific script, drop a `tsconfig.json`
 * inside a folder-script -- it can `extends` the root config.
 */
class TypesExtractor(private val plugin: JavaPlugin) {

    /** Extracts `rune.d.ts` and `tsconfig.json`; returns the d.ts path. */
    fun extract(): Path {
        val scriptsDir: Path = plugin.dataFolder.toPath().resolve("scripts")
        Files.createDirectories(scriptsDir)
        val dts = extractResource("/types/rune.d.ts", scriptsDir.resolve("rune.d.ts"))
        extractResource("/types/tsconfig.json", scriptsDir.resolve("tsconfig.json"))
        return dts
    }

    private fun extractResource(resourcePath: String, outFile: Path): Path {
        val stream = javaClass.getResourceAsStream(resourcePath)
            ?: throw IllegalStateException(
                "$resourcePath not bundled -- check shadowJar resources"
            )
        stream.use { input ->
            Files.copy(input, outFile, StandardCopyOption.REPLACE_EXISTING)
        }
        return outFile
    }
}
