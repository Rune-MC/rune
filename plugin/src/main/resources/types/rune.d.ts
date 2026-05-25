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
// ---------------------------------------------------------------------------

/** Marker present on every Bukkit-backed object. Internal. */
interface RuneRef {
    readonly __ref: number;
    readonly __class: string;
}

interface Player extends RuneRef {
    readonly name: string;
    readonly uuid: string;

    // Mutations -- void
    sendMessage(message: string): void;
    teleport(location: Location): void;
    setHealth(health: number): void;
    setFoodLevel(level: number): void;
    setGameMode(mode: string): void;
    kick(message?: string): void;
    chat(message: string): void;
    setOp(op: boolean): void;
    setFlying(flying: boolean): void;
    setAllowFlight(allow: boolean): void;
    giveExp(exp: number): void;
    setLevel(level: number): void;
    performCommand(command: string): void;
    setWalkSpeed(speed: number): void;

    // Reads
    getHealth(): number;
    getFoodLevel(): number;
    getLevel(): number;
    getGameMode(): string;
    isOp(): boolean;
    isOnline(): boolean;
    isFlying(): boolean;
    getAllowFlight(): boolean;
    getLocation(): Location;
    getWorld(): World;
    getDisplayName(): string;
    hasPermission(permission: string): boolean;

    [method: string]: any;
}

interface Entity extends RuneRef {
    readonly kind: string;
    readonly uuid: string;
    readonly name: string;

    teleport(location: Location): void;
    remove(): void;
    setCustomName(name: string): void;
    setCustomNameVisible(visible: boolean): void;
    setVelocity(velocity: unknown): void;
    getLocation(): Location;
    getWorld(): World;
    isDead(): boolean;
    isOnGround(): boolean;

    [method: string]: any;
}

interface Block extends RuneRef {
    readonly material: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly world: string;

    setType(material: Material | string): void;
    breakNaturally(): boolean;
    getType(): Material;
    getLocation(): Location;
    getWorld(): World;
    getRelative(face: string): Block;
    isEmpty(): boolean;
    isLiquid(): boolean;
    getLightLevel(): number;
    getPersistentDataContainer(): PersistentDataContainer;

    [method: string]: any;
}

interface Location extends RuneRef {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
    readonly pitch: number;
    readonly world: string;

    getBlock(): Block;
    distance(other: Location): number;
    add(x: number, y: number, z: number): Location;
    [method: string]: any;
}

interface World extends RuneRef {
    readonly name: string;
    readonly uuid: string;

    setTime(time: number): void;
    setStorm(hasStorm: boolean): void;
    strikeLightning(location: Location): void;
    getBlockAt(x: number, y: number, z: number): Block;
    getTime(): number;
    getPlayers(): Player[];
    getEntities(): Entity[];
    spawnEntity(location: Location, type: string): Entity;

    [method: string]: any;
}

interface ItemStack extends RuneRef {
    readonly material: string;
    readonly amount: number;

    setAmount(amount: number): void;
    getType(): Material;
    setType(material: Material | string): void;
    getAmount(): number;

    [method: string]: any;
}

interface PersistentDataContainer extends RuneRef {
    set(key: unknown, type: unknown, value: unknown): void;
    get(key: unknown, type: unknown): unknown;
    has(key: unknown, type: unknown): boolean;
    remove(key: unknown): void;
    getKeys(): unknown[];

    [method: string]: any;
}

// Material / EntityType / Particle / Sound are enum singletons. Each value
// is itself a ref you can call methods on.
interface Material extends RuneRef { [method: string]: any; }
interface EntityTypeRef extends RuneRef { [method: string]: any; }
interface ParticleRef extends RuneRef { [method: string]: any; }
interface SoundRef extends RuneRef { [method: string]: any; }

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
         * Static tab-completion suggestions. Pass a string[] or a function
         * that returns one -- the function is called ONCE at registration
         * time (snapshot). Truly dynamic per-keystroke suggesters are a
         * planned follow-up.
         */
        suggest?: string[] | (() => string[]);
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

    /** Top-level fields for the object form of `rune.command({...})`. */
    interface CommandSpec extends CommandOptions {
        name: string;
        args?: Array<{ name: string; type: ArgType } & Omit<ArgOptions, 'type'>>;
        run: (ctx: CommandCtx) => void | Promise<void>;
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
     * Decorate a class with `@Command("name", opts?)`. The class body uses
     * `@Arg(...)` to declare typed arguments and `@Run` to mark the
     * executor method. The class must have a zero-arg constructor.
     *
     *   @Command("give", { permission: "rune.give" })
     *   export class GiveCommand {
     *     @Arg("player", "who to give to", { type: "player" })
     *     player!: Player;
     *
     *     @Arg("count", { type: "int", min: 1, max: 64 })
     *     count!: number;
     *
     *     @Run
     *     run(ctx: CommandCtx) {
     *       this.player.getInventory().addItem(
     *         new bukkit.inventory.ItemStack(bukkit.Material.DIAMOND, this.count)
     *       );
     *     }
     *   }
     */
    function Command(name: string, opts?: CommandOptions): (target: any, context?: any) => any;

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
