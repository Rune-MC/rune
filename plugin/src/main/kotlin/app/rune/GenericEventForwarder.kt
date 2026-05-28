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
    private val subscribedEvents: MutableSet<Pair<String, EventPriority>>,
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
     * Bukkit class lookup keyed by `simpleName` — the wire identifier
     * the JS side uses for event names. Built once lazily; rebuilding
     * means rescanning the classpath which we do on /rune reload.
     */
    private var classByName: Map<String, Class<out Event>>? = null

    /**
     * Set of (event class, priority) tuples we've already registered
     * with Bukkit. Calling ensureRegistered with a known tuple is a
     * no-op so dynamic subscriptions are cheap.
     */
    private val registeredTuples = java.util.concurrent.ConcurrentHashMap.newKeySet<Pair<String, EventPriority>>()

    private fun classes(): Map<String, Class<out Event>> {
        val cached = classByName
        if (cached != null) return cached
        val discovered = EventDiscovery.discover(plugin).associateBy { it.simpleName }
        classByName = discovered
        return discovered
    }

    /**
     * Registers a Bukkit listener for each `(event, priority)` tuple
     * that's already accumulated in `subscribedEvents`. Used at plugin
     * startup once the initial script load has drained subscribe
     * commands. Returns the number of new registrations made (excludes
     * tuples already registered by a prior call).
     */
    fun registerAll(): Int {
        var registered = 0
        // Snapshot — concurrent mutation would just mean those entries
        // arrive via ensureRegistered later anyway.
        for ((name, priority) in subscribedEvents.toList()) {
            if (ensureRegistered(name, priority)) registered += 1
        }
        plugin.logger.info("Registered $registered event forwarder(s) across the subscribed set")
        return registered
    }

    /**
     * Idempotently register the (event, priority) tuple with Bukkit.
     * Returns true on a fresh registration; false when the tuple was
     * already registered (or skipped because the class isn't on the
     * classpath). Called by [CommandExecutor] each time a SubscribeEvent
     * command drains, so dynamic `rune.on(...)` calls past initial
     * startup also get a live Bukkit listener.
     */
    fun ensureRegistered(name: String, priority: EventPriority): Boolean {
        val key = name to priority
        if (!registeredTuples.add(key)) return false
        val clazz = classes()[name]
        if (clazz == null) {
            plugin.logger.warning("subscribed event '$name' is not on the classpath; skipping")
            // Remove the marker so a subsequent classpath update (e.g. a
            // dep load that brings the class in) can retry.
            registeredTuples.remove(key)
            return false
        }
        return try {
            registerForwarder(clazz, priority)
            true
        } catch (e: Throwable) {
            registeredTuples.remove(key)
            plugin.logger.fine("Skipped event $name@$priority: ${e.message}")
            false
        }
    }

    private fun registerForwarder(clazz: Class<out Event>, priority: EventPriority) {
        val priorityName = priority.name
        val executor = EventExecutor { _, event ->
            if (event.javaClass != clazz) return@EventExecutor

            if (Bukkit.isPrimaryThread()) {
                dispatch(event, priorityName)
            } else {
                // GlobalRegionScheduler works on both vanilla Paper (main
                // thread) and Folia (global region thread). On Folia
                // isPrimaryThread() returns false for every region thread,
                // so this defer path is always taken — which is the
                // correct, serialised place to invoke the single-threaded
                // JS runtime.
                Bukkit.getGlobalRegionScheduler().run(plugin) { _ -> dispatch(event, priorityName) }
            }
        }
        plugin.server.pluginManager.registerEvent(
            clazz,
            this,
            priority,
            executor,
            plugin,
            // ignoreCancelled is handled JS-side via per-handler opts so
            // we always receive the event and let the runtime filter.
            /* ignoreCancelled = */ false,
        )
    }

    private fun dispatch(event: Event, priorityName: String) {
        if (dispatching.get()) {
            // A getter on a parent event fired a child event while we were
            // reflecting. Drop the child to break the recursion; the parent
            // dispatch will complete normally.
            return
        }
        dispatching.set(true)
        try {
            val baseName = event.javaClass.simpleName
            val fields = try {
                marshaller.marshal(event)
            } catch (e: Throwable) {
                plugin.logger.log(Level.WARNING, "marshal $baseName failed", e)
                return
            }
            val payload = try {
                EventEncoder.encode(fields)
            } catch (e: Throwable) {
                plugin.logger.log(Level.WARNING, "encode $baseName failed", e)
                return
            }
            // Encode priority into the dispatched name so the JS side can
            // run only handlers registered at this priority — Bukkit fires
            // us once per (class, priority) registration, and each call
            // must reach the right subset of JS handlers. Two listeners
            // registered at NORMAL and MONITOR each receive their own
            // dispatch round-trip.
            val name = "$baseName#$priorityName"
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
