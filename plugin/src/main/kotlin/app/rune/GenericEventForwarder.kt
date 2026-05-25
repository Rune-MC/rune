package app.rune

import org.bukkit.Bukkit
import org.bukkit.event.Event
import org.bukkit.event.EventPriority
import org.bukkit.event.Listener
import org.bukkit.plugin.EventExecutor
import org.bukkit.plugin.java.JavaPlugin
import java.util.concurrent.atomic.AtomicLong
import java.util.logging.Level

/**
 * Registers a Bukkit listener for every [Event] subclass on the classpath
 * and forwards each fired event to the JS runtime via [NativeLoader].
 *
 * Subscription filter: dispatch is skipped unless at least one script has
 * called `rune.on(<simpleName>, ...)`. This is critical for high-frequency
 * events (EntityMoveEvent, PlayerInteractEvent in air, etc.); without it
 * we would burn the per-tick budget marshalling events that no one cares
 * about.
 *
 * Threading: events that fire async (chat, etc.) hop to the main thread
 * before dispatching, because the runtime is pinned (DESIGN_SPEC.md §7).
 */
class GenericEventForwarder(
    private val native: NativeLoader,
    private val plugin: JavaPlugin,
    private val subscribedEvents: MutableSet<String>,
    private val marshaller: EventMarshaller,
) : Listener {

    /** Total dispatched events; useful for the `/rune status` command. */
    val dispatchCount = AtomicLong(0)

    /**
     * Re-entry guard. Some Bukkit getters trigger nested events while we
     * marshal them; without this, our forwarder catches those nested events
     * and recurses until the stack overflows.
     */
    private val dispatching = ThreadLocal.withInitial { false }

    /**
     * Scans the classpath and registers a forwarder per event class. Returns
     * the number of classes successfully registered.
     */
    fun registerAll(): Int {
        val classes = EventDiscovery.discover(plugin)
        var registered = 0
        for (clazz in classes) {
            try {
                registerForwarder(clazz)
                registered += 1
            } catch (e: Throwable) {
                plugin.logger.fine("Skipped event ${clazz.simpleName}: ${e.message}")
            }
        }
        plugin.logger.info("Registered forwarders for $registered event classes")
        return registered
    }

    private fun registerForwarder(clazz: Class<out Event>) {
        val executor = EventExecutor { _, event ->
            if (event.javaClass != clazz) return@EventExecutor
            if (event.eventName !in subscribedEvents) return@EventExecutor

            if (Bukkit.isPrimaryThread()) {
                dispatch(event)
            } else {
                plugin.server.scheduler.runTask(plugin) { _ -> dispatch(event) }
            }
        }
        plugin.server.pluginManager.registerEvent(
            clazz,
            this,
            EventPriority.MONITOR,
            executor,
            plugin,
            /* ignoreCancelled = */ false,
        )
    }

    private fun dispatch(event: Event) {
        if (dispatching.get()) {
            // A getter on a parent event fired a child event while we were
            // reflecting. Drop the child to break the recursion; the parent
            // dispatch will complete normally.
            return
        }
        dispatching.set(true)
        try {
            val name = event.javaClass.simpleName
            val fields = try {
                marshaller.marshal(event)
            } catch (e: Throwable) {
                plugin.logger.log(Level.WARNING, "marshal $name failed", e)
                return
            }
            val payload = try {
                EventEncoder.encode(fields)
            } catch (e: Throwable) {
                plugin.logger.log(Level.WARNING, "encode $name failed", e)
                return
            }
            val rc = native.dispatchEvent(name, payload)
            if (rc != 0) {
                plugin.logger.warning("dispatch_event($name) returned $rc")
            }
            dispatchCount.incrementAndGet()
        } finally {
            dispatching.set(false)
        }
    }
}
