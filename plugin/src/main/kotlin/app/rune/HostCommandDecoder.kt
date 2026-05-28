package app.rune

import co.nstant.`in`.cbor.CborDecoder
import co.nstant.`in`.cbor.model.Array as CborArray
import co.nstant.`in`.cbor.model.Map as CborMap
import co.nstant.`in`.cbor.model.Number as CborNumber
import co.nstant.`in`.cbor.model.UnicodeString
import org.bukkit.event.EventPriority

/**
 * Decodes the CBOR payload produced by `rune_drain_commands` -- a CBOR array
 * of maps, each shaped `{"op": "<variant>", ...fields}`. Hand-rolled because
 * polymorphic decoding via kotlinx-serialization-cbor would require a custom
 * KSerializer for the discriminant key.
 */
object HostCommandDecoder {

    fun decode(bytes: ByteArray): List<HostCommand> {
        if (bytes.isEmpty()) return emptyList()
        val items = CborDecoder.decode(bytes)
        if (items.isEmpty()) return emptyList()
        val arr = items[0] as? CborArray
            ?: throw IllegalArgumentException(
                "expected CBOR array at top level, got ${items[0]::class.simpleName}"
            )

        return arr.dataItems.map { item ->
            val map = item as? CborMap
                ?: throw IllegalArgumentException(
                    "expected CBOR map for command entry, got ${item::class.simpleName}"
                )
            val op = map.getString("op")
                ?: throw IllegalArgumentException("command entry missing 'op'")
            when (op) {
                "broadcast" -> HostCommand.Broadcast(
                    map.getString("message")
                        ?: throw IllegalArgumentException("broadcast missing 'message'")
                )
                "log" -> HostCommand.Log(
                    script = map.getString("script") ?: "<?>",
                    level = map.getString("level") ?: "info",
                    message = map.getString("message") ?: "",
                )
                "subscribe_event" -> {
                    val name = map.getString("name")
                        ?: throw IllegalArgumentException("subscribe_event missing 'name'")
                    // Older JS bootstraps may not include `priority`; default
                    // to NORMAL to match Bukkit's @EventHandler default.
                    val priority = map.getString("priority")?.let { raw ->
                        try { EventPriority.valueOf(raw.uppercase()) }
                        catch (_: IllegalArgumentException) {
                            throw IllegalArgumentException(
                                "subscribe_event 'priority' must be one of ${EventPriority.values().joinToString()}, got '$raw'"
                            )
                        }
                    } ?: EventPriority.NORMAL
                    HostCommand.SubscribeEvent(name = name, priority = priority)
                }
                "register_command" -> HostCommand.RegisterCommand(decodeCommandSpec(map))
                else -> throw IllegalArgumentException("unknown op: $op")
            }
        }
    }

    private fun CborMap.getString(key: String): String? {
        val value = this[UnicodeString(key)] ?: return null
        return (value as? UnicodeString)?.string
    }

    private fun decodeCommandSpec(map: CborMap, parentPath: String = ""): CommandSpec {
        val name = map.getString("name")
            ?: throw IllegalArgumentException("register_command missing 'name'")
        val path = if (parentPath.isEmpty()) name else "$parentPath.$name"
        val argsRaw = map[UnicodeString("args")] as? CborArray
        val args = argsRaw?.dataItems.orEmpty().mapNotNull { item ->
            (item as? CborMap)?.let { decodeCommandArg(it, parentPath = path) }
        }
        val aliasesRaw = map[UnicodeString("aliases")] as? CborArray
        val aliases = aliasesRaw?.dataItems.orEmpty()
            .mapNotNull { (it as? UnicodeString)?.string }
        val subsRaw = map[UnicodeString("subcommands")] as? CborArray
        val subs = subsRaw?.dataItems.orEmpty().mapNotNull { item ->
            (item as? CborMap)?.let { decodeCommandSpec(it, parentPath = path) }
        }
        // `has_executor` defaults to true for backward compat with the old
        // (flat-only) wire format. New JS code sends false for tree-internal
        // nodes that only branch into subcommands.
        val hasExec = map.getBoolean("has_executor") ?: true
        return CommandSpec(
            name = name,
            description = map.getString("description") ?: "",
            permission = map.getString("permission"),
            aliases = aliases,
            args = args,
            subcommands = subs,
            path = path,
            hasExecutor = hasExec,
        )
    }

    private fun decodeCommandArg(map: CborMap, parentPath: String = ""): CommandArg {
        val suggestionsRaw = map[UnicodeString("suggestions")] as? CborArray
        val suggestions = suggestionsRaw?.dataItems.orEmpty()
            .mapNotNull { (it as? UnicodeString)?.string }
        val suggesterId = (map[UnicodeString("suggester_id")] as? CborNumber)?.value?.toLong()
        val subsRaw = map[UnicodeString("subcommands")] as? CborArray
        val subs = subsRaw?.dataItems.orEmpty().mapNotNull { item ->
            (item as? CborMap)?.let { decodeCommandSpec(it, parentPath = parentPath) }
        }
        return CommandArg(
            name = map.getString("name")
                ?: throw IllegalArgumentException("command arg missing 'name'"),
            description = map.getString("description") ?: "",
            type = map.getString("type") ?: "string",
            min = (map[UnicodeString("min")] as? CborNumber)?.value?.toDouble(),
            max = (map[UnicodeString("max")] as? CborNumber)?.value?.toDouble(),
            greedy = map.getBoolean("greedy") ?: false,
            optional = map.getBoolean("optional") ?: false,
            suggestions = suggestions,
            suggesterId = suggesterId,
            subcommands = subs,
        )
    }

    private fun CborMap.getBoolean(key: String): Boolean? {
        val value = this[UnicodeString(key)] ?: return null
        return when (value) {
            is co.nstant.`in`.cbor.model.SimpleValue -> when (value.simpleValueType) {
                co.nstant.`in`.cbor.model.SimpleValueType.TRUE -> true
                co.nstant.`in`.cbor.model.SimpleValueType.FALSE -> false
                else -> null
            }
            else -> null
        }
    }
}
