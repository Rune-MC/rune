package app.rune

import io.papermc.paper.command.brigadier.Commands
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents
import org.bukkit.command.CommandSender
import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

class RunePlugin : JavaPlugin() {

    private var native: NativeLoader? = null
    private var scriptsDir: Path? = null
    private var refRegistry: RefRegistry? = null
    private var subscribedEvents: MutableSet<String>? = null
    private var scriptCommands: ScriptCommandRegistry? = null

    override fun onEnable() {
        // Register /rune commands BEFORE we try anything that might throw.
        // The LifecycleEventManager is wired during plugin load, and paper
        // dispatches the COMMANDS event independently of onEnable's success;
        // registering here keeps the command available even if init below
        // partially fails (so the user can /rune reload after fixing the
        // problem).
        registerAdminCommands()

        try {
            val libPath = NativeLibraryExtractor(this).extract()
            logger.info("Native library extracted to $libPath")

            // esbuild + ts-loader for decorator/Stage-3-syntax support. Must
            // be on disk BEFORE NodeBackend's bootstrap runs (the bootstrap
            // calls module.register() against ts-loader.mjs).
            RuntimeAssetExtractor(this).extract()

            val typesPath = TypesExtractor(this).extract()
            logger.info("Type definitions written to $typesPath")

            // Reflective TS surface: walk every Bukkit/Paper/Adventure class
            // this server has loaded and emit a `bukkit.d.ts` so scripts get
            // autocomplete for the full server API, not just the hand-curated
            // bits in rune.d.ts. Merges with rune.d.ts via interface merging.
            val tsGen = TsSurfaceGenerator(this)
            val bukkitDts = tsGen.generate()
            val bukkitDtsPath = typesPath.resolveSibling("bukkit.d.ts")
            Files.writeString(bukkitDtsPath, bukkitDts)
            logger.info("Bukkit surface types written to $bukkitDtsPath")

            // events.d.ts: maps every discovered event class into RuneEventMap.
            // This is what makes `rune.on("PlayerJoinEvent", (e) => ...)` and
            // `@EventHandler("BlockBreakEvent")` get the right event interface
            // as the `e` parameter type. Written under types/ so the bundled
            // tsconfig's `./types/**/*.d.ts` glob picks it up automatically.
            val eventsDtsDir = bukkitDtsPath.resolveSibling("types")
            Files.createDirectories(eventsDtsDir)
            val eventsDtsPath = eventsDtsDir.resolve("events.d.ts")
            Files.writeString(eventsDtsPath, EventTypeMapGenerator(this).generate())
            logger.info("Event type map written to $eventsDtsPath")

            val scriptsRoot = dataFolder.toPath().resolve("scripts")
            Files.createDirectories(scriptsRoot)
            scriptsDir = scriptsRoot

            // rune.jsonc walk: collect plugin deps + aliases declared by
            // user scripts. Plugin deps must be present on the server; we
            // log SEVERE if a required one is missing. For present deps,
            // we extract per-plugin TS types (so e.g. `papi.PlaceholderAPI`
            // autocompletes). Aliases get materialised to
            // runtime/aliases.json which the Node bootstrap consumes.
            val config = RuneConfigReader(this).load(scriptsRoot)
            val runtimeDir = dataFolder.toPath().resolve("runtime")
            val depLoaders = wireConfigArtifacts(config, scriptsRoot, runtimeDir, tsGen)

            val loader = NativeLoader(libPath, scriptsRoot)
            native = loader

            // Subscription set shared between the executor (writer) and the
            // forwarder (reader). ConcurrentHashMap.newKeySet() because events
            // may fire on any thread before being marshalled to main.
            val subs: MutableSet<String> = ConcurrentHashMap.newKeySet()
            subscribedEvents = subs
            // Ref registry holds live Bukkit objects keyed by integer IDs so
            // scripts can call methods on them via the sync-query channel.
            val refs = RefRegistry()
            refRegistry = refs
            val marshaller = EventMarshaller(refs)

            // Wire the synchronous-upcall handler before loading any scripts,
            // so a script that does `Bukkit.getOnlinePlayers()` at top level
            // sees a live callback.
            loader.installQueryHandler(QueryHandler(refs, marshaller, this, depLoaders))

            // Bridge for Java -> JS proxy dispatch (used by `rune.implement`).
            // ByteBuddy-generated subclasses route their intercepted methods
            // through JsProxyDispatcher, which needs:
            //   * loader.invokeJsProxy to reach the JS handler table
            //   * marshaller to box Java call args into Bukkit-ref snapshots
            //   * refRegistry so the JS return value can resolve refs back
            JsProxyDispatcher.install(
                JsProxyDispatcher.Bridge(
                    invoker = { id, name, args -> loader.invokeJsProxy(id, name, args) },
                    marshaller = marshaller,
                    registry = refs,
                ),
            )

            // Script-defined commands collect into this registry as scripts
            // call rune.command(...) / @Command. The Brigadier lifecycle
            // handler reads it AFTER onEnable returns -- see registerAdminCommands.
            val cmds = ScriptCommandRegistry(this, refs)
            scriptCommands = cmds

            val executor = CommandExecutor(this, loader, subs, cmds)

            // Load scripts first so they get a chance to call `rune.on(...)`,
            // which queues SubscribeEvent commands.
            loadAllScripts(loader, scriptsRoot)

            // Drain the queue once synchronously so the subscription set is
            // populated BEFORE we register Bukkit listeners -- otherwise the
            // first events fired during world load would slip through with an
            // empty subscription set.
            executor.run()

            val registered = GenericEventForwarder(loader, this, subs, marshaller).registerAll()
            logger.info("Event forwarder online ($registered classes, ${subs.size} subscribed)")

            executor.start()

            logger.info("Rune enabled.")
        } catch (e: Throwable) {
            logger.severe("Rune init failed: ${e.message}")
            e.printStackTrace()
            server.pluginManager.disablePlugin(this)
        }
    }

