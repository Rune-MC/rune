package app.rune

import java.lang.foreign.Arena
import java.lang.foreign.FunctionDescriptor
import java.lang.foreign.Linker
import java.lang.foreign.MemorySegment
import java.lang.foreign.SymbolLookup
import java.lang.foreign.ValueLayout
import java.lang.invoke.MethodHandle
import java.lang.invoke.MethodHandles
import java.lang.invoke.MethodType
import java.nio.file.Path

/**
 * Panama FFM bindings for `librune_loader`. Mirrors the C ABI documented in
 * `DESIGN_SPEC.md` §6.4 exactly.
 *
 * Lifetime: one instance per plugin enable. Closing it calls `rune_shutdown`
 * and releases the library lookup arena.
 *
 * Threading: all methods must be called on the Paper main thread (the loader
 * is single-threaded per `DESIGN_SPEC.md` §7).
 */
class NativeLoader(libraryPath: Path, scriptsDir: Path) : AutoCloseable {

    private val libArena: Arena = Arena.ofShared()
    private val lookup: SymbolLookup = SymbolLookup.libraryLookup(libraryPath, libArena)
    private val linker: Linker = Linker.nativeLinker()

    private val runeInit: MethodHandle = downcall(
        "rune_init",
        FunctionDescriptor.of(ValueLayout.ADDRESS, ValueLayout.ADDRESS)
    )
    private val runeLoadScript: MethodHandle = downcall(
        "rune_load_script",
        FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.ADDRESS)
    )
    private val runeDispatchEvent: MethodHandle = downcall(
        "rune_dispatch_event",
        FunctionDescriptor.of(
            ValueLayout.JAVA_INT,
            ValueLayout.ADDRESS,    // loader
            ValueLayout.ADDRESS,    // name
            ValueLayout.ADDRESS,    // payload
            ValueLayout.JAVA_LONG,  // len (size_t -> i64 on 64-bit)
        )
    )
    private val runeDrainCommands: MethodHandle = downcall(
        "rune_drain_commands",
        FunctionDescriptor.of(
            ValueLayout.JAVA_LONG,  // bytes written (or -1 / -2)
            ValueLayout.ADDRESS,    // loader
            ValueLayout.ADDRESS,    // out
            ValueLayout.JAVA_LONG,  // cap
        )
    )
    private val runeTick: MethodHandle = downcall(
        "rune_tick",
        FunctionDescriptor.ofVoid(ValueLayout.ADDRESS)
    )
    private val runeReload: MethodHandle = downcall(
        "rune_reload",
        FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS)
    )
    private val runeShutdown: MethodHandle = downcall(
        "rune_shutdown",
        FunctionDescriptor.ofVoid(ValueLayout.ADDRESS)
    )
    private val runeRegisterQueryCallback: MethodHandle = downcall(
        "rune_register_query_callback",
        FunctionDescriptor.ofVoid(ValueLayout.ADDRESS, ValueLayout.ADDRESS)
    )
    private val runeInvokeJsProxy: MethodHandle = downcall(
        "rune_invoke_js_proxy",
        FunctionDescriptor.of(
            ValueLayout.JAVA_LONG,    // bytes written (or negative on error)
            ValueLayout.ADDRESS,      // loader
            ValueLayout.JAVA_LONG,    // proxy_id (u64; Kotlin Long is fine)
            ValueLayout.ADDRESS,      // method_name (UTF-8, NUL-terminated)
            ValueLayout.ADDRESS,      // args (CBOR bytes)
            ValueLayout.JAVA_LONG,    // args_len
            ValueLayout.ADDRESS,      // out
            ValueLayout.JAVA_LONG,    // cap
        )
    )

    private val handle: MemorySegment = run {
        Arena.ofConfined().use { arena ->
            // Rust's `ModuleSpecifier::from_file_path` requires absolute paths,
            // and Paper hands `dataFolder` back as a relative path. Normalise
            // at the boundary so the rest of the code can stay path-agnostic.
            val absoluteDir = scriptsDir.toAbsolutePath().normalize().toString()
            val dirSeg = arena.allocateFrom(absoluteDir)
            runeInit.invoke(dirSeg) as MemorySegment
        }
    }.also {
        require(!it.equals(MemorySegment.NULL)) { "rune_init returned NULL" }
    }

    private fun downcall(name: String, desc: FunctionDescriptor): MethodHandle {
        val addr = lookup.find(name).orElseThrow {
            UnsatisfiedLinkError("symbol not found in librune_loader: $name")
        }
        return linker.downcallHandle(addr, desc)
    }

    fun loadScript(path: Path): Int = Arena.ofConfined().use { arena ->
        val absolute = path.toAbsolutePath().normalize().toString()
        val pathSeg = arena.allocateFrom(absolute)
        runeLoadScript.invoke(handle, pathSeg) as Int
    }

    fun dispatchEvent(eventName: String, payload: ByteArray): Int = Arena.ofConfined().use { arena ->
        val nameSeg = arena.allocateFrom(eventName)
        val payloadSeg: MemorySegment = if (payload.isEmpty()) {
            MemorySegment.NULL
        } else {
            val seg = arena.allocate(payload.size.toLong())
            MemorySegment.copy(payload, 0, seg, ValueLayout.JAVA_BYTE, 0, payload.size)
            seg
        }
        runeDispatchEvent.invoke(handle, nameSeg, payloadSeg, payload.size.toLong()) as Int
    }

    /**
     * Pull pending CBOR-encoded commands out of the loader. Returns null if
     * nothing is queued. Retries with a doubled buffer on -1 (too small)
     * since the loader parks the unsent payload (see `DESIGN_SPEC.md` §6.4).
     */
    fun drainCommands(): ByteArray? {
        var capacity = INITIAL_DRAIN_CAP
        while (true) {
            Arena.ofConfined().use { arena ->
                val out = arena.allocate(capacity)
                val n = runeDrainCommands.invoke(handle, out, capacity) as Long
                when {
                    n == 0L -> return null
                    n > 0L -> {
                        val bytes = ByteArray(n.toInt())
                        MemorySegment.copy(out, ValueLayout.JAVA_BYTE, 0, bytes, 0, n.toInt())
                        return bytes
                    }
                    n == -1L -> {
                        // Buffer too small; commands remain parked. Retry with a
                        // larger arena outside this `use` block.
                        capacity *= 2
                        require(capacity <= MAX_DRAIN_CAP) {
                            "drain buffer growth exceeded $MAX_DRAIN_CAP bytes"
                        }
                    }
                    else -> {
                        // -2 internal error; loader has already logged.
                        return null
                    }
                }
            }
        }
    }

    fun tick() {
        runeTick.invoke(handle)
    }

    /**
     * Install [handler] as the sync-upcall query handler. Builds a Panama
     * upcall stub pointing at the static [queryEntryPoint] dispatcher, then
     * passes the resulting function pointer to `rune_register_query_callback`.
     * The handler must remain alive for the lifetime of this loader.
     */
    fun installQueryHandler(handler: QueryHandler) {
        QUERY_HANDLER = handler
        val queryStub = linker.upcallStub(
            QUERY_ENTRY_HANDLE,
            QUERY_FN_DESCRIPTOR,
            libArena,
        )
        runeRegisterQueryCallback.invoke(handle, queryStub)
    }

    fun reload(): Int = runeReload.invoke(handle) as Int

    /**
     * Synchronously invoke a JS-installed proxy method (Java -> JS).
     *
     * Used by [JsProxyDispatcher] when a ByteBuddy-generated proxy
     * (e.g. a PAPI `PlaceholderExpansion` subclass) has one of its
     * methods called by Java. The dispatcher hands us `(proxy_id,
     * method, cbor_args)`; we forward through Panama into the Rust
     * loader, which routes to the backend that owns the proxy and
     * runs the JS handler inline against the V8 isolate (Locker'd
     * for cross-thread safety).
     *
     * Returns the CBOR-encoded JS return value, or empty bytes when
     * the call failed at the FFI level (logged + the caller falls
     * back to its method's return-type default).
     */
    fun invokeJsProxy(proxyId: Long, methodName: String, args: ByteArray): ByteArray {
        var capacity = INITIAL_PROXY_CAP
        while (true) {
            val result = Arena.ofConfined().use { arena ->
                val nameSeg = arena.allocateFrom(methodName)
                val argsSeg: MemorySegment = if (args.isEmpty()) {
                    MemorySegment.NULL
                } else {
                    val seg = arena.allocate(args.size.toLong())
                    MemorySegment.copy(args, 0, seg, ValueLayout.JAVA_BYTE, 0, args.size)
                    seg
                }
                val argsLen: Long = args.size.toLong()
                val out = arena.allocate(capacity)
                val n = runeInvokeJsProxy.invoke(
                    handle,
                    proxyId,
                    nameSeg,
                    argsSeg,
                    argsLen,
                    out,
                    capacity,
                ) as Long
                when {
                    n >= 0 -> {
                        val bytes = ByteArray(n.toInt())
                        if (n > 0) {
                            MemorySegment.copy(out, ValueLayout.JAVA_BYTE, 0, bytes, 0, n.toInt())
                        }
                        bytes  // success
                    }
                    n == -1L -> null  // sentinel: buffer too small, grow
                    else -> ByteArray(0)  // -2 internal error; caller defaults
                }
            }
            if (result != null) return result
            capacity *= 2
            require(capacity <= MAX_PROXY_CAP) {
                "proxy invocation result exceeded $MAX_PROXY_CAP bytes"
            }
        }
    }

    override fun close() {
        runeShutdown.invoke(handle)
        libArena.close()
    }

    companion object {
        private const val INITIAL_DRAIN_CAP = 4096L
        private const val MAX_DRAIN_CAP = 16L * 1024 * 1024
        private const val INITIAL_PROXY_CAP = 4096L
        private const val MAX_PROXY_CAP = 16L * 1024 * 1024

        /**
         * Sole live [QueryHandler]. The Panama upcall stub binds to the
         * static [queryEntryPoint] method; the entry point reads this field
         * to find the actual handler. We don't expect multiple plugin
         * instances in the same JVM, so a single static slot is sufficient.
         */
        @Volatile
        private var QUERY_HANDLER: QueryHandler? = null

        private val QUERY_FN_DESCRIPTOR: FunctionDescriptor = FunctionDescriptor.of(
            ValueLayout.JAVA_LONG, // bytes written, or negative on error
            ValueLayout.ADDRESS,   // query bytes
            ValueLayout.JAVA_LONG, // qlen
            ValueLayout.ADDRESS,   // out
            ValueLayout.JAVA_LONG, // cap
        )

        private val QUERY_ENTRY_HANDLE: MethodHandle = MethodHandles.lookup().findStatic(
            NativeLoader::class.java,
            "queryEntryPoint",
            MethodType.methodType(
                Long::class.javaPrimitiveType,
                MemorySegment::class.java,
                Long::class.javaPrimitiveType,
                MemorySegment::class.java,
                Long::class.javaPrimitiveType,
            ),
        )

        /**
         * Called by the Rust loader (via the upcall stub) whenever JS sends
         * a `HostQuery`. Copies the query bytes off native memory, dispatches
         * to [QUERY_HANDLER], and writes the response back.
         *
         * Returns: number of bytes written, `-1` if the caller's buffer was
         * too small (loader will retry with a larger one), `-2` on internal
         * error (no handler registered, etc.).
         */
        @JvmStatic
        fun queryEntryPoint(query: MemorySegment, qlen: Long, out: MemorySegment, cap: Long): Long {
            val handler = QUERY_HANDLER ?: return -2L
            val qlenInt = qlen.toInt()
            // Rebase the input pointer so we can read `qlen` bytes from it.
            val querySeg = query.reinterpret(qlen)
            val queryBytes = ByteArray(qlenInt)
            MemorySegment.copy(querySeg, ValueLayout.JAVA_BYTE, 0, queryBytes, 0, qlenInt)

            val response: ByteArray = try {
                handler.handle(queryBytes)
            } catch (e: Throwable) {
                // Shouldn't reach here -- handler catches internally -- but if
                // it does, surface as internal error.
                return -2L
            }
            if (response.size > cap) {
                return -1L
            }
            val outSeg = out.reinterpret(cap)
            MemorySegment.copy(response, 0, outSeg, ValueLayout.JAVA_BYTE, 0, response.size)
            return response.size.toLong()
        }
    }
}
