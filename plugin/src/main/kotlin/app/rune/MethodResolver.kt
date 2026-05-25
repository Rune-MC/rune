package app.rune

import co.nstant.`in`.cbor.model.DataItem
import co.nstant.`in`.cbor.model.Map as CborMap
import co.nstant.`in`.cbor.model.Number as CborNumber
import co.nstant.`in`.cbor.model.SimpleValue
import co.nstant.`in`.cbor.model.SimpleValueType
import co.nstant.`in`.cbor.model.UnicodeString
import net.kyori.adventure.text.Component
import org.bukkit.Bukkit
import org.bukkit.Location
import org.bukkit.Material
import org.bukkit.NamespacedKey
import org.bukkit.util.Vector
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.lang.reflect.ParameterizedType
import java.lang.reflect.Type
import java.lang.reflect.WildcardType

/**
 * Resolves an `(object, method-name, cbor-args)` triple to a concrete
 * [Method] + coerced Java argument array, picking the first overload whose
 * parameter types each coerce cleanly from the supplied args.
 *
 * Supported parameter types this release:
 *   * `String`, primitive numerics (Int/Long/Short/Byte/Double/Float, boxed
 *     and unboxed), `Boolean`
 *   * Adventure `Component` (from a CBOR string -- `Component.text(s)`)
 *   * `Material` (from a CBOR string -- `Material.matchMaterial(...)`)
 *   * Any `Enum` subtype (from a CBOR string -- case-insensitive name match)
 *   * Any Bukkit ref the script holds (from `{__ref: id, ...}` payloads --
 *     resolved against [RefRegistry] and checked for assignability)
 */
object MethodResolver {

    data class Resolved(val method: Method, val args: Array<Any?>)

    fun resolve(
        target: Any,
        methodName: String,
        args: List<DataItem>,
        registry: RefRegistry,
    ): Resolved? {
        val candidates = target.javaClass.methods.filter {
            it.name == methodName &&
                it.parameterCount == args.size &&
                Modifier.isPublic(it.modifiers) &&
                !Modifier.isStatic(it.modifiers)
        }
        for (candidate in candidates) {
            val coerced = arrayOfNulls<Any>(args.size)
            var ok = true
            for (i in args.indices) {
                // Use genericParameterTypes so element-typed coercion works
                // for `List<Component>`, `Set<Material>`, etc. -- without
                // this, list elements stay as raw JS strings and Java
                // throws ClassCastException inside the called method.
                val c = ArgCoercer.coerce(args[i], candidate.genericParameterTypes[i], registry)
                if (c == null && !isNullArg(args[i])) {
                    ok = false; break
                }
                coerced[i] = c
            }
            if (ok) {
                // Method.invoke requires the *declaring class* to be
                // accessible from our caller module. Concrete Bukkit
                // implementations live in `org.bukkit.craftbukkit.*` /
                // `net.minecraft.*` which JPMS does NOT export to us, so
                // invoking the override directly throws IllegalAccessException.
                // Re-resolve the method via the public API interface (e.g.
                // ItemMeta instead of CraftMetaItem); same target, same
                // dispatch, but a declaring class we're allowed to touch.
                val accessible = findAccessibleOverride(candidate, target.javaClass)
                return Resolved(accessible, coerced)
            }
        }
        return null
    }

    /**
     * Find a Method with the same signature as `candidate` whose declaring
     * class we're allowed to reflect against. Three-step fallback:
     *
     *   1. If `candidate.declaringClass` is already exported (public class
     *      in an exported package), use it as-is -- fast path.
     *   2. Scan `targetClass.methods` (which includes inherited methods,
     *      each with its ORIGINAL declaringClass) for a same-name +
     *      same-paramType signature whose declaringClass IS exported.
     *      This catches both regular overrides and generic-erasure bridge
     *      methods on parameterised interfaces (e.g. MiniMessage's
     *      `deserialize(String)` via ComponentSerializer<..., String>).
     *   3. Last resort: trySetAccessible on the original candidate. Works
     *      in most embeddings (Paper opens its packages broadly); if JPMS
     *      strict mode blocks it, invoke() will surface the original
     *      IllegalAccessException with a clearer line in the stack.
     */
    private fun findAccessibleOverride(candidate: Method, targetClass: Class<*>): Method {
        if (isExported(candidate.declaringClass)) return candidate

        val name = candidate.name
        val params = candidate.parameterTypes
        val accessible = targetClass.methods.firstOrNull {
            it.name == name &&
                it.parameterTypes.contentEquals(params) &&
                Modifier.isPublic(it.modifiers) &&
                isExported(it.declaringClass)
        }
        if (accessible != null) return accessible

        runCatching { candidate.trySetAccessible() }
        return candidate
    }

