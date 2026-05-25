package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Extracts the platform-specific cdylib from the shaded jar to a stable on-disk
 * location so Panama FFM's `SymbolLookup.libraryLookup(path, ...)` can load it.
 *
 * Bundled resource layout (see plugin/build.gradle.kts shadowJar task):
 *   resources/native/windows-x86_64/rune_loader.dll
 *   resources/native/windows-x86_64/libnode.dll          (libnode backend only)
 *   resources/native/linux-x86_64/librune_loader.so
 *   resources/native/macos-aarch64/librune_loader.dylib
 *   ...
 *
 * When the loader was built with `--features node`, it transitively depends on
 * libnode.dll. The OS dynamic linker resolves that dependency by searching the
 * directory containing rune_loader.dll first, so we extract every sibling DLL
 * in the platform folder -- the JS-feature build has none, the node-feature
 * build has libnode.dll.
 */
class NativeLibraryExtractor(private val plugin: JavaPlugin) {

    fun extract(): Path {
        val (platformDir, libName) = detectPlatform()

        val outDir = plugin.dataFolder.toPath().resolve("native")
        Files.createDirectories(outDir)

        // 1. The primary loader -- mandatory.
        val loaderPath = extractOne(platformDir, libName, outDir)

        // 2. Any sibling shared libraries the loader depends on, then preload
        //    them via System.load. Windows' LoadLibrary search order does NOT
        //    include the directory of the DLL being loaded, so a plain
        //    libraryLookup on rune_loader.dll would fail to resolve its
        //    libnode.dll import. Preloading puts libnode.dll in the process's
        //    loaded-modules list; rune_loader's import resolver then finds
        //    it without any search-path mutation. On Linux/macOS rpath +
        //    $ORIGIN handles this transparently.
        for (sibling in PLATFORM_SIBLINGS[platformDir].orEmpty()) {
            val siblingPath = try {
                extractOne(platformDir, sibling, outDir)
            } catch (e: UnsatisfiedLinkError) {
                plugin.logger.fine("Optional sibling $sibling not bundled; skipping")
                continue
            }
            System.load(siblingPath.toAbsolutePath().toString())
            plugin.logger.info("Preloaded sibling native: $sibling")
        }

        return loaderPath
    }

    private fun extractOne(platformDir: String, fileName: String, outDir: Path): Path {
        val resourcePath = "/native/$platformDir/$fileName"
        val outFile = outDir.resolve(fileName)
        val stream = javaClass.getResourceAsStream(resourcePath)
            ?: throw UnsatisfiedLinkError(
                "Native library not bundled for this platform: $resourcePath"
            )
        stream.use { input ->
            Files.copy(input, outFile, StandardCopyOption.REPLACE_EXISTING)
        }
        return outFile
    }

    private fun detectPlatform(): Pair<String, String> {
        val osName = System.getProperty("os.name").lowercase()
        val arch = System.getProperty("os.arch").lowercase()

        val os = when {
            osName.contains("win") -> "windows"
            osName.contains("mac") || osName.contains("darwin") -> "macos"
            osName.contains("linux") -> "linux"
            else -> throw UnsatisfiedLinkError("Unsupported OS: $osName")
        }
        val cpu = when (arch) {
            "amd64", "x86_64" -> "x86_64"
            "aarch64", "arm64" -> "aarch64"
            else -> throw UnsatisfiedLinkError("Unsupported arch: $arch")
        }
        val libName = when (os) {
            "windows" -> "rune_loader.dll"
            "macos" -> "librune_loader.dylib"
            "linux" -> "librune_loader.so"
            else -> error("unreachable")
        }
        return "$os-$cpu" to libName
    }

    companion object {
        // Sibling shared libraries the loader depends on, keyed by platform
        // folder. The loader's own load attempt fails if any of these are
        // required but missing -- the extractor only logs at FINE so the
        // hosting plugin can surface its own error message.
        private val PLATFORM_SIBLINGS: Map<String, List<String>> = mapOf(
            "windows-x86_64" to listOf("libnode.dll"),
            // Linux / macOS libnode names follow if/when those builds land.
        )
    }
}