    override fun onDisable() {
        // Drop the proxy bridge before tearing the loader down -- otherwise
        // a stray PAPI call during shutdown could still hit a half-freed
        // backend via the cached invoker closure.
        JsProxyDispatcher.uninstall()
        native?.close()
        native = null
        logger.info("Rune disabled.")
    }

    /**
     * Register the built-in `/rune` admin commands via Paper's Brigadier
     * lifecycle event. paper-plugin.yml ignores the legacy `commands:`
     * block, so this is the only path that actually surfaces commands.
     *
     * Subcommands: `reload`, `status`.
     */
    private fun registerAdminCommands() {
        lifecycleManager.registerEventHandler(LifecycleEvents.COMMANDS) { event ->
            val commands = event.registrar()
            val root = Commands.literal("rune")
                .requires { it.sender.hasPermission("rune.admin") || it.sender.isOp }
                .then(
                    Commands.literal("reload").executes { ctx ->
                        val loader = native
                        if (loader == null) {
                            ctx.source.sender.sendMessage("Rune is not initialised.")
                        } else {
                            handleReload(ctx.source.sender, loader)
                        }
                        com.mojang.brigadier.Command.SINGLE_SUCCESS
                    }
                )
                .then(
                    Commands.literal("status").executes { ctx ->
                        val loader = native
                        if (loader == null) {
                            ctx.source.sender.sendMessage("Rune is not initialised.")
                        } else {
                            handleStatus(ctx.source.sender, loader)
                        }
                        com.mojang.brigadier.Command.SINGLE_SUCCESS
                    }
                )
                .then(
                    // /rune new <name> [lang]
                    Commands.literal("new")
                        .then(
                            Commands.argument("name", com.mojang.brigadier.arguments.StringArgumentType.word())
                                .then(
                                    Commands.argument("lang", com.mojang.brigadier.arguments.StringArgumentType.word())
                                        .suggests { _, b ->
                                            ScriptScaffolder(this@RunePlugin).availableLanguages()
                                                .forEach { if (it.startsWith(b.remaining)) b.suggest(it) }
                                            b.buildFuture()
                                        }
                                        .executes { ctx ->
                                            val name = com.mojang.brigadier.arguments.StringArgumentType.getString(ctx, "name")
                                            val lang = com.mojang.brigadier.arguments.StringArgumentType.getString(ctx, "lang")
                                            handleNewScript(ctx.source.sender, name, lang)
                                            com.mojang.brigadier.Command.SINGLE_SUCCESS
                                        }
                                )
                                .executes { ctx ->
                                    val name = com.mojang.brigadier.arguments.StringArgumentType.getString(ctx, "name")
                                    handleNewScript(ctx.source.sender, name, "ts")
                                    com.mojang.brigadier.Command.SINGLE_SUCCESS
                                }
                        )
                )
                .executes { ctx ->
                    ctx.source.sender.sendMessage("Usage: /rune <reload|status|new <name> [lang]>")
                    com.mojang.brigadier.Command.SINGLE_SUCCESS
                }
                .build()
            commands.register(root, "Manage the Rune scripting runtime.", listOf("r"))

            // Script-defined Brigadier commands. They were queued by the
            // initial onEnable script load (the COMMANDS lifecycle event
            // fires after onEnable returns, so the queue is populated by
            // the time we get here).
            val cmds = scriptCommands
            val loader = native
            if (cmds != null && loader != null) {
                cmds.registerWithBrigadier(commands, loader)
            }
        }
    }

