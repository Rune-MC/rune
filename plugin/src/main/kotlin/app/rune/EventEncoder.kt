package app.rune

import co.nstant.`in`.cbor.CborEncoder
import co.nstant.`in`.cbor.model.Array as CborArray
import co.nstant.`in`.cbor.model.DataItem
import co.nstant.`in`.cbor.model.DoublePrecisionFloat
import co.nstant.`in`.cbor.model.Map as CborMap
import co.nstant.`in`.cbor.model.NegativeInteger
import co.nstant.`in`.cbor.model.SimpleValue
import co.nstant.`in`.cbor.model.SinglePrecisionFloat
import co.nstant.`in`.cbor.model.UnicodeString
import co.nstant.`in`.cbor.model.UnsignedInteger
import java.io.ByteArrayOutputStream
import java.math.BigInteger

/**
 * Encodes a field map (possibly containing nested maps and lists) as CBOR
 * for dispatch via [NativeLoader.dispatchEvent]. The shape mirrors what the
 * script will see on the event object on the JS side.
 *
 * Nested types supported:
 *   * `String` -> CBOR text
 *   * `Boolean`, integer types (Byte..Long), `Float`, `Double` -> CBOR primitives
 *   * `null` -> CBOR null
 *   * `Map<String, Any?>` -> nested CBOR map
 *   * `List<Any?>` / `Collection<Any?>` -> CBOR array
 *   * anything else -> `toString()` fallback
 */
object EventEncoder {

    fun encode(fields: Map<String, Any?>): ByteArray {
        val out = ByteArrayOutputStream()
        CborEncoder(out).encode(toCbor(fields))
        return out.toByteArray()
    }

    private fun toCbor(value: Any?): DataItem = when (value) {
        null -> SimpleValue.NULL
        is String -> UnicodeString(value)
        is Boolean -> if (value) SimpleValue.TRUE else SimpleValue.FALSE
        is Byte -> intToCbor(value.toLong())
        is Short -> intToCbor(value.toLong())
        is Int -> intToCbor(value.toLong())
        is Long -> intToCbor(value)
        is Float -> SinglePrecisionFloat(value)
        is Double -> DoublePrecisionFloat(value)
        // ByteArray gets its own CBOR byte string (major 0x40); without
        // this case it would fall through to `Object.toString()` which
        // produces "[B@1a2b3c4d" garbage. The JS side decodes byte strings
        // into Uint8Array, which is what HTTP request bodies, file IO,
        // and crypto callbacks all want.
        is ByteArray -> co.nstant.`in`.cbor.model.ByteString(value)
        is Map<*, *> -> {
            val m = CborMap()
            for ((k, v) in value) {
                m.put(UnicodeString(k.toString()), toCbor(v))
            }
            m
        }
        is Collection<*> -> {
            val a = CborArray()
            for (item in value) a.add(toCbor(item))
            a
        }
        else -> UnicodeString(value.toString())
    }

    private fun intToCbor(value: Long): DataItem =
        if (value >= 0) UnsignedInteger(BigInteger.valueOf(value))
        else NegativeInteger(BigInteger.valueOf(value))
}
