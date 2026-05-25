package app.rune

import co.nstant.`in`.cbor.CborDecoder
import co.nstant.`in`.cbor.model.Array as CborArray
import co.nstant.`in`.cbor.model.DataItem
import co.nstant.`in`.cbor.model.Map as CborMap
import co.nstant.`in`.cbor.model.Number as CborNumber
import co.nstant.`in`.cbor.model.UnicodeString
import org.bukkit.plugin.java.JavaPlugin
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.logging.Level

/**
 * Synchronous-upcall handler. Decodes a CBOR `HostQuery` payload, executes
 * the reflective call on the Paper main thread, and encodes a
 * `HostQueryResult` for return to the JS runtime.
 *
 * Three query shapes:
 *   * `invoke`          -- instance method on a host-held Bukkit object
 *   * `invoke_static`   -- static method on a named class
 *   * `get_static_field` -- read a static field on a named class
 *
 * Errors (missing ref, unresolved overload, exception during invocation)
 * are returned as `{type: "err", message: ...}` so the JS side can throw
 * meaningful exceptions back into user scripts.
 */
class QueryHandler(
    private val refRegistry: RefRegistry,
    private val marshaller: EventMarshaller,
    private val plugin: JavaPlugin,
    /**
     * Classloaders of other Bukkit plugins this script has declared as
     * deps via `rune.jsonc`. Consulted in order if `Class.forName` on
     * our own loader fails -- Paper plugins don't see each other's
     * classes by default, so this is how reflective access to
     * PlaceholderAPI / Vault / etc. actually resolves.
     */
    private val depLoaders: List<ClassLoader> = emptyList(),
) {

    fun handle(queryBytes: ByteArray): ByteArray {
        return try {
            val items = CborDecoder.decode(queryBytes)
            if (items.isEmpty()) return encodeError("empty query")
            val query = items[0] as? CborMap ?: return encodeError("query must be a map")
            val type = (query[UnicodeString("type")] as? UnicodeString)?.string
                ?: return encodeError("query missing 'type'")
            when (type) {
                "invoke" -> handleInvoke(query)
                "invoke_static" -> handleInvokeStatic(query)
                "get_static_field" -> handleGetStaticField(query)
                "construct" -> handleConstruct(query)
                "create_proxy" -> handleCreateProxy(query)
                else -> encodeError("unknown query type: $type")
            }
        } catch (e: Throwable) {
            plugin.logger.log(Level.WARNING, "query handler threw", e)
            encodeError("${e.javaClass.simpleName}: ${e.message ?: "(no message)"}")
        }
    }

    private fun handleInvoke(query: CborMap): ByteArray {
        val refId = (query[UnicodeString("ref_id")] as? CborNumber)?.value?.toInt()
            ?: return encodeError("invoke missing 'ref_id'")
        val methodName = (query[UnicodeString("method")] as? UnicodeString)?.string
            ?: return encodeError("invoke missing 'method'")
        val argsArr = query[UnicodeString("args")] as? CborArray
            ?: return encodeError("invoke missing 'args'")

        val target = refRegistry.get(refId)
            ?: return encodeError("ref $refId not found")
        val resolved = MethodResolver.resolve(target, methodName, argsArr.dataItems, refRegistry)
            ?: return encodeError(
                noMatchingMessage(
                    target.javaClass, methodName, argsArr.dataItems.size, isStatic = false,
                )
            )

        return runInvocation { resolved.method.invoke(target, *resolved.args) }
    }

    /**
     * Build a helpful "no matching method" error: lists every overload of
     * the requested name AND, if none with the right name exist, suggests
     * similarly-named methods that DO take `argCount` args (the
     * `broadcastMessage(Component)` → "did you mean broadcast(Component)?"
     * case).
     */
    private fun noMatchingMessage(
        targetClass: Class<*>,
        methodName: String,
        argCount: Int,
        isStatic: Boolean,
    ): String = buildString {
        append("no matching ${targetClass.simpleName}.$methodName($argCount arg(s))")
        val all = targetClass.methods.filter {
            Modifier.isPublic(it.modifiers) && Modifier.isStatic(it.modifiers) == isStatic
        }.distinctBy { Pair(it.name, it.parameterTypes.toList()) }
        val sameName = all.filter { it.name == methodName }
            .sortedBy { it.parameterCount }
        if (sameName.isNotEmpty()) {
            append("\n  available overloads:")
            for (c in sameName) {
                val params = c.parameterTypes.joinToString(", ") { it.simpleName }
                append("\n    ${c.name}($params) -> ${c.returnType.simpleName}")
            }
        }
        val similar = suggestSimilar(all, methodName, argCount)
        if (similar.isNotEmpty()) {
            append("\n  did you mean:")
            for (c in similar) {
                val params = c.parameterTypes.joinToString(", ") { it.simpleName }
                append("\n    ${c.name}($params) -> ${c.returnType.simpleName}")
            }
        }
    }

    /**
     * Rank `candidates` by name similarity to `target`. Cheap heuristic:
     *   * exact-name (case-insensitive) gets highest weight
     *   * substring match (one contains the other) is next
     *   * matching arity gets a small bonus -- if you wrote
     *     `server.broadcastMessage(component)` and the only `broadcast*`
     *     overload that takes 1 arg is `broadcast(Component)`, that
     *     should rank first.
     */
    private fun suggestSimilar(
        candidates: List<Method>,
        target: String,
        argCount: Int,
    ): List<Method> {
        val lcTarget = target.lowercase()
        return candidates.mapNotNull { m ->
            val lcM = m.name.lowercase()
            if (lcM == lcTarget) return@mapNotNull null  // already in overload list
            val base = when {
                lcM.startsWith(lcTarget) -> 80
                lcTarget.startsWith(lcM) -> 70
                lcM.contains(lcTarget) -> 60
                lcTarget.contains(lcM) -> 50
                else -> 0
            }
            val arity = if (m.parameterCount == argCount) 15 else 0
            val score = base + arity
            if (score >= 60) Pair(m, score) else null
        }
            .sortedByDescending { it.second }
            .map { it.first }
            .distinctBy { Pair(it.name, it.parameterTypes.toList()) }
            .take(4)
    }

    private fun handleInvokeStatic(query: CborMap): ByteArray {
        val className = (query[UnicodeString("class_name")] as? UnicodeString)?.string
            ?: return encodeError("invoke_static missing 'class_name'")
        val methodName = (query[UnicodeString("method")] as? UnicodeString)?.string
            ?: return encodeError("invoke_static missing 'method'")
        val argsArr = query[UnicodeString("args")] as? CborArray
            ?: return encodeError("invoke_static missing 'args'")

        val clazz = loadClass(className) ?: return encodeError("class not found: $className")
        val candidates = clazz.methods.filter {
            it.name == methodName &&
                it.parameterCount == argsArr.dataItems.size &&
                Modifier.isPublic(it.modifiers) &&
                Modifier.isStatic(it.modifiers)
        }
        for (candidate in candidates) {
            val coerced = arrayOfNulls<Any>(argsArr.dataItems.size)
            var ok = true
            for (i in argsArr.dataItems.indices) {
                val c = ArgCoercer.coerce(argsArr.dataItems[i], candidate.genericParameterTypes[i], refRegistry)
                if (c == null && !isNullArg(argsArr.dataItems[i])) {
                    ok = false; break
                }
                coerced[i] = c
            }
            if (ok) {
                return runInvocation { candidate.invoke(null, *coerced) }
            }
        }
        return encodeError(noMatchingMessage(clazz, methodName, argsArr.dataItems.size, isStatic = true))
    }

    private fun handleConstruct(query: CborMap): ByteArray {
        val className = (query[UnicodeString("class_name")] as? UnicodeString)?.string
            ?: return encodeError("construct missing 'class_name'")
        val argsArr = query[UnicodeString("args")] as? CborArray
            ?: return encodeError("construct missing 'args'")

        val clazz = loadClass(className) ?: return encodeError("class not found: $className")
        // Reflective overload resolution: pick any public constructor whose
        // arity matches and whose parameter types accept the coerced args.
        // Same strategy as handleInvokeStatic -- linear scan; works fine for
        // the small overload sets typical of Bukkit API ctors.
        val candidates = clazz.declaredConstructors.filter {
            it.parameterCount == argsArr.dataItems.size &&
                Modifier.isPublic(it.modifiers)
        }
        if (candidates.isEmpty()) {
            return encodeError(
                "no public ${clazz.simpleName} constructor with ${argsArr.dataItems.size} arg(s)"
            )
        }
        for (candidate in candidates) {
            val coerced = arrayOfNulls<Any>(argsArr.dataItems.size)
            var ok = true
            for (i in argsArr.dataItems.indices) {
                val c = ArgCoercer.coerce(argsArr.dataItems[i], candidate.genericParameterTypes[i], refRegistry)
                if (c == null && !isNullArg(argsArr.dataItems[i])) {
                    ok = false; break
                }
                coerced[i] = c
            }
            if (ok) {
                return runInvocation { candidate.newInstance(*coerced) }
            }
        }
        return encodeError(
            "no matching ${clazz.simpleName} constructor for given arg types"
        )
    }

    /**
     * Handle a `rune.implement(className, methodNames)` request. We
     * generate a subclass via [JsProxyFactory], register the instance in
     * the [RefRegistry], and return a Bukkit ref snapshot with an extra
     * `__runeProxyId` field so the JS dispatch table can key on it.
     *
     * The snapshot is hand-rolled (not via EventMarshaller) because the
     * generated class lives in `net.bytebuddy.renamed.*` -- the
     * marshaller's "is-API-class" heuristic would reject it and fall
     * through to toString. We know our generated instances ARE refs;
     * just emit the snapshot directly.
     */
    private fun handleCreateProxy(query: CborMap): ByteArray {
        val className = (query[UnicodeString("class_name")] as? UnicodeString)?.string
            ?: return encodeError("create_proxy missing 'class_name'")
        val methodsArr = query[UnicodeString("methods")] as? CborArray
            ?: return encodeError("create_proxy missing 'methods'")
        val methodNames = methodsArr.dataItems
            .mapNotNull { (it as? UnicodeString)?.string }
            .toSet()

        val parent = loadClass(className) ?: return encodeError("class not found: $className")

        return try {
            val proxy = JsProxyFactory.createProxy(parent, methodNames)
            val refId = refRegistry.put(proxy.instance)
            val snapshot: Map<String, Any?> = mapOf(
                "type" to "ok",
                "value" to mapOf(
                    "__ref" to refId,
                    "__class" to parent.simpleName,
                    // u64 -> string so JS doesn't lose precision on >= 2^53
                    // ids (we won't hit that in practice, but the wire is
                    // already CBOR-string-friendly).
                    "__runeProxyId" to proxy.proxyId.toString(),
                ),
            )
            EventEncoder.encode(snapshot)
        } catch (e: Throwable) {
            val cause = e.cause ?: e
            encodeError("create_proxy failed: ${cause.javaClass.simpleName}: ${cause.message ?: ""}")
        }
    }

    private fun handleGetStaticField(query: CborMap): ByteArray {
        val className = (query[UnicodeString("class_name")] as? UnicodeString)?.string
            ?: return encodeError("get_static_field missing 'class_name'")
        val fieldName = (query[UnicodeString("field")] as? UnicodeString)?.string
            ?: return encodeError("get_static_field missing 'field'")

        val clazz = loadClass(className) ?: return encodeError("class not found: $className")
        val field = try {
            clazz.getField(fieldName)
        } catch (e: NoSuchFieldException) {
            return encodeError("no field $className.$fieldName")
        }
        if (!Modifier.isStatic(field.modifiers)) {
            return encodeError("$className.$fieldName is not static")
        }
        return runInvocation { field.get(null) }
    }

    /**
     * Encode `block`'s return value as a HostQueryResult::Ok, or wrap any
     * exception (incl. the InvocationTargetException's cause) as Err.
     */
    private fun runInvocation(block: () -> Any?): ByteArray {
        val value = try {
            block()
        } catch (e: Throwable) {
            val cause = e.cause ?: e
            return encodeError(
                "${cause.javaClass.simpleName}: ${cause.message ?: "(no message)"}"
            )
        }
        val marshalled = marshaller.marshalValue(value)
        return encodeOk(marshalled)
    }

    private fun loadClass(name: String): Class<*>? {
        try {
            return Class.forName(name, true, plugin.javaClass.classLoader)
        } catch (_: ClassNotFoundException) { /* try deps */ }
        for (loader in depLoaders) {
            try {
                return Class.forName(name, true, loader)
            } catch (_: ClassNotFoundException) { /* try next */ }
        }
        return null
    }

    private fun encodeOk(value: Any?): ByteArray =
        EventEncoder.encode(mapOf("type" to "ok", "value" to value))

    private fun encodeError(message: String): ByteArray =
        EventEncoder.encode(mapOf("type" to "err", "message" to message))

    private fun isNullArg(item: DataItem): Boolean =
        item is co.nstant.`in`.cbor.model.SimpleValue &&
            item.simpleValueType == co.nstant.`in`.cbor.model.SimpleValueType.NULL
}
