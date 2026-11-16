package app.rune

import org.bukkit.Bukkit
import org.bukkit.event.HandlerList
import java.lang.management.ManagementFactory

object DashboardHost {
    @JvmStatic
    fun snapshot(): Map<String, Any?> {
        val server = Bukkit.getServer()
        val memory = ManagementFactory.getMemoryMXBean()
        val threads = ManagementFactory.getThreadMXBean()
        val jvm = ManagementFactory.getRuntimeMXBean()
        val rune = server.pluginManager.getPlugin("Rune") as? RunePlugin
        val tasks = runCatching { server.scheduler.pendingTasks.groupingBy { it.owner.name }.eachCount() }
            .getOrNull()
        return mapOf(
            "server" to mapOf(
                "version" to server.version,
                "minecraft" to server.minecraftVersion,
                "rune" to rune?.pluginMeta?.version,
                "java" to jvm.vmVersion,
                "online" to server.onlinePlayers.size,
                "capacity" to server.maxPlayers,
                "tps" to runCatching { server.tps.toList() }.getOrNull(),
                "mspt" to runCatching { server.averageTickTime }.getOrNull(),
            ),
            "jvm" to mapOf(
                "uptimeMs" to jvm.uptime,
                "heapUsed" to memory.heapMemoryUsage.used,
                "heapCommitted" to memory.heapMemoryUsage.committed,
                "heapMax" to memory.heapMemoryUsage.max.takeIf { it >= 0 },
                "nonHeapUsed" to memory.nonHeapMemoryUsage.used,
                "threads" to threads.threadCount,
                "peakThreads" to threads.peakThreadCount,
                "gc" to ManagementFactory.getGarbageCollectorMXBeans().map { bean ->
                    mapOf("name" to bean.name, "collections" to bean.collectionCount.takeIf { it >= 0 },
                        "timeMs" to bean.collectionTime.takeIf { it >= 0 })
                },
            ),
            "plugins" to server.pluginManager.plugins.sortedBy { it.name.lowercase() }.map { plugin ->
                val meta = plugin.pluginMeta
                mapOf("name" to plugin.name, "version" to meta.version, "enabled" to plugin.isEnabled,
                    "description" to meta.description, "authors" to meta.authors,
                    "listeners" to HandlerList.getRegisteredListeners(plugin).size,
                    "pendingTasks" to tasks?.getOrDefault(plugin.name, 0))
            },
            "worlds" to server.worlds.map { world ->
                mapOf("name" to world.name, "environment" to world.environment.name,
                    "players" to world.players.size, "chunks" to world.loadedChunks.size)
            },
            "players" to server.onlinePlayers.sortedBy { it.name.lowercase() }.map { player ->
                mapOf("name" to player.name, "id" to player.uniqueId.toString(), "world" to player.world.name,
                    "mode" to player.gameMode.name, "ping" to player.ping)
            },
            "scripts" to rune?.dashboardScripts().orEmpty(),
            "libraries" to rune?.dashboardLibraries().orEmpty(),
        )
    }
}
