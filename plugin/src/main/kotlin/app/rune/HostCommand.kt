package app.rune

/**
 * Mirror of `rune_host_api::HostCommand` (see `DESIGN_SPEC.md` §6.2). Encoded
 * by the Rust side as a CBOR tagged-enum map: `{"op": "<variant>", ...fields}`.
 *
 * Decoding lives in [HostCommandDecoder]; hand-rolled because polymorphic
 * decoding of a serde tagged enum is awkward to express via kotlinx-cbor.
 */
sealed class HostCommand {
    data class Broadcast(val message: String) : HostCommand()

    /** Log a line from a script. `level` is `debug|info|warn|error`. */
    data class Log(
        val script: String,
        val level: String,
        val message: String,
    ) : HostCommand()

    /**
     * First-registration notification: at least one script just bound a
     * handler for `name` (a Bukkit event class name). The reflective forwarder
     * uses this to skip dispatch for events with no subscribers.
     */
    data class SubscribeEvent(val name: String) : HostCommand()

    /**
     * Script registered a new Brigadier command. Collected during script load
     * and drained into [CommandRegistry] for the lifecycle handler to wire up
     * once Paper fires `LifecycleEvents.COMMANDS`.
     */
    data class RegisterCommand(val spec: CommandSpec) : HostCommand()
}

data class CommandSpec(
    val name: String,
    val description: String,
    val permission: String?,
    val aliases: List<String>,
    val args: List<CommandArg>,
)

data class CommandArg(
    val name: String,
    val description: String,
    val type: String,
    val min: Double?,
    val max: Double?,
    val greedy: Boolean,
    val optional: Boolean,
    /**
     * Static suggestion strings for tab completion. Empty -> use whatever
     * default suggester Brigadier attaches to the arg's type (e.g. online
     * players for `player` type). Snapshotted at registration time --
     * dynamic-per-keystroke suggesters land in a follow-up.
     */
    val suggestions: List<String> = emptyList(),
)
