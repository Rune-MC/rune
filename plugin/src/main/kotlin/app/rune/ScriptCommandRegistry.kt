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
import com.mojang.brigadier.suggestion.SuggestionsBuilder
import co.nstant.`in`.cbor.CborDecoder
import co.nstant.`in`.cbor.model.Array as CborArray
import co.nstant.`in`.cbor.model.UnicodeString
import io.papermc.paper.command.brigadier.CommandSourceStack
import io.papermc.paper.command.brigadier.Commands
import io.papermc.paper.command.brigadier.argument.ArgumentTypes
import org.bukkit.command.CommandSender
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
    private val completionArgs = mutableMapOf<Pair<String, String>, CommandArg>()
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
        indexCompletionArgs(spec)
        registerPermissions(spec)
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

    fun clearCompletions() = completionArgs.clear()

    private fun indexCompletionArgs(spec: CommandSpec) {
        for (arg in spec.args) {
            completionArgs[spec.path to arg.name] = arg
            arg.subcommands.forEach(::indexCompletionArgs)
        }
        spec.subcommands.forEach(::indexCompletionArgs)
    }

    private fun registerPermissions(spec: CommandSpec) {
        spec.permission?.let { registerRunePermission(plugin.server.pluginManager, it) }
        spec.subcommands.forEach(::registerPermissions)
        spec.args.forEach { it.subcommands.forEach(::registerPermissions) }
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
            spec.args.mapIndexed { index, arg ->
                val node = buildArgumentNode(arg)
                wireSuggestions(node, spec.path, arg, prevArgs + spec.args.take(index), native)
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

    private fun wireSuggestions(
        node: RequiredArgumentBuilder<CommandSourceStack, *>,
        path: String,
        arg: CommandArg,
        preceding: List<CommandArg>,
        native: NativeLoader,
    ) {
        if (arg.suggesterId == null && arg.suggestions.isEmpty()) return
        val key = path to arg.name
        node.suggests { ctx, builder ->
            // The tree survives /rune reload, but callback IDs belong to the current isolate.
            val source = completionArgs[key] ?: return@suggests builder.buildFuture()
            val input = if (arg.type == "string") unquotePartial(builder.remaining) else builder.remaining
            val items = source.suggesterId?.let { id ->
                val context = mapOf(
                    "sender" to marshalSender(ctx.source.sender),
                    "args" to readArgs(ctx, preceding).mapValues { (_, value) -> marshalArg(value) },
                )
                invokeCommandSuggestions(plugin, native, id, listOf(input, context))
            } ?: source.suggestions
            addCommandSuggestions(builder, input, items, quote = arg.type == "string")
        }
    }

    private fun unquotePartial(input: String): String {
        val opening = input.firstOrNull()
        if (opening != '"' && opening != '\'') return input
        val reader = com.mojang.brigadier.StringReader(input)
        reader.skip()
        return try {
            reader.readStringUntil(opening)
        } catch (_: com.mojang.brigadier.exceptions.CommandSyntaxException) {
            input.drop(1).replace("\\$opening", opening.toString()).replace("\\\\", "\\")
        }
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
            "sender" to marshalSender(sender),
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

    private fun marshalSender(sender: CommandSender) = mapOf(
        "__ref" to refRegistry.put(sender),
        "__class" to sender.javaClass.simpleName,
        "name" to sender.name,
        "isPlayer" to (sender is Player),
    )

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

internal fun invokeCommandSuggestions(plugin: JavaPlugin, native: NativeLoader, id: Long, args: List<Any?>): List<String> {
    return try {
        val bytes = native.invokeJsProxy(id, "suggest", EventEncoder.encode(args))
        val result = CborDecoder.decode(bytes).firstOrNull() as? CborArray
        result?.dataItems.orEmpty().mapNotNull { (it as? UnicodeString)?.string }
    } catch (e: Exception) {
        plugin.logger.warning("dynamic suggester $id failed: ${e.message}")
        emptyList()
    }
}

internal fun addCommandSuggestions(
    builder: SuggestionsBuilder,
    partial: String,
    items: Iterable<String>,
    quote: Boolean = false,
) = builder.apply {
    items.asSequence()
        .filter { it.isNotEmpty() && it.startsWith(partial, ignoreCase = true) }
        .distinct()
        .take(256)
        .forEach { suggest(if (quote) StringArgumentType.escapeIfRequired(it) else it) }
}.buildFuture()
