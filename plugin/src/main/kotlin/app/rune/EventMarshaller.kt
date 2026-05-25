package app.rune

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer
import org.bukkit.Location
import org.bukkit.World
import org.bukkit.block.Block
import org.bukkit.entity.Entity
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.UUID

/**
 * Reads Bukkit event objects via reflection and produces a JS-friendly
 * snapshot of their fields. This is what makes "forward every event" work
 * without N hand-written marshallers.
 *
 * Strategy: walk every public no-arg method on the event's class (and its
 * supers), invoke it, and convert the result. `get` / `is` prefixes are
 * stripped; record-style getters (`message()`) are kept as-is.
 *
 * Bukkit reference types get a compact identifying snapshot, not a full
 * marshal -- e.g. `Player` -> `{type, name, uuid}`. Method calls back to
 * the live Bukkit object are the proxy work coming in a later release.
 */
class EventMarshaller(private val registry: RefRegistry) {

    private val plain = PlainTextComponentSerializer.plainText()

    /** Methods on every Bukkit Event that aren't event data. */
    private val skipMethods = setOf(
        "getClass", "hashCode", "toString", "clone",
        "notify", "notifyAll", "wait",
        "getHandlers", "getHandlerList", "getEventName",
        "isAsynchronous",
    )

    fun marshal(event: org.bukkit.event.Event): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        // Make the event itself callable from scripts too -- e.g.
        // `e.setCancelled(true)` works without us hand-listing every
        // Cancellable in the type map.
        out["__ref"] = registry.put(event)
        out["__class"] = event.javaClass.simpleName

