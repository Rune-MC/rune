// Type definitions for the `rune` global available to Rune scripts.
//
// Auto-extracted by the plugin on enable. Do NOT edit -- overwritten on
// every server start. The companion tsconfig.json wires this file in
// automatically.
//
// HOW IT WORKS
// ============
// The plugin auto-registers a listener for EVERY org.bukkit.event.Event
// subclass on the Paper classpath. Subscribe with:
//   rune.on("PlayerJoinEvent", e => ...)
//
// Event payload fields that reference Bukkit objects (Player, Block, World,
// ...) arrive as LIVE references. Method calls on them are SYNCHRONOUS:
//
//   rune.on("PlayerJoinEvent", e => {
//     e.player.sendMessage("welcome!");
//     const health: number = e.player.getHealth();          // sync read works
//     e.player.teleport(rune.callStatic(
//         "org.bukkit.Location", "valueOf", "world,0,100,0"));
//   });
//
// Method calls run synchronously on the Paper main thread via an upcall
// callback, so the return value is delivered back inline. Bukkit objects
// returned by methods are wrapped in the same proxy, so chained calls
// (`world.getBlockAt(x,y,z).getType()`) work.
//
// Static APIs live on `rune.bukkit`, `rune.material`, etc., or via the
// generic `rune.callStatic` / `rune.getStatic` / `rune.javaClass` /
// `rune.javaEnum` helpers.

export {};

declare global {
    const rune: RuneApi;
    const console: RuneConsole;

    // Top-level Java package roots. The fully-typed entries (`bukkit`,
    // `paper`, `kyori`) are declared as TS namespaces in the auto-generated
    // bukkit.d.ts -- per-class `const X: { new(...): X; ...statics... }`
    // declarations so `new bukkit.inventory.ItemStack(...)` is properly
    // typed. The roots below are fallbacks for classes we don't reflect
    // (Java SE, third-party libs); they navigate at runtime via Proxy but
    // are weakly typed.
    //
    //   const map = new java.util.HashMap();          // weakly typed
    //   const item = new bukkit.inventory.ItemStack(  // fully typed
    //     bukkit.Material.DIAMOND,
    //   );
    const org:    JavaPackage;
    const java:   JavaPackage;
    const javax:  JavaPackage;
    const net:    JavaPackage;
    const io:     JavaPackage;
    const com:    JavaPackage;
}

// Navigable Java package. Sub-properties resolve to either another
// JavaPackage (lowercase first letter) or a JavaClass (uppercase).
// We can't statically narrow which is which, so the index signature
// returns the union and TS infers via usage.
interface JavaPackage {
    readonly [name: string]: JavaPackage | JavaClass<any>;
}

/**
 * A reflective handle on a Java class. Constructable via `new` or called
 * as a function (both invoke the matching constructor), and indexable for
 * static members:
 *
 *   const stack = new ItemStack(material);   // constructor
 *   const list  = bukkit.Bukkit.getOnlinePlayers();  // static method
 *   const stone = bukkit.Material.STONE;             // static field
 */
interface JavaClass<T = any> {
    new(...args: any[]): T;
    (...args: any[]): T;
    readonly [member: string]: any;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

interface RuneApi {
    /** Broadcast a chat message to every online player. */
    broadcast(message: string): void;

    /**
     * Subscribe to a Bukkit event. Preferred form uses the typed
     * `Events.X` enum value -- lambdas get full parameter inference:
     *
     *   rune.on(Events.AsyncChatEvent, (e) => { e.message... });
     *
     * String form still works for events not in RuneEventMap (e.g.
     * third-party plugin events not on the classpath at type-gen time).
     */
    on<E>(event: EventKey<E>, handler: (e: E) => void | Promise<void>): void;
    on<K extends keyof RuneEventMap>(
        event: K,
        handler: (e: RuneEventMap[K]) => void | Promise<void>,
    ): void;
    on(event: string, handler: (e: Record<string, unknown>) => void): void;

