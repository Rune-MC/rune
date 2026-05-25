package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Extracts the JS runtime assets (esbuild-wasm + ts-loader hook) from the
 * plugin jar to a stable on-disk location so the Node bootstrap can
 * `module.register(...)` them.
 *
 * Bundled resource layout (see plugin/src/main/resources/runtime/):
 *   /runtime/esbuild.cjs    -- esbuild-wasm 0.24.0 JS host
 *   /runtime/esbuild.wasm   -- the WASM binary it loads
 *   /runtime/ts-loader.mjs  -- Node ESM loader that runs .ts through esbuild
 *
 * On-disk layout (under plugin dataFolder):
 *   <dataFolder>/runtime/...
 *
 * The Rust constructor reads the dataFolder via the scripts_dir parent and
 * surfaces the absolute path to the bootstrap as `RUNE_ESBUILD_DIR`.
 */
class RuntimeAssetExtractor(private val plugin: JavaPlugin) {

    fun extract(): Path {
        val outDir = plugin.dataFolder.toPath().resolve("runtime")
        Files.createDirectories(outDir)
        Files.createDirectories(outDir.resolve("lib"))
        Files.createDirectories(outDir.resolve("bin"))
        for (asset in ASSETS) {
            extractOne(asset, outDir)
        }
        plugin.logger.info("runtime assets extracted to $outDir")
        return outDir
    }

    private fun extractOne(name: String, outDir: Path) {
        val resourcePath = "/runtime/$name"
        val stream = javaClass.getResourceAsStream(resourcePath)
            ?: throw IllegalStateException("runtime asset missing from jar: $resourcePath")
        stream.use { input ->
            Files.copy(input, outDir.resolve(name), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    companion object {
        // Preserves the npm package layout esbuild-wasm expects: the Node
        // entry (lib/main.js) spawns bin/esbuild as a child process to run
        // the .wasm. Don't flatten -- esbuild's path resolution is brittle.
        private val ASSETS = listOf(
            "esbuild.wasm",
            "wasm_exec.js",
            "wasm_exec_node.js",
            "lib/main.js",
            "bin/esbuild",
            "ts-loader.mjs",
        )
    }
}