    /**
     * Classes whose package is exported to unnamed modules (i.e. we can
     * reflect against them without "does not export" errors). Internal
     * Craft / NMS classes are NOT exported in modern JDK + Paper.
     */
    /**
     * Whether the JDK lets us call `Method.invoke` against a method whose
     * declaring class is `c`:
     *   * The class itself must be `public` -- package-private impls
     *     (`MiniMessageImpl`, `CraftMetaItem`, ...) bounce reflective
     *     access even when the method is public.
     *   * The package must not be a JPMS-internal one we don't have
     *     access to (`org.bukkit.craftbukkit.*`, `net.minecraft.*`).
     *
     * When this returns false, [findAccessibleOverride] keeps walking up
     * the super/interface chain looking for a class/interface that does
     * pass.
     */
    private fun isExported(c: Class<*>): Boolean {
        if (!Modifier.isPublic(c.modifiers)) return false
        val n = c.name
        return !n.startsWith("org.bukkit.craftbukkit.") &&
            !n.startsWith("net.minecraft.")
    }

    private fun isNullArg(item: DataItem): Boolean =
        item is SimpleValue && item.simpleValueType == SimpleValueType.NULL
}

object ArgCoercer {

    /**
     * Generic-type-aware entry point. Used by [MethodResolver] when the
     * caller has a method's `genericParameterTypes[i]` -- preserves the
     * `<E>` on `List<E>` so element coercion can resolve to Components,
     * refs, enums, etc. inside `lore(List<Component>)` and friends.
     *
     * Non-parametrised types fall through to the Class<*> overload below.
     */
    fun coerce(arg: DataItem, type: Type, registry: RefRegistry): Any? {
        val rawClass: Class<*> = when (type) {
            is Class<*> -> type
            is ParameterizedType -> type.rawType as? Class<*> ?: return null
            is WildcardType -> {
                val upper = type.upperBounds.firstOrNull() ?: return null
                return coerce(arg, upper, registry)
            }
            else -> return null
        }

        // Collection<E> from a CBOR array -- coerce each element against
        // the parameterised E so `List<Component>` resolves strings to
        // Component.text(s), `Set<Material>` resolves to enum values, etc.
        // Without this branch the Class<*> overload's untyped fallback
        // strands element coercion at raw JS primitives.
        if (arg is co.nstant.`in`.cbor.model.Array &&
            Collection::class.java.isAssignableFrom(rawClass)) {
            val elemType: Type = (type as? ParameterizedType)
                ?.actualTypeArguments?.firstOrNull()
                ?: Any::class.java
            val list = java.util.ArrayList<Any?>(arg.dataItems.size)
            for (item in arg.dataItems) {
                val isNull = item is SimpleValue && item.simpleValueType == SimpleValueType.NULL
                val coerced = coerce(item, elemType, registry)
                if (coerced == null && !isNull) return null
                list.add(coerced)
            }
            return if (java.util.Set::class.java.isAssignableFrom(rawClass)) {
                java.util.LinkedHashSet(list)
            } else list
        }

        return coerce(arg, rawClass, registry)
    }

