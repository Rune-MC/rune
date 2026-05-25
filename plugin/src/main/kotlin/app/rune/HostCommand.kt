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
    /**
     * Nested literal-keyed subcommands. Brigadier maps each to a child
     * literal node, branching tab-completion at each level. A node can
     * have BOTH args and subcommands -- literals take priority on
     * matching, so e.g.
     *   /pex group <name> create
     * works alongside the implicit "show info" branch
     *   /pex group <name>
     * when both are wired.
     */
    val subcommands: List<CommandSpec> = emptyList(),
    /**
     * Dotted path of this node within its root command, e.g. "pex.user.add".
     * The plugin uses this as the dispatch-event suffix so JS can route
     * each leaf to its own handler. Root spec has path = name.
     */
    val path: String = name,
    /**
     * False when this node only branches into subcommands (no executor
     * registered on the JS side). Brigadier won't wire executes() for
     * non-executor nodes, so trying `/pex` on a node with no handler
     * shows usage instead of dispatching a no-op event.
     */
    val hasExecutor: Boolean = true,
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
     * players for `player` type), OR (if `suggesterId` is set) a JS
     * callback resolved per keystroke.
     */
    val suggestions: List<String> = emptyList(),
    /**
     * When non-null, brigadier installs a SuggestionProvider that calls
     * the JS-side function registered under this id via the proxy
     * dispatch bridge. The JS function receives the partial input and
     * returns the suggestion list (already-filtered if it wants to be).
     *
     * Suggester ids are JS-allocated Longs (not Kotlin-proxy ids).
     */
    val suggesterId: Long? = null,
    /**
     * Subcommands that branch AFTER this arg is consumed. Lets specs
     * express mixed shapes like
     *   /pex group list                 -- spec.subcommands ["list"]
     *   /pex group <name>               -- spec.run (arg consumed, no more tokens)
     *   /pex group <name> create        -- arg.subcommands ["create"]
     * where the parent spec's `subcommands` attach as siblings of the
     * arg chain, and the arg's own `subcommands` attach AFTER the arg.
     */
    val subcommands: List<CommandSpec> = emptyList(),
)