    /**
     * Register a Brigadier command. Two shapes -- pick whichever fits:
     *
     *   rune.command({                                     // object form
     *     name: 'mongo-status',
     *     description: '...',
     *     permission: 'rune.admin',
     *     args: [{ name: 'count', type: 'int', min: 1 }],
     *     async run(ctx) { ctx.sender.sendMessage(`${ctx.args.count}`); },
     *   });
     *
     *   rune.command('mongo-status')                       // builder form
     *     .description('...')
     *     .permission('rune.admin')
     *     .arg('count', 'int', { min: 1 })
     *     .executes(async (ctx) => { ... })
     *     .register();
     *
     * Argument-shape changes require a server restart (Paper's Brigadier
     * tree is locked once the COMMANDS lifecycle event fires); /rune reload
     * updates the handler body in place. Decorator-style (`@Command`) is
     * planned once Node 22 supports decorator transformation -- not in
     * amaro 1.1.8.
     */
    command(spec: CommandSpec): string;
    command(name: string): CommandBuilder;

    // ---------------- Persistence ----------------
    /**
     * Open (or create) a key/value store persisted to
     * `plugins/Rune/store/<name>.json`. Survives /rune reload AND server
     * restarts; auto-saves on every set/delete. Values must be
     * JSON-serialisable (no live Bukkit refs).
     *
     *   const homes = rune.store("homes");
     *   homes.set(player.uuid, { x, y, z, world });
     *   const home = homes.get(player.uuid);
     */
    store(name: string): RuneStore;

    // ---------------- Scheduling ----------------
    /**
     * Convenience wrappers around setTimeout/setInterval that count in
     * Minecraft ticks (1 tick = 50 ms). Callbacks always fire on the
     * Paper main thread -- safe for Bukkit calls.
     */
    readonly schedule: RuneSchedule;

    // ---------------- Constructor shortcuts ----------------
    /**
     * Build a custom ItemStack in one call. The optional metaFn lets
     * you mutate the meta without the verbose getItemMeta/setItemMeta
     * dance.
     *
     *   rune.itemstack(bukkit.Material.DIAMOND_SWORD, 1, (meta) => {
     *     meta.displayName(Component.text("Excalibur"));
     *     meta.lore([Component.text("Wielded by kings")]);
     *   });
     */
    itemstack(
        material: Material,
        count?: number,
        metaFn?: (meta: ItemMeta) => void,
    ): ItemStack;

    /**
     * Build a NamespacedKey. `"foo"` -> `rune:foo`; `"plugin:foo"` -> as-is.
     * Most user scripts want `rune:` for their custom recipes / keys.
     */
    key(key: string): NamespacedKey;

    /** Build a Location. Yaw + pitch default to 0. */
    location(
        world: World,
        x: number, y: number, z: number,
        yaw?: number, pitch?: number,
    ): Location;

    // ---------------- Message helpers ----------------
    /**
     * Parse MiniMessage to an Adventure Component. Used internally by
     * `msg` / `title` / `actionBar` and the `item().name(...)` builder;
     * exposed so scripts can pre-build components for re-use.
     */
    mm(template: string): any;
    /** Send a MiniMessage-formatted line. `audience` may be a single ref or array. */
    msg(audience: any | any[], template: string): void;
    /**
     * Show a title to `player`. All durations are in ms; defaults are
     * 500 / 3000 / 500.
     */
    title(
        player: Player,
        title: string,
        subtitle?: string,
        opts?: { fadeInMs?: number; stayMs?: number; fadeOutMs?: number },
    ): void;
    /** Push a MiniMessage-formatted action-bar line. */
    actionBar(player: Player, template: string): void;

    // ---------------- Builders ----------------
    /**
     * Fluent ItemStack builder. Replaces the verbose
     * `getItemMeta()` / `setItemMeta()` dance.
     *
     *   const sword = rune.item(bukkit.Material.DIAMOND_SWORD)
     *     .name("<gold>Excalibur")
     *     .lore(["<gray>Wielded by kings"])
     *     .enchant("sharpness", 5)
     *     .unbreakable()
     *     .glow()
     *     .build();
     */
    item(material: Material): ItemBuilder;

