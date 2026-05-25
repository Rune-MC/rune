package app.rune

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Maps stable integer IDs to live Bukkit objects so scripts can reach back
 * across the FFI to call methods on them.
 *
 * When [EventMarshaller] reflects a Bukkit reference type (Player, Block,
 * etc.), it registers the live object here, embeds the resulting id under
 * `__ref` in the CBOR payload, and the JS side wraps the value in a Proxy
 * whose method calls translate to `HostCommand::Invoke { ref_id, ... }`.
 *
 * **Lifetime:** strong references for now -- entries never expire. Two
 * obvious next steps when this matters: (a) WeakReference values so the
 * JVM can collect when nothing holds the object, and (b) a per-handler
 * scope so refs auto-expire when the handler returns.
 */
class RefRegistry {
    private val next = AtomicInteger(1)
    private val refs = ConcurrentHashMap<Int, Any>()

    fun put(obj: Any): Int {
        val id = next.getAndIncrement()
        refs[id] = obj
        return id
    }

    fun get(id: Int): Any? = refs[id]

    fun size(): Int = refs.size

    /**
     * Drop every tracked reference and reset the id counter. Called by
     * `/rune reload` -- the freshly-spawned JS env has no knowledge of any
     * prior ref ids, so leaving them around just leaks Bukkit objects.
     */
    fun clear() {
        refs.clear()
        next.set(1)
    }
}