    private fun handleReload(sender: CommandSender, loader: NativeLoader) {
        val scriptsRoot = scriptsDir
        val refs = refRegistry
        val subs = subscribedEvents
        if (scriptsRoot == null || refs == null || subs == null) {
            sender.sendMessage("Rune state missing -- restart the server.")
            return
        }

        val started = System.nanoTime()
        sender.sendMessage("Reloading Rune scripts...")
        try {
            // Wipe state that's keyed against the OLD JS env. The new env
            // starts with no handlers, no refs, no subscriptions -- scripts
            // re-register everything as they re-execute.
            refs.clear()
            subs.clear()

            // Tear down + rebuild the Node env, then replay every script
            // that was previously loaded.
            val rc = loader.reload()
            if (rc != 0) {
                sender.sendMessage("Reload failed: rune_reload returned $rc. See server log.")
                return
            }

            // Pick up any newly-added script files. loadAllScripts dedupes
            // via NodeBackend's loaded_scripts vec, so the just-replayed
            // scripts won't be re-loaded twice.
            loadAllScripts(loader, scriptsRoot)

            val ms = (System.nanoTime() - started) / 1_000_000
            sender.sendMessage("Reloaded in ${ms}ms (${subs.size} event subscriptions).")
            logger.info("/rune reload completed in ${ms}ms")
        } catch (e: Throwable) {
            sender.sendMessage("Reload error: ${e.message}")
            logger.severe("/rune reload failed: ${e.message}")
            e.printStackTrace()
        }
    }

    /**
     * Materialise the artifacts driven by `rune.jsonc`:
     *   * Verify each declared plugin is loaded; warn (or SEVERE for
     *     required) otherwise.
     *   * Run TsSurfaceGenerator against each present plugin's
     *     classloader, writing `scripts/types/<alias>.d.ts`.
     *   * Write `runtime/aliases.json` + `scripts/types/aliases.d.ts`
     *     for the user-declared aliases (incl. each plugin's shortcut).
     */
    private fun wireConfigArtifacts(
        config: MergedConfig,
        scriptsRoot: java.nio.file.Path,
        runtimeDir: java.nio.file.Path,
        tsGen: TsSurfaceGenerator,
    ): List<ClassLoader> {
        val typesDir = scriptsRoot.resolve("types")
        Files.createDirectories(typesDir)

        // Per-plugin presence check + type generation. Each present dep
        // contributes its classloader so QueryHandler can resolve
        // `Class.forName("me.clip.placeholderapi.PlaceholderAPI", ...)`
        // -- Paper plugins don't see each other's classes by default.
        val depLoaders = mutableListOf<ClassLoader>()
        for ((name, dep) in config.plugins) {
            val present = server.pluginManager.getPlugin(name)
            if (present == null) {
                if (dep.required) {
                    logger.severe("rune.jsonc declares required plugin '$name' but it's not loaded.")
                } else {
                    logger.warning("rune.jsonc declares optional plugin '$name' which is not loaded.")
                }
                continue
            }
            depLoaders.add(present.javaClass.classLoader)
            val pkg = dep.`package`
            if (pkg.isNullOrBlank()) {
                logger.warning("rune.jsonc: plugin '$name' has no `package` field; skipping type generation.")
                continue
            }
            val alias = dep.alias ?: name.lowercase()
            try {
                val dts = tsGen.generateForPlugin(
                    present.javaClass.classLoader,
                    pkg,
                    alias,
                )
                val out = typesDir.resolve("$alias.d.ts")
                Files.writeString(out, dts)
                logger.info("plugin types for '$name' ($alias) written to $out")
            } catch (e: Throwable) {
                logger.warning("failed to emit plugin types for '$name': ${e.message}")
            }
        }

        // Alias artifacts. Runtime gets every alias (so plugin shortcuts
        // like `papi` get a real global proxy installed at boot); TS only
        // gets USER-declared ones (plugin shortcuts get their types from
        // the per-plugin .d.ts which declares `namespace <alias> { ... }`
        // -- duplicating the binding in aliases.d.ts collapses to `any`).
        val pluginAliasNames = config.plugins.values
            .mapNotNull { it.alias }
            .toSet()
        val tsAliases = config.aliases.filterKeys { it !in pluginAliasNames }
        if (config.aliases.isNotEmpty()) {
            AliasArtifacts(this).write(runtimeDir, typesDir, config.aliases, tsAliases)
        } else {
            // Make sure stale state from a previous run doesn't linger.
            runCatching { Files.deleteIfExists(runtimeDir.resolve("aliases.json")) }
            runCatching { Files.deleteIfExists(typesDir.resolve("aliases.d.ts")) }
        }

        // Maven coords: stub for now. Scenario B in the design -- pulling
        // JARs to a local cache for dev-time type extraction requires
        // either a heavy resolver lib (Shrinkwrap/Aether) or a hand-rolled
        // POM walker. Log a clear "not yet" so users see the feature is
        // planned but inactive; runtime behaviour is unaffected.
        if (config.maven.isNotEmpty()) {
            logger.warning(
                "rune.jsonc 'maven' coordinates declared but Maven resolution " +
                    "is not yet implemented in this Rune build. " +
                    "Install the corresponding plugins / library JARs manually " +
                    "for now. Coords seen: ${config.maven.keys.joinToString()}"
            )
        }

        return depLoaders
    }