        for (method in event.javaClass.methods) {
            if (!isGetter(method)) continue
            val propName = propertyName(method.name) ?: continue
            if (out.containsKey(propName)) continue
            try {
                val value = method.invoke(event)
                out[propName] = marshalValue(value)
            } catch (_: Throwable) {
                // Skip methods that throw (e.g. lazy-init paths that fail
                // on async-only state) -- they're never essential.
            }
        }
        return out
    }

    private fun isGetter(method: Method): Boolean {
        if (method.parameterCount != 0) return false
        if (!Modifier.isPublic(method.modifiers)) return false
        if (Modifier.isStatic(method.modifiers)) return false
        if (method.returnType == Void.TYPE) return false
        if (method.declaringClass == java.lang.Object::class.java) return false
        if (method.name in skipMethods) return false
        return true
    }

    private fun propertyName(methodName: String): String? = when {
        methodName.startsWith("get") &&
            methodName.length > 3 &&
            methodName[3].isUpperCase() ->
            methodName.substring(3).replaceFirstChar { it.lowercaseChar() }
        methodName.startsWith("is") &&
            methodName.length > 2 &&
            methodName[2].isUpperCase() ->
            methodName.substring(2).replaceFirstChar { it.lowercaseChar() }
        // Record-style / single-word accessor (e.g. AsyncChatEvent.message())
        methodName.isNotEmpty() && methodName[0].isLowerCase() -> methodName
        else -> null
    }

    /**
     * Convert a Bukkit value to something [EventEncoder] knows how to write.
     * Reference types collapse to identity maps so scripts can later look
     * the live object up by ref (via the proxy work coming next).
     */
    fun marshalValue(value: Any?): Any? = when (value) {
        null -> null
        is String, is Boolean -> value
        is Byte, is Short, is Int, is Long, is Float, is Double -> value
        is UUID -> value.toString()
        is Enum<*> -> value.name

        is Component -> mapOf(
            // Components are refs so users can call .color/.clickEvent/etc.
            // on them. `text` is the plain-text snapshot for quick
            // `event.message.text`-style access without an extra round-trip.
            "__ref" to registry.put(value),
            "__class" to "Component",
            "text" to plain.serialize(value),
        )

        is Player -> mapOf(
            "__ref" to registry.put(value),
            "__class" to "Player",
            "name" to value.name,
            "uuid" to value.uniqueId.toString(),
        )
        is Entity -> mapOf(
            "__ref" to registry.put(value),
            "__class" to value.javaClass.simpleName,
            "kind" to runCatching { value.type.key.toString() }.getOrDefault(""),
            "uuid" to value.uniqueId.toString(),
            "name" to runCatching { value.name }.getOrDefault(""),
        )
        is Block -> mapOf(
            "__ref" to registry.put(value),
            "__class" to "Block",
            "material" to runCatching { value.type.key.toString() }.getOrDefault(""),
            "x" to value.x,
            "y" to value.y,
            "z" to value.z,
            "world" to runCatching { value.world?.name ?: "" }.getOrDefault(""),
        )
        is Location -> mapOf(
            "__ref" to registry.put(value),
            "__class" to "Location",
            "x" to value.x,
            "y" to value.y,
            "z" to value.z,
            "yaw" to value.yaw,
            "pitch" to value.pitch,
            "world" to runCatching { value.world?.name ?: "" }.getOrDefault(""),
        )
        is World -> mapOf(
            "__ref" to registry.put(value),
            "__class" to "World",
            "name" to value.name,
            "uuid" to value.uid.toString(),
        )
        is ItemStack -> mapOf(
            "__ref" to registry.put(value),
            "__class" to "ItemStack",
            "material" to runCatching { value.type.key.toString() }.getOrDefault(""),
            "amount" to value.amount,
        )

        is Collection<*> -> value.map { marshalValue(it) }
        is Map<*, *> -> value.entries.associate { (k, v) -> k.toString() to marshalValue(v) }
        is Array<*> -> value.map { marshalValue(it) }

        else -> {
            // Anything reachable on the Bukkit / Paper / Kyori / NMS API
            // surface gets a generic ref-wrap so the JS proxy can call
            // methods on it. Without this, e.g. `sword.getItemMeta()` lands
            // in JS as a string (toString fallback) and `meta.setDisplayName`
            // throws "is not a function". The snapshot is empty -- callers
            // talk to the live object via __rune_invoke.
            //
            // Anything else (Optional, Stream, third-party types we don't
            // know how to wrap) falls back to toString so scripts at least
            // see a meaningful value rather than `[object Object]`.
            if (isWrappableRef(value)) {
                mapOf(
                    "__ref" to registry.put(value),
                    "__class" to apiClassName(value.javaClass),
                )
            } else {
                value.toString()
            }
        }
    }

    /**
     * Should we hand a generic ref-wrap for this object? Yes for anything
     * whose declared class (or any ancestor / interface) lives in a Bukkit
     * / Paper / Kyori / NMS package -- that's the surface scripts can
     * legitimately call back into. Filters out Java SE types we don't want
     * to proxy (String, Number, etc. already special-cased above, but also
     * Optional, Stream, Path...).
     */
    private fun isWrappableRef(value: Any): Boolean {
        var c: Class<*>? = value.javaClass
        while (c != null) {
            if (isApiClass(c)) return true
            for (iface in c.interfaces) {
                if (isApiClass(iface)) return true
            }
            c = c.superclass
        }
        return false
    }

    private fun isApiClass(c: Class<*>): Boolean {
        val n = c.name
        return n.startsWith("org.bukkit.") ||
            n.startsWith("io.papermc.paper.") ||
            n.startsWith("com.destroystokyo.paper.") ||
            n.startsWith("net.kyori.") ||
            n.startsWith("net.minecraft.")
    }

    /**
     * Prefer the public API class/interface name over the runtime Craft
     * implementation. `CraftItemMeta` becomes `ItemMeta`; `CraftPlayer`
     * becomes `Player`. Scripts compare `__class` for type checks, so the
     * stable API name is more useful.
     */
    private fun apiClassName(c: Class<*>): String {
        // Walk interfaces first -- they're the API surface.
        for (iface in c.interfaces) {
            if (isApiClass(iface)) return iface.simpleName
        }
        var cur: Class<*>? = c.superclass
        while (cur != null) {
            if (isApiClass(cur)) return cur.simpleName
            cur = cur.superclass
        }
        return c.simpleName
    }
}
