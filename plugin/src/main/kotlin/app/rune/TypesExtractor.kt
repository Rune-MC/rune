package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.jar.JarFile

/**
 * Drops the bundled developer-experience files next to the user's scripts so
 * VS Code / `tsc` resolve them automatically:
 *   * `rune.d.ts`        -- the rune-global API surface
 *   * `tsconfig.json`    -- with `"types": ["node"]` pre-wired
 *   * `node_modules/@types/node/...` -- vendored from npm; full Node 22 stdlib
 *
 * All three are plugin-version-pinned and overwritten on every enable. To
 * customise compiler options for a specific script folder, drop a
 * `tsconfig.json` inside it (it can `extends` the root config).
 */
class TypesExtractor(private val plugin: JavaPlugin) {

    /** Extracts `rune.d.ts`, `tsconfig.json`, and @types/node. Returns the d.ts path. */
    fun extract(): Path {
        val scriptsDir: Path = plugin.dataFolder.toPath().resolve("scripts")
        Files.createDirectories(scriptsDir)
        val dts = extractResource("/types/rune.d.ts", scriptsDir.resolve("rune.d.ts"))
        extractResource("/types/tsconfig.json", scriptsDir.resolve("tsconfig.json"))
        extractNodeTypes(scriptsDir)
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

    /**
     * Walk the jar's `/types/node/...` tree and mirror it into the user's
     * `scripts/node_modules/@types/node/` directory so `"types": ["node"]`
     * in tsconfig resolves without any `npm install` step.
     *
     * Done via [JarFile] enumeration rather than ClassLoader resource
     * scanning because Java has no built-in "list files in this resource
     * directory" API -- ClassLoader.getResources only enumerates top-level
     * entries.
     */
    private fun extractNodeTypes(scriptsDir: Path) {
        val typesRoot = scriptsDir.resolve("node_modules/@types/node")
        Files.createDirectories(typesRoot)

        val pluginJar = pluginJarFile() ?: run {
            plugin.logger.warning(
                "TypesExtractor: cannot locate plugin jar to extract @types/node " +
                    "-- TS users will see 'Cannot find module node:fs' until they " +
                    "install @types/node themselves."
            )
            return
        }

        var copied = 0
        JarFile(pluginJar).use { jar ->
            val prefix = "types/node/"
            for (entry in jar.entries()) {
                if (!entry.name.startsWith(prefix) || entry.isDirectory) continue
                val relative = entry.name.removePrefix(prefix)
                val target = typesRoot.resolve(relative)
                Files.createDirectories(target.parent)
                jar.getInputStream(entry).use { input ->
                    Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING)
                }
                copied++
            }
        }
        plugin.logger.info("@types/node extracted ($copied files) to $typesRoot")
    }

    /**
     * Resolve our own jar on disk. ProtectionDomain.codeSource.location
     * is the canonical path for a loaded plugin jar; if it ever returns
     * null (sealed classloader / unit test), we fall back to null so the
     * caller can degrade gracefully.
     */
    private fun pluginJarFile(): File? {
        val source = plugin.javaClass.protectionDomain?.codeSource?.location ?: return null
        return try {
            File(source.toURI())
        } catch (_: Throwable) {
            null
        }
    }
}
