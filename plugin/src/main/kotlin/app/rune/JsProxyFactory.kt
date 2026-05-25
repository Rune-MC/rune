package app.rune

import co.nstant.`in`.cbor.CborDecoder
import co.nstant.`in`.cbor.model.Array as CborArray
import co.nstant.`in`.cbor.model.DataItem
import co.nstant.`in`.cbor.model.Map as CborMap
import co.nstant.`in`.cbor.model.Number as CborNumber
import co.nstant.`in`.cbor.model.SimpleValue
import co.nstant.`in`.cbor.model.SimpleValueType
import co.nstant.`in`.cbor.model.UnicodeString
import java.io.ByteArrayOutputStream
import java.lang.reflect.Method
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import net.bytebuddy.ByteBuddy
import net.bytebuddy.description.method.MethodDescription
import net.bytebuddy.description.modifier.Visibility
import net.bytebuddy.dynamic.loading.ClassLoadingStrategy
import net.bytebuddy.dynamic.loading.MultipleParentClassLoader
import net.bytebuddy.implementation.MethodDelegation
import net.bytebuddy.implementation.bind.annotation.AllArguments
import net.bytebuddy.implementation.bind.annotation.FieldValue
import net.bytebuddy.implementation.bind.annotation.Origin
import net.bytebuddy.implementation.bind.annotation.RuntimeType
import net.bytebuddy.matcher.ElementMatchers

/**
 * Runtime Java-class generation for `rune.implement(class, methods)`.
 *
 * Generates a subclass of an arbitrary abstract class / implementation of an
 * arbitrary interface, with EVERY abstract method (plus any explicitly named
 * `extraMethods` the script wants to override) delegated through
 * [JsProxyDispatcher] back into the JS handler table.
 *
 * No PAPI / Vault / chat-plugin knowledge lives here -- this is a generic
 * bridge. PAPI is just the first user: scripts call
 * `rune.implement("me.clip.placeholderapi.expansion.PlaceholderExpansion",
 *   { getIdentifier: () => "rune", onRequest: (player, p) => ... })`
 * and the result is registered with PAPI like any other expansion.
 *
 * # Classloader plumbing
 *
 * The generated class needs to see BOTH its parent (e.g. PAPI's
 * `PlaceholderExpansion`, loaded by the PAPI plugin's classloader) AND the
 * Rune plugin's [JsProxyDispatcher] -- Paper plugins are classloader-
 * isolated by default. ByteBuddy's [MultipleParentClassLoader] gives the
 * generated class a parent chain that delegates to BOTH loaders, so vtable
 * lookups for the parent resolve in PAPI's loader and dispatcher lookups
 * resolve in ours.
 *
 * Subclasses are cached by `(parentClassName, sortedExtraMethods)` so a
 * second `rune.implement` for the same shape reuses the generated class
 * instead of regenerating it.
 */
object JsProxyFactory {

    /** Cache key. Sorted set so insertion order doesn't matter. */
    private data class CacheKey(val parentName: String, val extraMethods: Set<String>)

    private val classCache = ConcurrentHashMap<CacheKey, Class<*>>()
    private val proxyIdGen = AtomicLong(0)

    data class ProxyInstance(val proxyId: Long, val instance: Any)

    /**
     * Subclass [parent] (or, if it's an interface, implement it from
     * Object). Returns a fresh instance + a unique proxy id the JS side
     * keys its dispatch table on.
     *
     * `extraMethods` lets scripts override CONCRETE methods too -- if you
     * want to replace a default `persist()` impl on a PAPI expansion,
     * list "persist" here.
     */
    fun createProxy(
        parent: Class<*>,
        extraMethods: Set<String>,
    ): ProxyInstance {
        val cacheKey = CacheKey(parent.name, extraMethods.toSortedSet())
        val subclass = classCache.computeIfAbsent(cacheKey) { buildSubclass(parent, extraMethods) }
        val instance = subclass.getDeclaredConstructor().newInstance()
        val proxyId = proxyIdGen.incrementAndGet()
        // `_runeProxyId` lives on the generated subclass, not the parent --
        // we know it exists because buildSubclass defined it.
        subclass.getField("_runeProxyId").setLong(instance, proxyId)
        return ProxyInstance(proxyId, instance)
    }

