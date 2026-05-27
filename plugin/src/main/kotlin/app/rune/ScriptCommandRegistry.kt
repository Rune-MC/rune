package app.rune

import com.mojang.brigadier.Command
import com.mojang.brigadier.arguments.BoolArgumentType
import com.mojang.brigadier.arguments.DoubleArgumentType
import com.mojang.brigadier.arguments.IntegerArgumentType
import com.mojang.brigadier.arguments.LongArgumentType
import com.mojang.brigadier.arguments.StringArgumentType
import com.mojang.brigadier.builder.ArgumentBuilder
import com.mojang.brigadier.builder.LiteralArgumentBuilder
import com.mojang.brigadier.builder.RequiredArgumentBuilder
import com.mojang.brigadier.context.CommandContext
import com.mojang.brigadier.suggestion.SuggestionProvider
import com.mojang.brigadier.suggestion.Suggestions
import com.mojang.brigadier.suggestion.SuggestionsBuilder
import java.util.concurrent.CompletableFuture
import io.papermc.paper.command.brigadier.CommandSourceStack
import io.papermc.paper.command.brigadier.Commands
import io.papermc.paper.command.brigadier.argument.ArgumentTypes
import org.bukkit.entity.Player
import org.bukkit.plugin.java.JavaPlugin

/**
 * Tracks command specs queued by user scripts during plugin load. Drained
 * by [registerWithBrigadier] when `LifecycleEvents.COMMANDS` fires.
 *
 * Brigadier registration is one-shot per Paper plugin: the tree is built
 * during the lifecycle event and can't be mutated afterwards. So:
 *   * Adding a NEW command (new `@Command` class in a script) requires a
 *     full server restart -- /rune reload won't make it visible.
 *   * Reload DOES update the command's handler body, because the executor
 *     calls back into JS via the live event channel and JS re-binds the
 *     handler when the script re-runs.
 */