    /**
     * Spawn a Bukkit entity at `location`. `typeName` is matched
     * case-insensitively against `EntityType` constants (zombie,
     * skeleton, item_display, ...). Optional `configure` callback
     * fires synchronously on the spawned entity.
     */
    spawn(
        location: Location,
        typeName: string,
        configure?: (entity: Entity) => void,
    ): Entity;

    /**
     * Chest GUI with per-slot click handlers. All clicks inside the
     * GUI are auto-cancelled (so display items can't be picked up).
     *
     *   const gui = rune.gui({ title: "<gold>Shop", rows: 3 }, (g) => {
     *     g.border(rune.item(bukkit.Material.BLACK_STAINED_GLASS_PANE).name(" ").build());
     *     g.slot(13,
     *       rune.item(bukkit.Material.DIAMOND).name("Buy").build(),
     *       (e) => {
     *         e.getWhoClicked().sendMessage("Purchased!");
     *         e.getWhoClicked().closeInventory();
     *       },
     *     );
     *     g.onClose((e) => console.info("closed"));
     *   });
     *   gui.open(player);
     */
    gui(spec: GuiSpec, init?: (gui: Gui) => void): Gui;

    // ---------------- Static Java surface ----------------
    /** org.bukkit.Bukkit static methods. */
    readonly bukkit: BukkitStatic;
    /** Material enum values (e.g. `rune.material.STONE`). */
    readonly material: Record<string, Material>;
    /** EntityType enum values (e.g. `rune.entityType.ZOMBIE`). */
    readonly entityType: Record<string, EntityTypeRef>;
    /** Particle enum values. */
    readonly particle: Record<string, ParticleRef>;
    /** Sound enum values. */
    readonly sound: Record<string, SoundRef>;
    /**
     * PersistentDataType singletons -- pass to
     * `meta.getPersistentDataContainer().set(key, type, value)`. Common:
     * `rune.pdt.STRING`, `rune.pdt.INTEGER`, `rune.pdt.LONG`, `.DOUBLE`,
     * `.BYTE`, `.BYTE_ARRAY`, `.BOOLEAN` (Paper).
     */
    readonly pdt: Record<string, any>;

    /** Call any public static method on any class on the Paper classpath. */
    callStatic<T = unknown>(className: string, method: string, ...args: unknown[]): T;
    /** Read any public static field. Returns a wrapped ref if it's a Bukkit type. */
    getStatic<T = unknown>(className: string, field: string): T;
    /**
     * Reflective handle on a Java class. Constructable, callable, and
     * indexable for static members. Equivalent to navigating the package
     * proxies (e.g. `rune.javaClass('org.bukkit.inventory.ItemStack')` ==
     * `bukkit.inventory.ItemStack`).
     */
    javaClass<T = any>(className: string): JavaClass<T>;
    /** Returns a proxy whose property reads return static fields. */
    javaEnum(className: string): Record<string, unknown>;
    /**
     * Construct any Java class by FQN. Equivalent to
     * `new rune.javaClass(name)(...args)` but doesn't need an intermediate
     * binding when you're using a class once.
     */
    new<T = any>(className: string, ...args: any[]): T;