    private fun buildSubclass(parent: Class<*>, extraMethods: Set<String>): Class<*> {
        // Match (a) every abstract method on the parent so the generated
        // class is concretely instantiable, and (b) any extra methods the
        // script wants to override even when they have default impls.
        val abstractOrNamed = ElementMatchers.isAbstract<MethodDescription>()
            .or(
                if (extraMethods.isEmpty()) ElementMatchers.none()
                else ElementMatchers.namedOneOf(*extraMethods.toTypedArray()),
            )

        // For pure interfaces, subclass Object and implement the interface;
        // ByteBuddy's `subclass(iface)` already handles this internally but
        // being explicit keeps the intent obvious.
        val raw = if (parent.isInterface) {
            ByteBuddy().subclass(Any::class.java).implement(parent)
        } else {
            ByteBuddy().subclass(parent)
        }

        val unloaded = raw
            .defineField("_runeProxyId", java.lang.Long.TYPE, Visibility.PUBLIC)
            .method(abstractOrNamed)
            .intercept(MethodDelegation.to(JsProxyDispatcher::class.java))
            .make()

        // Stack the parent's classloader + the Rune plugin's loader so
        // the generated class can resolve both PAPI's parent class AND
        // our dispatcher. WRAPPER (default for non-Java-8 strategies)
        // creates a new child loader off this merged parent, which is
        // exactly what we want -- no pollution of either side's loader.
        val parentLoader = parent.classLoader ?: ClassLoader.getSystemClassLoader()
        val mergedLoader = MultipleParentClassLoader.Builder()
            .append(parentLoader)
            .append(JsProxyFactory::class.java.classLoader)
            .build(parentLoader)

        return unloaded
            .load(mergedLoader, ClassLoadingStrategy.Default.WRAPPER)
            .loaded
    }
}

// ---------------------------------------------------------------------------
// Dispatcher -- called from the generated bytecode of every proxied method.
//
// Static (`@JvmStatic`) because `MethodDelegation.to(Class)` binds class-
// scoped methods. The Bridge holds the per-plugin state (loader callback,
// marshaller, ref registry) and is installed once at plugin enable.
// ---------------------------------------------------------------------------

object JsProxyDispatcher {

    /**
     * Per-plugin wiring: how to forward a proxied invocation into JS,
     * how to marshal Java args into CBOR, and how to look refs back up
     * for coercion.
     */
    class Bridge(
        val invoker: (Long, String, ByteArray) -> ByteArray,
        val marshaller: EventMarshaller,
        val registry: RefRegistry,
    )

    @Volatile
    private var bridge: Bridge? = null

    /**
     * Cache of (proxyId, methodName) -> last successful argless result.
     * Populated lazily on every successful 0-arg call. Used as a
     * fallback when the JS isolate signals "I don't know this proxy
     * anymore" (typical after /rune reload while a Java plugin still
     * holds the old instance) -- lets identity getters (PAPI's
     * getIdentifier, getAuthor, getVersion, persist, ...) keep working
     * across reloads instead of NPE'ing the holding plugin.
     */
    private val arglessCache = java.util.concurrent.ConcurrentHashMap<Pair<Long, String>, Any>()

    fun install(bridge: Bridge) { JsProxyDispatcher.bridge = bridge }
    fun uninstall() {
        bridge = null
        arglessCache.clear()
    }

    /**
     * Method body for every generated proxy method. Marshals the call
     * args through to JS via the installed invoker, decodes the CBOR
     * response, and coerces it back to the method's declared return type.
     *
     * @RuntimeType lets ByteBuddy bind us to methods of arbitrary return
     * types -- we return `Object?` and the dispatcher widens to whatever
     * the parent declared.
     */
    @JvmStatic
    @RuntimeType
    fun intercept(
        @FieldValue("_runeProxyId") proxyId: Long,
        @Origin method: Method,
        @AllArguments args: Array<Any?>?,
    ): Any? {
        val b = bridge
            ?: error("JsProxyDispatcher: bridge not installed (plugin not enabled?)")

        val argsList = args?.toList() ?: emptyList()
        // Marshal each arg through EventMarshaller so Bukkit-typed args
        // arrive in JS as proper ref-wrapped objects. Primitives, strings
        // and collections pass through naturally.
        val cborArgs = encodeArgsArray(argsList.map { b.marshaller.marshalValue(it) })
        val resultBytes = try {
            b.invoker(proxyId, method.name, cborArgs)
        } catch (t: Throwable) {
            // Surface invocation failures but don't propagate -- a thrown
            // exception out of (say) a PAPI placeholder would tear the
            // chat pipeline open. Returning the type's default is safer.
            android_like_log_error("invoke($proxyId, ${method.name}) failed", t)
            return defaultFor(method.returnType)
        }

        // Decode once so we can peek for the stale sentinel before
        // running the result through full coercion.
        val rawItem = if (resultBytes.isEmpty()) null
        else try {
            CborDecoder.decode(resultBytes).firstOrNull()
        } catch (_: Throwable) {
            null
        }

        // Stale sentinel = "isolate doesn't know this proxy id". Fall
        // back to the argless-getter cache so plugins holding the old
        // instance across /rune reload still get sane responses.
        if (isStaleSentinel(rawItem)) {
            val cached = arglessCache[proxyId to method.name]
            if (cached != null) return cached
            return defaultFor(method.returnType)
        }

        val coerced = coerceResultItem(rawItem, method, b.registry)
        // Cache successful 0-arg, non-null results so stale dispatches
        // for the same getter on the same proxy id can serve from here
        // later. (PAPI's getIdentifier/getAuthor/getVersion/persist all
        // qualify; onRequest takes args so it doesn't.)
        if (argsList.isEmpty() && coerced != null) {
            arglessCache[proxyId to method.name] = coerced
        }
        return coerced
    }

