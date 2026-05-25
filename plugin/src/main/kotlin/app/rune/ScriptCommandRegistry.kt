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
    private val registeredNames: MutableSet<String> = mutableSetOf()

    /** Called by [CommandExecutor] when it sees a RegisterCommand HostCommand. */
    fun queue(spec: CommandSpec) {
        if (registeredNames.contains(spec.name)) {
            plugin.logger.warning(
                "command '${spec.name}' was already registered with Brigadier; " +
                    "its handler body will update on /rune reload, but argument " +
                    "shape changes require a server restart."
            )
            return
        }
        specs.add(spec)
        registeredNames.add(spec.name)
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

        if (spec.args.isEmpty()) {
            root.executes { ctx -> dispatch(spec, ctx, emptyMap(), native) }
            return root
        }

        // Build the arg chain back-to-front so each arg's `.then(next)` has
        // its successor ready. Each level can also be a terminal if the arg
        // is marked optional -- that creates a Brigadier branch that dispatches
        // without consuming the rest.
        val argNodes = spec.args.map { arg ->
            val node = buildArgumentNode(arg)
            if (arg.suggestions.isNotEmpty()) {
                node.suggests(staticSuggester(arg.suggestions))
            }
            arg to node
        }
        // Wire executes() and chain.
        for (i in argNodes.indices.reversed()) {
            val (arg, node) = argNodes[i]
            // If this is the last required arg (or any arg, really), bind
            // executes that parses everything up to here.
            node.executes { ctx ->
                val resolved = LinkedHashMap<String, Any?>()
                for (j in 0..i) {
                    val a = argNodes[j].first
                    resolved[a.name] = readArg(ctx, a)
                }
                dispatch(spec, ctx, resolved, native)
            }
            if (i < argNodes.size - 1) {
                node.then(argNodes[i + 1].second)
            }
            // Optional args: also wire the parent (i-1) to be a terminal,
            // handled below in root's executes-when-no-args branch.
        }
        root.then(argNodes[0].second)

        // If the first arg is optional, also let the bare command run.
        if (spec.args[0].optional) {
            root.executes { ctx -> dispatch(spec, ctx, emptyMap(), native) }
        }
        return root
    }

    /**
     * Brigadier SuggestionProvider that returns a fixed list, filtered by
     * the partial input the user has typed. Static-at-registration --
     * full dynamic-per-keystroke suggesters need a synchronous Kotlin->JS
     * call which is a follow-up.
     */
    private fun staticSuggester(items: List<String>): SuggestionProvider<CommandSourceStack> {
        return SuggestionProvider { ctx, builder ->
            val remaining = builder.remaining.lowercase()
            for (item in items) {
                if (item.lowercase().startsWith(remaining)) {
                    builder.suggest(item)
                }
            }
            builder.buildFuture()
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
            "sender" to mapOf(
                "__ref" to refRegistry.put(sender),
                "__class" to sender.javaClass.simpleName,
                "name" to sender.name,
                "isPlayer" to (sender is Player),
            ),
            "args" to resolvedArgs.mapValues { (_, v) -> marshalArg(v) },
            "label" to spec.name,
        )
        val bytes = EventEncoder.encode(marshalled)
        native.dispatchEvent("__rune_command:${spec.name}", bytes)
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