    private fun handleNewScript(sender: CommandSender, name: String, lang: String) {
        val root = scriptsDir
        if (root == null) {
            sender.sendMessage("Rune scripts dir not initialised.")
            return
        }
        val result = ScriptScaffolder(this).create(root, name, lang)
        if (result.error != null) {
            sender.sendMessage("§c${result.error}")
            return
        }
        sender.sendMessage("§aCreated script: §f${result.created}")
        sender.sendMessage("§7Run §f/rune reload§7 to load it.")
    }

    private fun handleStatus(sender: CommandSender, @Suppress("unused_parameter") loader: NativeLoader) {
        val refs = refRegistry
        val subs = subscribedEvents
        sender.sendMessage("Rune status:")
        sender.sendMessage("  refs:          ${refs?.size() ?: "?"}")
        sender.sendMessage("  subscriptions: ${subs?.size ?: "?"}")
        sender.sendMessage("  scripts dir:   ${scriptsDir ?: "?"}")
    }

    /**
     * Walks the top level of [scriptsDir] and loads each script.
     *
     * A "script" is either:
     *   * a `.js` / `.mjs` / `.ts` file directly under `scripts/`, or
     *   * a directory containing `index.{ts,mjs,js}` (a folder-script).
     *
     * Skipped: `node_modules`, hidden files, declaration files (`.d.ts`),
     * tsconfig/jsconfig/package.json, and the bundled `rune.d.ts`.
     */
    private fun loadAllScripts(loader: NativeLoader, scriptsDir: Path) {
        Files.list(scriptsDir).use { stream ->
            stream.sorted().forEach { entry ->
                val name = entry.fileName.toString()
                val lower = name.lowercase()
                if (
                    lower.startsWith(".") ||
                    lower == "node_modules" ||
                    lower == "tsconfig.json" ||
                    lower == "jsconfig.json" ||
                    lower == "package.json" ||
                    lower.endsWith(".d.ts")
                ) {
                    return@forEach
                }

                val toLoad: Path? = when {
                    Files.isRegularFile(entry) && (
                        lower.endsWith(".js") ||
                        lower.endsWith(".mjs") ||
                        lower.endsWith(".ts")
                    ) -> entry
                    Files.isDirectory(entry) -> sequenceOf("index.ts", "index.mjs", "index.js")
                        .map { entry.resolve(it) }
                        .firstOrNull { Files.exists(it) }
                    else -> null
                }
                if (toLoad == null) {
                    logger.info("Skipping $name (no entry file)")
                    return@forEach
                }

                val rc = loader.loadScript(toLoad)
                if (rc != 0) {
                    logger.warning("loadScript($name) returned $rc")
                } else {
                    logger.info("Loaded script $name")
                }
            }
        }
    }
}