    fun coerce(arg: DataItem, paramType: Class<*>, registry: RefRegistry): Any? {
        if (arg is SimpleValue && arg.simpleValueType == SimpleValueType.NULL) return null

        // Bukkit ref: {__ref: <int>, ...}. Coerce iff the live object is
        // assignable to the param type.
        if (arg is CborMap) {
            val refItem = arg[UnicodeString("__ref")]
            if (refItem is CborNumber) {
                val refId = refItem.value.toInt()
                val obj = registry.get(refId)
                if (obj != null && paramType.isInstance(obj)) {
                    return obj
                }
            }
        }

        // String
        if (paramType == String::class.java) {
            return (arg as? UnicodeString)?.string
        }

        // Booleans
        if (paramType == java.lang.Boolean.TYPE || paramType == java.lang.Boolean::class.java) {
            return when {
                arg is SimpleValue && arg.simpleValueType == SimpleValueType.TRUE -> true
                arg is SimpleValue && arg.simpleValueType == SimpleValueType.FALSE -> false
                else -> null
            }
        }

        // Numerics + char (JS code uses `"X".charCodeAt(0)` for char args).
        if (paramType.isPrimitive || NUMERIC_BOXED.contains(paramType)) {
            val n: Number = when (arg) {
                is CborNumber -> arg.value.toLong()
                is co.nstant.`in`.cbor.model.DoublePrecisionFloat -> arg.value
                is co.nstant.`in`.cbor.model.SinglePrecisionFloat -> arg.value
                else -> return null
            }
            return when (paramType) {
                Integer.TYPE, Integer::class.java -> n.toInt()
                java.lang.Long.TYPE, java.lang.Long::class.java -> n.toLong()
                java.lang.Short.TYPE, java.lang.Short::class.java -> n.toShort()
                java.lang.Byte.TYPE, java.lang.Byte::class.java -> n.toByte()
                java.lang.Float.TYPE, java.lang.Float::class.java -> n.toFloat()
                java.lang.Double.TYPE, java.lang.Double::class.java -> n.toDouble()
                java.lang.Character.TYPE, java.lang.Character::class.java -> n.toInt().toChar()
                else -> null
            }
        }

        // char from a single-char string. JS `"D"` is the most natural form
        // for a char param; without this, callers have to do `.charCodeAt(0)`
        // which always feels wrong.
        if ((paramType == java.lang.Character.TYPE || paramType == java.lang.Character::class.java) &&
            arg is UnicodeString && arg.string.length == 1) {
            return arg.string[0]
        }

        // Adventure Component built from a plain string
        if (Component::class.java.isAssignableFrom(paramType)) {
            val s = (arg as? UnicodeString)?.string ?: return null
            return Component.text(s)
        }

        // Material from "minecraft:stone" or "stone"
        if (paramType == Material::class.java) {
            val s = (arg as? UnicodeString)?.string ?: return null
            return Material.matchMaterial(s)
        }

        // NamespacedKey from "minecraft:foo" or "foo"
        if (paramType == NamespacedKey::class.java) {
            val s = (arg as? UnicodeString)?.string ?: return null
            return NamespacedKey.fromString(s)
        }

        // Location from {x, y, z, world?, yaw?, pitch?}
        if (paramType == Location::class.java && arg is CborMap) {
            val world = (arg[UnicodeString("world")] as? UnicodeString)?.string
                ?.let { Bukkit.getWorld(it) }
            val x = numberOrNull(arg[UnicodeString("x")])?.toDouble() ?: 0.0
            val y = numberOrNull(arg[UnicodeString("y")])?.toDouble() ?: 0.0
            val z = numberOrNull(arg[UnicodeString("z")])?.toDouble() ?: 0.0
            val yaw = numberOrNull(arg[UnicodeString("yaw")])?.toFloat() ?: 0f
            val pitch = numberOrNull(arg[UnicodeString("pitch")])?.toFloat() ?: 0f
            return Location(world, x, y, z, yaw, pitch)
        }

        // Vector from {x, y, z}
        if (paramType == Vector::class.java && arg is CborMap) {
            val x = numberOrNull(arg[UnicodeString("x")])?.toDouble() ?: 0.0
            val y = numberOrNull(arg[UnicodeString("y")])?.toDouble() ?: 0.0
            val z = numberOrNull(arg[UnicodeString("z")])?.toDouble() ?: 0.0
            return Vector(x, y, z)
        }

        // Array (including varargs -- `String...` reflects as `String[]`).
        // Element type IS known here (paramType.componentType), so we
        // recursively coerce each item to the right type.
        if (arg is co.nstant.`in`.cbor.model.Array && paramType.isArray) {
            val component = paramType.componentType
            val out = java.lang.reflect.Array.newInstance(component, arg.dataItems.size)
            for (i in arg.dataItems.indices) {
                val item = arg.dataItems[i]
                val isItemNull = item is SimpleValue && item.simpleValueType == SimpleValueType.NULL
                val coerced = coerce(item, component, registry)
                if (coerced == null && !isItemNull) return null
                java.lang.reflect.Array.set(out, i, coerced)
            }
            return out
        }

        // Collection / List / Iterable / Set from a CBOR array. Element type
        // erasure is gone by the time we see paramType, so each item is
        // unwrapped untyped -- strings stay strings, numbers stay numbers,
        // {__ref} maps resolve to the live Java object. Good enough for
        // `meta.lore([Component.text("a")])` and `recipe.setIngredientList`.
        if (arg is co.nstant.`in`.cbor.model.Array &&
            (paramType.isAssignableFrom(java.util.ArrayList::class.java) ||
                Collection::class.java.isAssignableFrom(paramType))) {
            val list = java.util.ArrayList<Any?>(arg.dataItems.size)
            for (item in arg.dataItems) list.add(coerceUntyped(item, registry))
            if (java.util.Set::class.java.isAssignableFrom(paramType)) {
                return java.util.LinkedHashSet(list)
            }
            return list
        }

        // Any other Enum -- match by name, case-insensitive.
        if (paramType.isEnum) {
            val s = (arg as? UnicodeString)?.string ?: return null
            return paramType.enumConstants
                .firstOrNull { (it as Enum<*>).name.equals(s, ignoreCase = true) }
        }

        // Last resort: a public static field on `paramType` whose name matches
        // the supplied string. Covers Bukkit's interface-static singletons
        // (PersistentDataType.STRING, Particle.DustOptions, etc.) which are
        // not enums but look like enums to plugin authors.
        if (arg is UnicodeString) {
            try {
                val field = paramType.getField(arg.string.uppercase())
                if (Modifier.isStatic(field.modifiers) && paramType.isAssignableFrom(field.type)) {
                    return field.get(null)
                }
            } catch (_: NoSuchFieldException) {
                // fall through
            }
        }

        return null
    }