    private fun isStaleSentinel(item: DataItem?): Boolean {
        if (item !is CborMap) return false
        val v = item[UnicodeString("__rune_stale")]
        return v is SimpleValue && v.simpleValueType == SimpleValueType.TRUE
    }

    // The dispatcher is in the Rune-plugin classloader and doesn't have
    // access to a logger field, so route through stderr for now. We could
    // pull in a Logger via Bridge if it ever matters.
    private fun android_like_log_error(message: String, t: Throwable) {
        System.err.println("[rune] $message: ${t.javaClass.simpleName}: ${t.message}")
        t.printStackTrace(System.err)
    }

    /** CBOR-encode a List<Any?> as a top-level CBOR array. */
    private fun encodeArgsArray(args: List<Any?>): ByteArray {
        // EventEncoder treats top-level as a map; we want a top-level
        // array. Encode by wrapping in a one-entry map under a sentinel
        // key and stripping the wrapper? No -- simpler to write the head
        // by hand and let EventEncoder do each element.
        val bytes = ByteArrayOutputStream()
        // CBOR array head for `args.size` items (definite length).
        cborArrayHeader(bytes, args.size.toLong())
        for (a in args) {
            // EventEncoder.encode encodes a Map; for a single value, hand-
            // roll the recursive call through reflection... actually easier:
            // wrap each in a {wrap: value} map, take the value bytes via
            // the CborEncoder directly.
            val one = EventEncoder.encode(mapOf("v" to a))
            // `one` is a CBOR map with one (UnicodeString "v" -> value) entry.
            // Trim the map header + the key text+value head, leaving only
            // the value bytes. Quicker: re-emit by CborEncoder against the
            // raw DataItem. We'll just decode `one` and re-encode the value.
            val items = CborDecoder.decode(one)
            val map = items[0] as CborMap
            val value = map[UnicodeString("v")]
            val encoded = ByteArrayOutputStream()
            co.nstant.`in`.cbor.CborEncoder(encoded).encode(value)
            bytes.write(encoded.toByteArray())
        }
        return bytes.toByteArray()
    }

    private fun cborArrayHeader(out: ByteArrayOutputStream, n: Long) {
        // Definite-length CBOR array; mirrors cbor_uint(out, 0x80, n) on the
        // C++ side. Matches what CborDecoder reads on the receiving end.
        when {
            n < 24 -> out.write((0x80 or n.toInt()))
            n < 256 -> {
                out.write(0x98); out.write(n.toInt())
            }
            n < 65536 -> {
                out.write(0x99)
                out.write((n shr 8).toInt() and 0xFF)
                out.write(n.toInt() and 0xFF)
            }
            else -> {
                out.write(0x9A)
                out.write((n shr 24).toInt() and 0xFF)
                out.write((n shr 16).toInt() and 0xFF)
                out.write((n shr 8).toInt() and 0xFF)
                out.write(n.toInt() and 0xFF)
            }
        }
    }

    /**
     * Coerce an already-decoded CBOR DataItem to the method's declared
     * return type. Falls back to the type's default (null for refs, 0
     * for numerics, false for boolean) on any failure.
     *
     * Splitting decode + coerce lets the caller peek for our stale-proxy
     * sentinel (`{__rune_stale: true}`) before running coercion.
     */
    private fun coerceResultItem(item: DataItem?, method: Method, registry: RefRegistry): Any? {
        if (item == null) return defaultFor(method.returnType)
        if (item is SimpleValue && item.simpleValueType == SimpleValueType.NULL) {
            return defaultFor(method.returnType)
        }
        val coerced = ArgCoercer.coerce(item, method.genericReturnType, registry)
        if (coerced != null) return coerced
        return defaultFor(method.returnType)
    }

    /**
     * Type-safe default for a return slot. Returning `null` for primitives
     * would NPE at the bytecode boundary -- the JVM auto-unboxes a returned
     * null when the declared type is e.g. `int`.
     */
    private fun defaultFor(returnType: Class<*>): Any? = when (returnType) {
        java.lang.Boolean.TYPE -> false
        java.lang.Byte.TYPE -> 0.toByte()
        java.lang.Short.TYPE -> 0.toShort()
        java.lang.Integer.TYPE -> 0
        java.lang.Long.TYPE -> 0L
        java.lang.Float.TYPE -> 0.0f
        java.lang.Double.TYPE -> 0.0
        java.lang.Character.TYPE -> ' '
        java.lang.Void.TYPE -> null
        else -> null
    }
}
