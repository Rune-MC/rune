package app.rune

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Materialises library-Rune package mounts under `scripts/node_modules/<name>/`
 * so other Runes can `import { foo } from "<name>/subpath"` and Node's
 * built-in resolver does the rest.
 *
 * Two pieces per library:
 *   1. A junction (Windows) / symlink (POSIX) at
 *      `<scripts>/node_modules/<name>/` -> the library's source folder.
 *      Scoped names (`@hylandia/core`) create the `@hylandia` parent dir
 *      first.
 *   2. A minimal `package.json` inside the library's folder with
 *      `{"name": ..., "type": "module"}`. Required for Node to treat the
 *      package as ESM and to recognise it under the declared name.
 *      Generated only if the user hasn't supplied one.
 *
 * Idempotent: existing junctions matching the target are left alone;
 * mismatched ones are deleted and recreated.
 */
class LibraryLinker(private val plugin: JavaPlugin) {

    fun materialize(scriptsRoot: Path, libraries: List<LibraryDecl>) {
        if (libraries.isEmpty()) return
        val nodeModules = scriptsRoot.resolve("node_modules")
        Files.createDirectories(nodeModules)

        for (lib in libraries) {
            try {
                ensurePackageJson(lib)
                val mountPoint = resolveMountPoint(nodeModules, lib.name) ?: continue
                materializeLink(mountPoint, lib.folder, lib.name)
            } catch (e: Throwable) {
                plugin.logger.warning("library '${lib.name}': link failed: ${e.message}")
            }
        }
    }

    /**
     * Resolve `@scope/name` -> `nodeModules/@scope/name`, creating the
     * scope folder first. Plain names land directly under `node_modules`.
     * Returns null on malformed names (logged + skipped).
     */
    private fun resolveMountPoint(nodeModules: Path, name: String): Path? {
        if (name.isBlank()) return null
        // Scoped: `@scope/name` (one slash inside). Bare: `name` (no slash).
        return if (name.startsWith("@")) {
            val parts = name.split('/', limit = 2)
            if (parts.size != 2 || parts[0].length < 2 || parts[1].isBlank()) {
                plugin.logger.warning(
                    "library name '$name' is malformed; scoped names must be `@scope/name`"
                )
                return null
            }
            val scopeDir = nodeModules.resolve(parts[0])
            Files.createDirectories(scopeDir)
            scopeDir.resolve(parts[1])
        } else {
            if (name.contains('/') || name.contains('\\')) {
                plugin.logger.warning(
                    "library name '$name' is malformed; bare names cannot contain slashes"
                )
                return null
            }
            nodeModules.resolve(name)
        }
    }

    /**
     * If [mountPoint] already points at [target] (junction or symlink),
     * nothing to do. Otherwise remove anything in the way and create a
     * fresh junction (Windows) or symlink (POSIX).
     */
    private fun materializeLink(mountPoint: Path, target: Path, name: String) {
        val targetReal = target.toRealPath()

        if (Files.exists(mountPoint, LinkOption.NOFOLLOW_LINKS)) {
            val current = runCatching { mountPoint.toRealPath() }.getOrNull()
            if (current != null && current == targetReal) {
                return  // already correct
            }
            // Stale link / directory in the way. Remove it -- but ONLY if
            // it's a symlink, junction, or an empty directory. We must not
            // recursively delete a real folder the user might have populated.
            removeIfSafe(mountPoint)
        }

        if (isWindows()) {
            createJunction(mountPoint, target)
        } else {
            Files.createSymbolicLink(mountPoint, target)
        }
        plugin.logger.info("library '$name': linked $mountPoint -> $target")
    }

    private fun removeIfSafe(p: Path) {
        val isLink = Files.isSymbolicLink(p)
        if (isLink) {
            Files.delete(p)
            return
        }
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
            // Windows junctions don't always test true for isSymbolicLink.
            // Treat empty directories as removable; non-empty ones we leave
            // alone and surface a warning so the user can resolve manually.
            Files.list(p).use { stream ->
                if (stream.iterator().hasNext()) {
                    throw IllegalStateException(
                        "refusing to overwrite non-empty directory at $p"
                    )
                }
            }
            Files.delete(p)
            return
        }
        Files.delete(p)
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").lowercase().contains("win")

    /**
     * Use `mklink /J` for a directory junction. Junctions don't require
     * SeCreateSymbolicLinkPrivilege (which plain symlinks do on Windows
     * unless Developer Mode is on), so this works for every user.
     */
    private fun createJunction(link: Path, target: Path) {
        val process = ProcessBuilder(
            "cmd", "/c", "mklink", "/J",
            link.toString(),
            target.toAbsolutePath().toString(),
        ).redirectErrorStream(true).start()
        val out = process.inputStream.bufferedReader().readText()
        val ok = process.waitFor() == 0
        if (!ok) {
            throw RuntimeException("mklink /J failed: ${out.trim()}")
        }
    }

    /**
     * Ensure a package.json exists at the library root declaring `name` +
     * `type: module`. If one already exists, leave it untouched — the user
     * may have customised exports / dependencies / scripts.
     */
    private fun ensurePackageJson(lib: LibraryDecl) {
        val pkg = lib.folder.resolve("package.json")
        if (Files.exists(pkg)) return
        // Minimal manifest. Omitting `exports` keeps Node's classic
        // resolution active, so any subpath (`<name>/db`) just maps to the
        // matching file on disk.
        val content = """
            {
              "name": "${escapeJson(lib.name)}",
              "type": "module",
              "private": true
            }
        """.trimIndent() + "\n"
        val tmp = lib.folder.resolve("package.json.tmp")
        Files.writeString(tmp, content)
        Files.move(tmp, pkg, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    private fun escapeJson(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