    private fun numberOrNull(item: DataItem?): Number? = when (item) {
        is CborNumber -> item.value.toLong()
        is co.nstant.`in`.cbor.model.DoublePrecisionFloat -> item.value
        is co.nstant.`in`.cbor.model.SinglePrecisionFloat -> item.value
        else -> null
    }

    /**
     * Unwrap a CBOR DataItem to its closest plain Java equivalent without
     * any target-type coercion. Used as the element-wise step inside list
     * coercion where we've lost generic param info.
     */
    private fun coerceUntyped(arg: DataItem, registry: RefRegistry): Any? {
        return when (arg) {
            is SimpleValue -> when (arg.simpleValueType) {
                SimpleValueType.NULL -> null
                SimpleValueType.UNDEFINED -> null
                SimpleValueType.TRUE -> true
                SimpleValueType.FALSE -> false
                else -> null
            }
            is UnicodeString -> arg.string
            is CborNumber -> arg.value.toLong()
            is co.nstant.`in`.cbor.model.DoublePrecisionFloat -> arg.value
            is co.nstant.`in`.cbor.model.SinglePrecisionFloat -> arg.value
            is CborMap -> {
                val refItem = arg[UnicodeString("__ref")]
                if (refItem is CborNumber) {
                    registry.get(refItem.value.toInt())
                } else {
                    arg.keys.associate { k ->
                        val ks = (k as? UnicodeString)?.string ?: k.toString()
                        ks to coerceUntyped(arg[k]!!, registry)
                    }
                }
            }
            is co.nstant.`in`.cbor.model.Array -> arg.dataItems.map { coerceUntyped(it, registry) }
            else -> null
        }
    }

    private val NUMERIC_BOXED: Set<Class<*>> = setOf(
        Integer::class.java,
        java.lang.Long::class.java,
        java.lang.Short::class.java,
        java.lang.Byte::class.java,
        java.lang.Float::class.java,
        java.lang.Double::class.java,
        java.lang.Number::class.java,
        java.lang.Character::class.java,
    )
}