class ScriptCommandRegistry(
    private val plugin: JavaPlugin,
    private val refRegistry: RefRegistry,
) {
    private val specs: MutableList<CommandSpec> = mutableListOf()
    private val brigadierRegistered: MutableSet<String> = mutableSetOf()
    /** Roots that have already had a "shape change needs restart" warning. */
    private val warnedShapeFrozen: MutableSet<String> = mutableSetOf()

    /**
     * Called by [CommandExecutor] when it sees a RegisterCommand HostCommand.
     *
     * Before [registerWithBrigadier] runs, repeated queues for the same root
     * REPLACE the prior spec -- this lets the decorator API aggregate leaves
     * across many `@Command("pex user add")` classes into one root tree
     * incrementally, re-emitting the full tree on each leaf addition.
     *
     * After Brigadier registration, subsequent updates silently refresh the
     * JS-side handler routing (the Brigadier tree is locked, but JS event
     * dispatch picks up new handler bodies automatically). We warn ONCE per
     * root that arg-shape changes need a restart.
     */
    fun queue(spec: CommandSpec) {
        if (brigadierRegistered.contains(spec.name)) {
            if (warnedShapeFrozen.add(spec.name)) {
                plugin.logger.info(
                    "command '${spec.name}' already wired with Brigadier; " +
                        "handler bodies refresh on /rune reload, but arg-shape " +
                        "changes (new subcommands, new args) require a server restart."
                )
            }
            return
        }
        val existingIdx = specs.indexOfFirst { it.name == spec.name }
        if (existingIdx >= 0) {
            specs[existingIdx] = spec
        } else {
            specs.add(spec)
        }
    }

    /**
     * Build a Brigadier node for every queued spec and register it via the
     * Paper `Commands` registrar. Call from the LifecycleEvents.COMMANDS
     * handler.
     */
    fun registerWithBrigadier(commands: Commands, native: NativeLoader) {
        if (specs.isEmpty()) {
            plugin.logger.info("ScriptCommandRegistry: no script commands to register")
            return
        }
        for (spec in specs) {
            try {
                val node = buildNode(spec, native).build()
                commands.register(node, spec.description.ifEmpty { null }, spec.aliases)
                brigadierRegistered.add(spec.name)
                plugin.logger.info("registered script command /${spec.name}")
            } catch (e: Throwable) {
                plugin.logger.warning("failed to register command /${spec.name}: ${e.message}")
            }
        }
    }

    private fun buildNode(spec: CommandSpec, native: NativeLoader): LiteralArgumentBuilder<CommandSourceStack> {
        val root = Commands.literal(spec.name)
        if (!spec.permission.isNullOrEmpty()) {
            root.requires { it.sender.hasPermission(spec.permission) }
        }
        attachSpec(root, spec, native, prevArgs = emptyList())
        return root
    }

    /**
     * Wire `spec`'s args, subcommands, and executor onto a Brigadier node
     * (`builder`). Recursive: each subcommand becomes a literal child,
     * its own args + subcommands wired in turn.
     *
     * `prevArgs` accumulates the parent-chain's resolved args so a leaf
     * executor can read EVERY arg above it (e.g. `/pex user <player> add
     * <perm>` -> handler sees {player, perm}, not just {perm}).
     */
    private fun attachSpec(
        builder: ArgumentBuilder<CommandSourceStack, *>,
        spec: CommandSpec,
        native: NativeLoader,
        prevArgs: List<CommandArg>,
    ) {
        val argNodes: List<Pair<CommandArg, RequiredArgumentBuilder<CommandSourceStack, *>>> =
            spec.args.map { arg ->
                val node = buildArgumentNode(arg)
                wireSuggestions(node, arg, native)
                arg to node
            }

        // Chain args together; each arg can also carry its OWN subcommands
        // (arg.subcommands) which attach as children AFTER that arg slot.
        // Walk back-to-front so `.then(next)` sees its successor first.
        for (i in argNodes.indices.reversed()) {
            val (arg, node) = argNodes[i]
            if (i < argNodes.size - 1) {
                node.then(argNodes[i + 1].second)
            }
            // Optional args branch: every node at-or-after an optional arg
            // can be a terminal executor.
            val argsHere = prevArgs + spec.args.take(i + 1)
            if (spec.hasExecutor && (i == argNodes.size - 1 || spec.args[i + 1].optional)) {
                node.executes { ctx -> dispatch(spec, ctx, readArgs(ctx, argsHere), native) }
            }
            // Per-arg subcommands: attach to THIS arg's node (so e.g.
            //   /pex group <name> create
            // works with "create" as a child of the <name> arg, while
            //   /pex group list
            // sits at the parent-spec level as a sibling of <name>).
            for (sub in arg.subcommands) {
                val subNode = Commands.literal(sub.name)
                if (!sub.permission.isNullOrEmpty()) {
                    subNode.requires { it.sender.hasPermission(sub.permission) }
                }
                attachSpec(subNode, sub, native, prevArgs = argsHere)
                node.then(subNode)
            }
        }

        // Sibling subcommands of THIS spec attach to the builder (literal
        // node at THIS level), as siblings of the arg chain.
        for (sub in spec.subcommands) {
            val subNode = Commands.literal(sub.name)
            if (!sub.permission.isNullOrEmpty()) {
                subNode.requires { it.sender.hasPermission(sub.permission) }
            }
            attachSpec(subNode, sub, native, prevArgs = prevArgs)
            builder.then(subNode)
        }
        if (argNodes.isNotEmpty()) {
            builder.then(argNodes[0].second)
        }

        // Bind executes() on the builder itself for the "no further args"
        // path. Two cases:
        //   1. spec has no args and has executor -> always execute
        //   2. spec has args but the FIRST is optional -> also execute
        //      with no args supplied
        val noArgsExecute = spec.hasExecutor &&
            (spec.args.isEmpty() || spec.args[0].optional)
        if (noArgsExecute) {
            builder.executes { ctx -> dispatch(spec, ctx, readArgs(ctx, prevArgs), native) }
        }
    }

    private fun readArgs(
        ctx: CommandContext<CommandSourceStack>,
        args: List<CommandArg>,
    ): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for (a in args) out[a.name] = readArg(ctx, a)
        return out
    }

    /**
     * Attach the appropriate suggester to `node`. Priority:
     *   1. Dynamic JS callback (`arg.suggesterId`) -- fires synchronously
     *      against the V8 isolate on every tab keystroke.
     *   2. Static snapshot (`arg.suggestions`) -- prefix-filtered list.
     *   3. Brigadier's built-in (e.g. online players for `player` type).
     */
    private fun wireSuggestions(
        node: RequiredArgumentBuilder<CommandSourceStack, *>,
        arg: CommandArg,
        native: NativeLoader,
    ) {
        if (arg.suggesterId != null) {
            node.suggests(dynamicSuggester(arg.suggesterId, native))
        } else if (arg.suggestions.isNotEmpty()) {
            node.suggests(staticSuggester(arg.suggestions))
        }
    }

    /**
     * Brigadier SuggestionProvider that returns a fixed list, filtered by
     * the partial input the user has typed.
     */
    private fun staticSuggester(items: List<String>): SuggestionProvider<CommandSourceStack> {
        return SuggestionProvider { _, builder ->
            val remaining = builder.remaining.lowercase()
            for (item in items) {
                if (item.lowercase().startsWith(remaining)) {
                    builder.suggest(item)
                }
            }
            builder.buildFuture()
        }
    }

    /**
     * Dynamic JS-callback suggester. On every tab keystroke, calls the
     * JS function the script registered (via `suggester: () => string[]`)
     * synchronously against the V8 isolate via the existing proxy
     * dispatch bridge, then prefix-filters whatever it returns.
     *
     * The JS function receives `(partialInput: string)`. Its callback is
     * stored on the JS side in `proxyImpls` keyed by `suggesterId`; we
     * invoke method name "suggest" through `invokeJsProxy` which routes
     * to that table.
     */
    private fun dynamicSuggester(
        suggesterId: Long,
        native: NativeLoader,
    ): SuggestionProvider<CommandSourceStack> {
        return SuggestionProvider { _, builder ->
            val remaining = builder.remaining
            // JS handler receives the partial input as its only argument.
            // CBOR top-level array of [input_string].
            val argsCbor = encodeStringArray(listOf(remaining))
            val resultBytes = try {
                native.invokeJsProxy(suggesterId, "suggest", argsCbor)
            } catch (e: Throwable) {
                plugin.logger.warning(
                    "dynamic suggester $suggesterId failed: ${e.javaClass.simpleName}: ${e.message}"
                )
                return@SuggestionProvider builder.buildFuture()
            }
            if (resultBytes.isNotEmpty()) {
                val items = co.nstant.`in`.cbor.CborDecoder.decode(resultBytes)
                val first = items.firstOrNull()
                val list = (first as? co.nstant.`in`.cbor.model.Array)?.dataItems.orEmpty()
                val lower = remaining.lowercase()
                for (item in list) {
                    val s = (item as? co.nstant.`in`.cbor.model.UnicodeString)?.string ?: continue
                    if (s.lowercase().startsWith(lower)) builder.suggest(s)
                }
            }
            builder.buildFuture()
        }
    }

    /** Encode `items` as a top-level CBOR array of text strings. */
    private fun encodeStringArray(items: List<String>): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val arr = co.nstant.`in`.cbor.model.Array()
        for (s in items) arr.add(co.nstant.`in`.cbor.model.UnicodeString(s))
        co.nstant.`in`.cbor.CborEncoder(out).encode(arr)
        return out.toByteArray()
    }

    private fun buildArgumentNode(arg: CommandArg): RequiredArgumentBuilder<CommandSourceStack, *> {
        return when (arg.type) {
            "string"    -> Commands.argument(arg.name, StringArgumentType.string())
            "word"      -> Commands.argument(arg.name, StringArgumentType.word())
            "greedy"    -> Commands.argument(arg.name, StringArgumentType.greedyString())
            "int"       -> Commands.argument(
                arg.name,
                IntegerArgumentType.integer(
                    arg.min?.toInt() ?: Int.MIN_VALUE,
                    arg.max?.toInt() ?: Int.MAX_VALUE,
                ),
            )
            "long"      -> Commands.argument(
                arg.name,
                LongArgumentType.longArg(
                    arg.min?.toLong() ?: Long.MIN_VALUE,
                    arg.max?.toLong() ?: Long.MAX_VALUE,
                ),
            )
            "double"    -> Commands.argument(
                arg.name,
                DoubleArgumentType.doubleArg(
                    arg.min ?: -Double.MAX_VALUE,
                    arg.max ?: Double.MAX_VALUE,
                ),
            )
            "bool"      -> Commands.argument(arg.name, BoolArgumentType.bool())
            "player"    -> Commands.argument(arg.name, ArgumentTypes.player())
            "players"   -> Commands.argument(arg.name, ArgumentTypes.players())
            "entity"    -> Commands.argument(arg.name, ArgumentTypes.entity())
            "entities"  -> Commands.argument(arg.name, ArgumentTypes.entities())
            "world"     -> Commands.argument(arg.name, ArgumentTypes.world())
            "block_pos" -> Commands.argument(arg.name, ArgumentTypes.blockPosition())
            else -> {
                // Unknown tag: behave as `string`. The user's script may want
                // a richer type we don't map yet; log so it's visible.
                plugin.logger.warning("unknown arg type '${arg.type}' for ${arg.name}; using string")
                Commands.argument(arg.name, StringArgumentType.string())
            }
        }
    }

    /**
     * Read one resolved argument out of the Brigadier context. Player /
     * entity types resolve through Paper's PlayerSelectorArgumentResolver
     * pattern, which requires the executing source.
     */
    private fun readArg(ctx: CommandContext<CommandSourceStack>, arg: CommandArg): Any? {
        return try {
            when (arg.type) {
                "string", "word", "greedy" -> StringArgumentType.getString(ctx, arg.name)
                "int" -> IntegerArgumentType.getInteger(ctx, arg.name)
                "long" -> LongArgumentType.getLong(ctx, arg.name)
                "double" -> DoubleArgumentType.getDouble(ctx, arg.name)
                "bool" -> BoolArgumentType.getBool(ctx, arg.name)
                "player" -> {
                    @Suppress("UNCHECKED_CAST")
                    val resolver = ctx.getArgument(arg.name, io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver::class.java)
                    resolver.resolve(ctx.source).firstOrNull()
                }
                "players" -> {
                    val resolver = ctx.getArgument(arg.name, io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver::class.java)
                    resolver.resolve(ctx.source)
                }
                "entity" -> {
                    val resolver = ctx.getArgument(arg.name, io.papermc.paper.command.brigadier.argument.resolvers.selector.EntitySelectorArgumentResolver::class.java)
                    resolver.resolve(ctx.source).firstOrNull()
                }
                "entities" -> {
                    val resolver = ctx.getArgument(arg.name, io.papermc.paper.command.brigadier.argument.resolvers.selector.EntitySelectorArgumentResolver::class.java)
                    resolver.resolve(ctx.source)
                }
                "world" -> ctx.getArgument(arg.name, org.bukkit.World::class.java)
                "block_pos" -> {
                    val resolver = ctx.getArgument(arg.name, io.papermc.paper.command.brigadier.argument.resolvers.BlockPositionResolver::class.java)
                    resolver.resolve(ctx.source)
                }
                else -> StringArgumentType.getString(ctx, arg.name)
            }
        } catch (e: Throwable) {
            plugin.logger.warning("failed to read arg ${arg.name}: ${e.message}")
            null
        }
    }

    /**
     * Marshal the resolved args + sender into a CBOR event payload and
     * dispatch through the existing event channel. The JS bootstrap routes
     * `__rune_command:<name>` events to the handler stored under `name`.
     */
    private fun dispatch(
        spec: CommandSpec,
        ctx: CommandContext<CommandSourceStack>,
        resolvedArgs: Map<String, Any?>,
        native: NativeLoader,
    ): Int {
        val sender = ctx.source.sender
        val marshalled: Map<String, Any?> = mapOf(
            "sender" to mapOf(
                "__ref" to refRegistry.put(sender),
                "__class" to sender.javaClass.simpleName,
                "name" to sender.name,
                "isPlayer" to (sender is Player),
            ),
            "args" to resolvedArgs.mapValues { (_, v) -> marshalArg(v) },
            // Root command label is the first segment of the dotted path
            // (e.g. "pex" for path "pex.user.add"). Leaf-specific routing
            // lives in the event name, not `label`.
            "label" to spec.path.substringBefore('.'),
        )
        val bytes = EventEncoder.encode(marshalled)
        // `spec.path` is the dotted tree path (e.g. "pex.user.add").
        // Leaf subcommands fire their own event so JS can route to a
        // per-leaf handler without re-parsing the args list.
        native.dispatchEvent("__rune_command:${spec.path}", bytes)
        return Command.SINGLE_SUCCESS
    }

    /**
     * Convert one resolved arg value to its JS-side representation. Player /
     * entity selectors become refs so scripts can call methods on them;
     * primitives pass through; lists of refs become arrays of refs.
     */
    private fun marshalArg(value: Any?): Any? = when (value) {
        null -> null
        is String, is Boolean -> value
        is Number -> value
        is Player -> mapOf(
            "__ref" to refRegistry.put(value),
            "__class" to "Player",
            "name" to value.name,
            "uuid" to value.uniqueId.toString(),
        )
        is org.bukkit.entity.Entity -> mapOf(
            "__ref" to refRegistry.put(value),
            "__class" to value.javaClass.simpleName,
            "uuid" to value.uniqueId.toString(),
            "name" to runCatching { value.name }.getOrDefault(""),
        )
        is org.bukkit.World -> mapOf(
            "__ref" to refRegistry.put(value),
            "__class" to "World",
            "name" to value.name,
        )
        is org.bukkit.Location -> mapOf(
            "__ref" to refRegistry.put(value),
            "__class" to "Location",
            "x" to value.x, "y" to value.y, "z" to value.z,
            "world" to runCatching { value.world?.name ?: "" }.getOrDefault(""),
        )
        is io.papermc.paper.math.Position -> mapOf(
            "x" to value.x(),
            "y" to value.y(),
            "z" to value.z(),
        )
        is Collection<*> -> value.map(::marshalArg)
        else -> mapOf(
            "__ref" to refRegistry.put(value),
            "__class" to value.javaClass.simpleName,
        )
    }
}
