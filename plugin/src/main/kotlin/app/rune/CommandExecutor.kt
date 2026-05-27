package app.rune

import net.kyori.adventure.text.Component
import org.bukkit.plugin.java.JavaPlugin
import java.util.logging.Level

/**
 * Per-tick task that pumps each backend's internal scheduler, drains queued
 * host commands, and applies them via Bukkit. Scheduled on the global
 * region scheduler so the same code path works under both vanilla Paper
 * (where there's still a single main thread) and Folia (where the global
 * region thread serialises cross-region work). Folia removed
 * Bukkit.getScheduler() entirely; using globalRegionScheduler is the
 * forward-compatible API on both servers.
 */
class CommandExecutor(
    private val plugin: JavaPlugin,
    private val native: NativeLoader,
    private val subscribedEvents: MutableSet<String>,
    private val scriptCommands: ScriptCommandRegistry,
) : Runnable {

    fun start() {
        // The Consumer<ScheduledTask> parameter is ignored; we only need
        // the side effect of `run()`.
        plugin.server.globalRegionScheduler.runAtFixedRate(plugin, { _ -> run() }, 1L, 1L)
    }

    override fun run() {
        native.tick()
        val payload = native.drainCommands() ?: return
        val commands = try {
            HostCommandDecoder.decode(payload)
        } catch (e: Exception) {
            plugin.logger.severe("Failed to decode host commands: ${e.message}")
            return
        }
        for (cmd in commands) {
            try {
                execute(cmd)
            } catch (e: Exception) {
                plugin.logger.severe("Command $cmd failed: ${e.message}")
            }
        }
    }

    private fun execute(cmd: HostCommand) {
        when (cmd) {
            is HostCommand.Broadcast -> {
                plugin.server.broadcast(Component.text(cmd.message))
            }
            is HostCommand.Log -> {
                val line = "[rune:${cmd.script}:${cmd.level}] ${cmd.message}"
                // j.u.l. filters FINE/DEBUG below INFO by default; route debug
                // through INFO so users actually see their `console.debug` output.
                when (cmd.level) {
                    "warn" -> plugin.logger.warning(line)
                    "error" -> plugin.logger.severe(line)
                    else -> plugin.logger.info(line)
                }
            }
            is HostCommand.SubscribeEvent -> {
                subscribedEvents.add(cmd.name)
            }
            is HostCommand.RegisterCommand -> {
                scriptCommands.queue(cmd.spec)
            }
        }
    }
}