    /**
     * Implement (subclass) a Java abstract class or interface from JS.
     *
     * The plugin generates a runtime subclass via ByteBuddy: every
     * abstract method, plus any method whose name appears as a key in
     * `methods`, is intercepted and routed to your JS handler. Other
     * (non-abstract, non-listed) methods inherit the parent's body.
     *
     * The returned ref is a live Bukkit-typed handle -- pass it to any
     * Java API that takes the parent class. Examples:
     *
     *   // PAPI placeholder expansion
     *   const expansion = rune.implement(
     *     "me.clip.placeholderapi.expansion.PlaceholderExpansion",
     *     {
     *       getIdentifier: () => "rune",
     *       getAuthor:     () => "rune-perms",
     *       getVersion:    () => "1.0",
     *       persist:       () => true,
     *       // %rune_prefix%, %rune_suffix_NAME%, ...
     *       onRequest: (offlinePlayer, params) => {
     *         if (params === "prefix") return getPrefixFor(offlinePlayer);
     *         if (params.startsWith("suffix_")) return ...;
     *         return null;
     *       },
     *     },
     *   );
     *   papi.PlaceholderAPI.registerExpansion(expansion);
     *
     * Handler invocation is synchronous from Java's perspective; your
     * function runs against the V8 isolate inline (cross-thread-safe
     * via v8::Locker). Handlers MUST be synchronous: returning a
     * promise will resolve to a "[Promise]" string, not the awaited
     * value.
     *
     * Arguments arrive wrapped as Bukkit refs where applicable, so you
     * can call `.getName()` / `.getUniqueId()` etc. directly. The
     * return value is coerced to the method's declared return type
     * (string, number, boolean, or Bukkit ref).
     */
    implement<T = any>(
        className: string,
        methods: Record<string, (...args: any[]) => unknown>,
    ): T;
}

interface BukkitStatic {
    broadcastMessage(message: string): number;
    getOnlinePlayers(): Player[];
    getPlayer(name: string): Player | null;
    getServer(): unknown;
    getWorld(name: string): World | null;
    getWorlds(): World[];
    getMaxPlayers(): number;
    [method: string]: any;
}

// ---------------------------------------------------------------------------
// Reference classes -- live Bukkit objects.
//
// `Player`, `Entity`, `Block`, `Location`, `World`, `ItemStack`,
// `PersistentDataContainer`, `Material`, etc. are EXCLUSIVELY declared in
// the auto-generated `bukkit.d.ts` (via `declare global { ... }`). The
// runtime proxy supports both `player.getName()` (Bukkit) and synthetic
// shortcuts like `player.uuid` -- but to avoid the "two unrelated types
// with the same name" TS error that hit users in earlier versions, only
// the full Bukkit-generated interfaces are exported. Use `.getName()` /
// `.getUniqueId().toString()` for stable access; the snapshot shortcuts
// still work at runtime if you cast through `as any`.
//
// RuneRef is hoisted to the global scope below so bukkit.d.ts's
// `interface Player extends ... RuneRef` resolves correctly.
// ---------------------------------------------------------------------------

declare global {
    /** Marker present on every Bukkit-backed object. Internal. */
    interface RuneRef {
        readonly __ref: number;
        readonly __class: string;
    }

    // Node globals (`process`, `Buffer`, `require`, ...) come from the
    // vendored @types/node tree extracted next to this file on plugin
    // enable. tsconfig.json's "types": ["node"] picks them up; nothing
    // to hand-roll here.

    // EntityType, Particle, Sound -- enum-style ref bundles surfaced by
    // rune.entityType / rune.particle / rune.sound. The full Bukkit types
    // are in bukkit.d.ts; these aliases keep the rune.d.ts return-type
    // declarations terse.
    type EntityTypeRef = RuneRef & { [method: string]: any };
    type ParticleRef = RuneRef & { [method: string]: any };
    type SoundRef = RuneRef & { [method: string]: any };

    // ----- Builders / factories -----

    interface ItemBuilder {
        amount(n: number): ItemBuilder;
        name(miniMessage: string): ItemBuilder;
        lore(miniMessageLines: string[]): ItemBuilder;
        /**
         * Add an enchantment. `id` is a minecraft-namespaced key
         * (`sharpness`, `mending`, `unbreaking`, ...); custom datapack
         * enchants can be `"datapack:enchant_name"`.
         */
        enchant(id: string, level?: number): ItemBuilder;
        unbreakable(): ItemBuilder;
        /** Cosmetic shimmer (hidden unbreaking enchant). */
        glow(): ItemBuilder;
        customModelData(n: number): ItemBuilder;
        /** Add a Bukkit ItemFlag constant by name (`HIDE_ENCHANTS`, ...). */
        flag(name: string): ItemBuilder;
        /**
         * Set a PersistentDataContainer entry (modern Bukkit NBT).
         *
         *   .data("origin", "trial_chamber")     // STRING (auto-typed)
         *   .data("level", 7)                    // INTEGER (auto)
         *   .data("weight", 3.5)                 // DOUBLE (auto)
         *   .data("magic", true)                 // BOOLEAN/BYTE (auto)
         *   .data("count", 100n, rune.pdt.LONG)  // explicit type
         *
         * Bare keys land under `rune:` (so `.data("foo", ...)` writes to
         * `rune:foo`). Use `"plugin:name"` for another namespace.
         */
        data(key: string, value: string | number | bigint | boolean, type?: any): ItemBuilder;
        /**
         * Set the skull owner for a `PLAYER_HEAD` item so it renders that
         * player's skin. Accepts a Player / OfflinePlayer ref, a UUID
         * string, or a player name. No-op for non-PLAYER_HEAD materials.
         *
         *   rune.item(bukkit.Material.PLAYER_HEAD)
         *     .skullOwner(player)
         *     .name("<gold>" + player.getName())
         *     .build();
         */
        skullOwner(target: Player | OfflinePlayer | string): ItemBuilder;
        build(): ItemStack;
    }

    interface GuiSpec {
        title?: string;
        /** Rows 1-6 (each 9 slots). Default 3. */
        rows?: number;
    }

    /**
     * The Gui object is also a live `Inventory` ref -- unknown property
     * reads delegate to the underlying Bukkit Inventory. That makes both
     * sides of the comparison work in event handlers:
     *
     *   if (event.getInventory().equals(gui)) { ... }
     *   if (event.getClickedInventory()?.__ref === gui.__ref) { ... }
     *
     * The index signature lets TypeScript accept arbitrary Inventory
     * method calls (`gui.getSize()`, `gui.getViewers()`, ...) -- they
     * dispatch through the proxy bridge at call time.
     */
    /**
     * Click handler signature for `gui.slot/fill/border`. The event is
     * Bukkit's `InventoryClickEvent` with all the usual methods
     * (`getWhoClicked()`, `getRawSlot()`, `getCurrentItem()`, etc.).
     *
     * **You DO NOT need to call `e.setCancelled(true)` -- Rune cancels
     * every click while the gui is being viewed before invoking your
     * handler.** Just do the side-effect (open another gui, give an
     * item, close the inventory, ...).
     */
    type GuiClickHandler = (e: InventoryClickEvent) => void;

    interface Gui {
        /** Place an item at `slot`. Click handler is optional. */
        slot(slot: number, item: ItemStack, onClick?: GuiClickHandler): Gui;
        /** Fill empty slots (does not overwrite). */
        fill(item: ItemStack, onClick?: GuiClickHandler): Gui;
        /** Decorative border (top + bottom rows, first + last column). */
        border(item: ItemStack, onClick?: GuiClickHandler): Gui;
        /** Callback when the player closes the inventory. */
        onClose(fn: (e: InventoryCloseEvent) => void): Gui;
        /** Open for one player. Re-callable to refresh state. */
        open(player: Player): Gui;
        /** Live `org.bukkit.inventory.Inventory` ref -- escape hatch. */
        readonly inventory: any;
        /** Inventory ref id (delegated from `inventory.__ref`). */
        readonly __ref: number;
        /** Always `"Inventory"`. */
        readonly __class: string;
        /** Delegated Inventory methods (getSize, getViewers, equals, ...). */
        [method: string]: any;
    }
}

// ---------------------------------------------------------------------------
// Event map.
//
// Each entry describes the FLAT fields the host marshals for that event.
// Mutating methods on the event itself (`setCancelled`, `setJoinMessage`,
// ...) are inherited from the JS proxy and listed here for autocomplete.
// ---------------------------------------------------------------------------

interface RuneEventMap {
    PlayerJoinEvent: BaseEvent & {
        player: Player;
        joinMessage: string;
        setJoinMessage(message: string): void;
    };
    PlayerQuitEvent: BaseEvent & {
        player: Player;
        quitMessage: string;
    };
    AsyncChatEvent: BaseEvent & {
        player: Player;
        message: string;
        setCancelled(cancelled: boolean): void;
    };
    BlockBreakEvent: BaseEvent & {
        player: Player;
        block: Block;
        expToDrop: number;
        setCancelled(cancelled: boolean): void;
    };
    BlockPlaceEvent: BaseEvent & {
        player: Player;
        block: Block;
        setCancelled(cancelled: boolean): void;
    };
    PlayerInteractEvent: BaseEvent & {
        player: Player;
        action: string;
        clickedBlock: Block | null;
        item: ItemStack | null;
        setCancelled(cancelled: boolean): void;
    };
    PlayerCommandPreprocessEvent: BaseEvent & {
        player: Player;
        message: string;
        setCancelled(cancelled: boolean): void;
    };
    PlayerDeathEvent: BaseEvent & {
        entity: Player;
        deathMessage: string;
        droppedExp: number;
    };
    EntityDamageEvent: BaseEvent & {
        entity: Entity;
        cause: string;
        damage: number;
        finalDamage: number;
        setCancelled(cancelled: boolean): void;
    };
    EntityDeathEvent: BaseEvent & {
        entity: Entity;
        droppedExp: number;
    };
}

/** Common to every event payload -- the event itself is also a live ref. */
interface BaseEvent extends RuneRef {
    [method: string]: any;
}

interface RuneConsole {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
}

/** Tick-based scheduling helpers. All callbacks fire on the main thread. */
interface RuneSchedule {
    afterTicks(fn: () => void, ticks: number): unknown;
    everyTicks(fn: () => void, ticks: number): unknown;
    afterMs(fn: () => void, ms: number): unknown;
    everyMs(fn: () => void, ms: number): unknown;
    /** Cancel a handle returned by any of the above. */
    cancel(handle: unknown): void;
    /** Run on the next server tick. */
    nextTick(fn: () => void): unknown;
}

/** Map-like persistent key/value store. Backed by JSON on disk. */
interface RuneStore {
    get<T = unknown>(key: string): T | undefined;
    set<T>(key: string, value: T): T;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
    keys(): string[];
    values(): unknown[];
    entries(): Array<[string, unknown]>;
    all(): Record<string, unknown>;
    readonly size: number;
}

// ---------------------------------------------------------------------------
// Brigadier command surface
//
// Everything below is declared inside `declare global { ... }` so user
// scripts see these types without an `import { CommandCtx } from 'rune'`.
// ---------------------------------------------------------------------------

declare global {
    /**
     * Branded-string handle on a Bukkit event class. At runtime it IS the
     * event's simple-name string (via the `Events` proxy), but the brand
     * lets overloads of `rune.on(...)` and `@EventHandler(...)` extract
     * the event interface for handler-arg inference. Generated entries
     * live in the auto-emitted `types/events.d.ts`.
     *
     *   rune.on(Events.AsyncChatEvent, (e) => { /* e: AsyncChatEvent *\/ });
     */
    type EventKey<E> = string & { readonly __eventBrand: E };

    /** Argument types supported by the @Arg decorator + .arg() builder. */
    type ArgType =
        | 'string' | 'word' | 'greedy'
        | 'int' | 'long' | 'double' | 'bool'
        | 'player' | 'players'
        | 'entity' | 'entities'
        | 'world' | 'block_pos';

    interface ArgOptions {
        /** Help text shown by Brigadier for this argument. */
        description?: string;
        /** Brigadier arg type. Defaults to 'string'. */
        type?: ArgType;
        /** For numeric types: inclusive min / max. */
        min?: number;
        max?: number;
        /** Only meaningful as the LAST arg: consume the rest of the line. */
        greedy?: boolean;
        /** If true, the arg may be omitted (Brigadier branches before it). */
        optional?: boolean;
        /**
         * Tab-completion suggestions. Three shapes:
         *   * `string[]` -- fixed list, prefix-filtered by Brigadier
         *   * `() => string[]` -- snapshot at registration time
         *   * `(partial: string) => string[]` -- DYNAMIC: called against
         *     the V8 isolate on every keystroke. Use this for lists that
         *     mutate at runtime (online players via Brigadier built-ins
         *     already work; this is for things like group names that the
         *     script itself owns). The callback runs synchronously --
         *     keep it cheap (Map lookup, not Mongo query).
         */
        suggest?:
            | string[]
            | (() => string[])
            | ((partial: string) => string[]);
        /**
         * Subcommands that branch AFTER this arg slot. Only consulted
         * when using the imperative `rune.command({tree})` form -- the
         * decorator API derives this automatically from the path-string
         * topology across `@Command("a b c")` classes.
         */
        subcommands?: CommandSpec[];
    }

    interface CommandOptions {
        description?: string;
        permission?: string;
        aliases?: string[];
    }

    interface CommandBuilder {
        description(s: string): this;
        permission(s: string): this;
        aliases(...names: string[]): this;
        arg(name: string, type: ArgType, opts?: Omit<ArgOptions, 'type'>): this;
        executes(fn: (ctx: CommandCtx) => void): this;
        register(): this;
    }

    /**
     * Top-level fields for the object form of `rune.command({...})`.
     *
     * Three patterns:
     *
     *   // Flat command -- one executor, no branching
     *   rune.command({
     *     name: "broadcast",
     *     args: [{ name: "msg", type: "greedy", greedy: true }],
     *     run: (ctx) => { ... },
     *   });
     *
     *   // Branching tree -- each subcommand is a Brigadier literal
     *   rune.command({
     *     name: "pex",
     *     subcommands: [
     *       { name: "reload", run: (ctx) => { ... } },
     *       {
     *         name: "user",
     *         args: [{ name: "player", type: "player" }],
     *         run: (ctx) => { ... },          // /pex user <player>
     *         subcommands: [
     *           {
     *             name: "add",
     *             args: [{ name: "perm", type: "string" }],
     *             run: (ctx) => { ... },     // /pex user <player> add <perm>
     *           },
     *           { name: "remove", args: [...], run: ... },
     *         ],
     *       },
     *     ],
     *   });
     *
     *   // Dynamic tab-completion -- suggester callback fires per keystroke
     *   rune.command({
     *     name: "warp",
     *     args: [{ name: "name", type: "word", suggest: (partial) => allWarpNames() }],
     *     run: (ctx) => { ... },
     *   });
     *
     * An intermediate node (one that ONLY branches into subcommands) may
     * omit `run` -- Brigadier just shows usage if the user stops there.
     */
    interface CommandSpec extends CommandOptions {
        name: string;
        args?: Array<{ name: string; type: ArgType } & Omit<ArgOptions, 'type'>>;
        run?: (ctx: CommandCtx) => void | Promise<void>;
        subcommands?: CommandSpec[];
    }

    /**
     * Argument values resolved by Brigadier. Keys match the names you passed
     * to `@Arg(name, ...)` / `.arg(name, type)`. Types match the ArgType you
     * declared:
     *   * 'string' / 'word' / 'greedy' -> string
     *   * 'int' / 'long' / 'double'    -> number
     *   * 'bool'                       -> boolean
     *   * 'player'                     -> Player (or null if no match)
     *   * 'players'                    -> Player[]
     *   * 'entity'                     -> Entity
     *   * 'world'                      -> World
     *   * 'block_pos'                  -> { x: number; y: number; z: number }
     */
    interface CommandCtx {
        /** Whoever ran the command. Either a Player or the console. */
        sender: CommandSender & { name: string; isPlayer: boolean };
        /** Resolved Brigadier args, keyed by name. */
        args: Record<string, any>;
        /** The literal command name typed. */
        label: string;
    }

    /**
     * Decorate a class with `@Command("path", opts?)`. The class body
     * uses `@Arg(...)` to declare typed arguments and `@Run` to mark
     * the executor method. The class must have a zero-arg constructor.
     *
     * Path syntax: space-separated literals identify a leaf in the
     * Brigadier tree. Each leaf is its own class. Args are matched by
     * NAME across siblings -- shared args at the same level merge into
     * a single Brigadier arg slot, child-specific args chain after the
     * leaf literal.
     *
     *   // Flat (legacy): one class, one Brigadier node
     *   @Command("give", { permission: "rune.give" })
     *   export class GiveCommand {
     *     @Arg("player", "who to give to", { type: "player" })
     *     player!: Player;
     *     @Arg("count", { type: "int", min: 1, max: 64 })
     *     count!: number;
     *     @Run
     *     run(ctx: CommandCtx) { ... }
     *   }
     *
     *   // Tree: one class per leaf, decorator path picks the level
     *   @Command("pex", { description: "permissions manager" })
     *   export class PexRoot { @Run run(ctx) { showHelp(ctx); } }
     *
     *   @Command("pex reload")
     *   export class PexReload { @Run run(ctx) { reload(ctx); } }
     *
     *   @Command("pex user")
     *   export class PexUser {
     *     @Arg("player", { type: "player" }) player!: Player;
     *     @Run run(ctx) { showUser(this.player); }
     *   }
     *
     *   @Command("pex user add")
     *   export class PexUserAdd {
     *     @Arg("player", { type: "player" }) player!: Player;
     *     @Arg("perm", { type: "string" }) perm!: string;
     *     @Run run(ctx) { addPerm(this.player, this.perm); }
     *   }
     *
     * In the tree example, /pex user <player> shows the user, and
     * /pex user <player> add <perm> grants -- Brigadier sees <player>
     * exactly once (shared between PexUser and PexUserAdd by arg name).
     * `add` is a literal child of <player>; if you instead want
     * /pex user add <player>, swap the path to "pex user add" with
     * NO @Arg("player") -- the <player> arg becomes part of the add
     * leaf's own chain.
     */
    function Command(path: string, opts?: CommandOptions): (target: any, context?: any) => any;

    /**
     * Declare a typed positional argument. Decorates a class field; the
     * field's value is hydrated from Brigadier before @Run executes.
     */
    function Arg(name: string, description?: string, opts?: ArgOptions): (value: any, context: any) => void;
    function Arg(name: string, opts?: ArgOptions): (value: any, context: any) => void;

    /**
     * Mark a class method as the command's executor. Receives the
     * Brigadier-resolved CommandCtx.
     */
    function Run(method: any, context: any): void;

    /**
     * Decorate a class with `@Listener` to auto-register every
     * `@EventHandler`-decorated method as a Bukkit event handler. The
     * class must have a zero-arg constructor; one live instance owns
     * the registered handlers.
     *
     *   @Listener
     *   export class JoinGreeter {
     *     @EventHandler("PlayerJoinEvent")
     *     onJoin(e) {
     *       e.player.sendMessage("welcome");
     *     }
     *
     *     @EventHandler("AsyncChatEvent")
     *     onChat(e) { console.info(`<${e.player.name}> ${e.message.text}`); }
     *   }
     */
    function Listener(target: any, context?: any): any;

    /**
     * Mark a method as a handler for a Bukkit event. Preferred form uses
     * the typed `Events.X` enum value:
     *
     *   @EventHandler(Events.PlayerJoinEvent)
     *   onJoin(e: PlayerJoinEvent) { ... }   // explicit annotation
     *
     * String form is kept for compatibility (events not in RuneEventMap):
     *
     *   @EventHandler("MyCustomPluginEvent")
     *   onCustom(e: any) { ... }
     *
     * Note: TypeScript Stage-3 decorators do NOT propagate parameter
     * types to the method body, so the `e` parameter still needs an
     * explicit annotation. The decorator's signature validates that the
     * annotation matches the declared event.
     */
    function EventHandler<E>(
        eventKey: EventKey<E>,
    ): <This>(
        method: (this: This, e: E) => void | Promise<void>,
        context: ClassMethodDecoratorContext<
            This,
            (this: This, e: E) => void | Promise<void>
        >,
    ) => void;
    function EventHandler<K extends keyof RuneEventMap>(
        eventName: K,
    ): <This>(
        method: (this: This, e: RuneEventMap[K]) => void | Promise<void>,
        context: ClassMethodDecoratorContext<
            This,
            (this: This, e: RuneEventMap[K]) => void | Promise<void>
        >,
    ) => void;
}
