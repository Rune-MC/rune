package app.rune

import io.github.classgraph.ClassGraph
import org.bukkit.event.Event
import org.bukkit.plugin.java.JavaPlugin

/**
 * Scans the plugin classpath for every concrete subclass of [Event] and
 * returns them as a list. The plugin uses this once at enable time to
 * register a generic forwarder for each event class.
 *
 * Packages scanned:
 *   * `org.bukkit.event.**` -- Bukkit's stock events
 *   * `io.papermc.paper.event.**` -- Paper-added events
 *   * `com.destroystokyo.paper.event.**` -- legacy Paper events
 */
object EventDiscovery {

    private val DEFAULT_PACKAGES = arrayOf(
        "org.bukkit.event",
        "io.papermc.paper.event",
        "com.destroystokyo.paper.event",
    )

    fun discover(plugin: JavaPlugin, packages: Array<String> = DEFAULT_PACKAGES): List<Class<out Event>> {
        return ClassGraph()
            .overrideClassLoaders(plugin.javaClass.classLoader)
            .acceptPackages(*packages)
            .enableClassInfo()
            .scan()
            .use { result ->
                result.getSubclasses(Event::class.java.name)
                    .filter { !it.isAbstract && !it.isInterface }
                    .mapNotNull { info ->
                        try {
                            @Suppress("UNCHECKED_CAST")
                            info.loadClass() as Class<out Event>
                        } catch (e: Throwable) {
                            plugin.logger.fine("Could not load event class ${info.name}: ${e.message}")
                            null
                        }
                    }
                    .toList()
            }
    }
}
