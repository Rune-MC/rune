package app.rune

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpHandler
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/**
 * Per-port HTTP server registry backed by `com.sun.net.httpserver.HttpServer`.
 *
 * Each `rune.serve({port}, init)` call from JS lands here through
 * `start(port, host, threads, dispatchProxyId)`. The Java side owns the
 * listening socket + thread pool; per-request handling routes back into
 * JS via [JsProxyDispatcher.invokeByProxyId] using the supplied proxy id.
 *
 * # Async handler protocol
 *
 * Web handlers are async (Mongoose / fetch / `runOnMain` round-trips), but
 * the proxy bridge is synchronous from Java's perspective. So we use a
 * two-step protocol:
 *
 *   1. Java executor thread receives a request, buffers the body, encodes
 *      the request as CBOR, allocates a unique `requestId`, and parks on
 *      a CompletableFuture keyed by that id.
 *   2. Java calls JS `dispatcher.dispatch(cborRequest)` synchronously --
 *      the JS handler decodes the request, schedules the user's async
 *      handler, and returns immediately.
 *   3. When the user handler resolves, JS calls back via
 *      [HttpServerRegistry.respond] with the response bytes; that
 *      completes the future and the parked Java thread writes the
 *      response and closes the exchange.
 *
 * Default timeout is 30s; configurable per-server via the JS opts.
 */
object HttpServerRegistry {

    data class Response(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    private data class Entry(val server: HttpServer, val dispatchProxyId: Long, val timeoutMs: Long)

    private val byPort = ConcurrentHashMap<Int, Entry>()
    private val pending = ConcurrentHashMap<Long, CompletableFuture<Response>>()
    private val requestIdGen = AtomicLong(0)

    /**
     * Start (or replace) the HTTP server on [port]. Returns the bound
     * port so callers can confirm. Throws on bind failure.
     *
     * Replacing an existing server on the same port is atomic from the
     * client's POV: the old server stops accepting new connections,
     * outstanding requests drain, then the new server binds.
     */
    @JvmStatic
    fun start(port: Int, host: String, threads: Int, dispatchProxyId: String, timeoutMs: Long): Int {
        val proxyId = dispatchProxyId.toLong()
        stop(port)
        val server = HttpServer.create(InetSocketAddress(host, port), 0)
        val safeThreads = if (threads <= 0) 8 else threads
        server.executor = Executors.newFixedThreadPool(safeThreads) { r ->
            val t = Thread(r, "rune-http-$port-${Thread.currentThread().id}")
            t.isDaemon = true
            t
        }
        server.createContext("/", DispatchHandler(proxyId, timeoutMs))
        server.start()
        byPort[port] = Entry(server, proxyId, timeoutMs)
        return server.address.port
    }

    /** Stop the server on [port] if any. Returns true if one was running. */
    @JvmStatic
    fun stop(port: Int): Boolean {
        val entry = byPort.remove(port) ?: return false
        entry.server.stop(1)
        return true
    }

    /** Stop everything. Called from RunePlugin.onDisable. */
    @JvmStatic
    fun stopAll() {
        for ((port, _) in byPort.toMap()) stop(port)
        // Fail any outstanding requests so handler threads don't hang.
        for ((_, fut) in pending.toMap()) {
            fut.complete(Response(503, mapOf("Content-Type" to "text/plain; charset=utf-8"), "server stopped".toByteArray()))
        }
        pending.clear()
    }

    /**
     * JS callback path: the user handler has resolved. Wake the Java
     * thread parked on this request id and let it write the response.
     *
     * `headersJson` is a JSON object {name -> value(s)}; values can be a
     * string or a string[]. Going through JSON keeps the rune.callStatic
     * arg coercer happy (JS Object -> Java Map coercion was returning
     * "no matching respond(4 arg(s))" when typed as Map).
     */
    @JvmStatic
    fun respond(requestId: Long, status: Int, headersJson: String, body: ByteArray) {
        val headers = parseHeadersJson(headersJson)
        pending.remove(requestId)?.complete(Response(status, headers, body))
    }

    /**
     * Tiny ad-hoc JSON parser for `{"name": "value"}` or
     * `{"name": ["v1", "v2"]}` -- avoids pulling in a JSON dep for one
     * 1-deep object on the response side. Robust enough for HTTP headers
     * (no nested objects, no escapes beyond \", \\, \n, \r, \t).
     */
    private fun parseHeadersJson(src: String): Map<String, String> {
        if (src.isBlank() || src == "{}") return emptyMap()
        val out = LinkedHashMap<String, String>()
        var i = 0
        val n = src.length
        fun skipWs() { while (i < n && src[i].isWhitespace()) i++ }
        fun parseString(): String {
            if (src[i] != '"') throw RuntimeException("expected string at $i in $src")
            i++
            val sb = StringBuilder()
            while (i < n && src[i] != '"') {
                if (src[i] == '\\' && i + 1 < n) {
                    when (src[i + 1]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('')
                        else -> sb.append(src[i + 1])
                    }
                    i += 2
                } else {
                    sb.append(src[i]); i++
                }
            }
            i++ // closing quote
            return sb.toString()
        }
        skipWs()
        if (i >= n || src[i] != '{') return emptyMap()
        i++
        while (true) {
            skipWs()
            if (i >= n) break
            if (src[i] == '}') { i++; break }
            if (src[i] == ',') { i++; continue }
            val key = parseString()
            skipWs()
            if (i >= n || src[i] != ':') throw RuntimeException("expected ':' at $i")
            i++; skipWs()
            if (i < n && src[i] == '[') {
                // Array of values -- join with ", " per RFC 7230.
                i++
                val parts = mutableListOf<String>()
                while (true) {
                    skipWs()
                    if (i >= n) break
                    if (src[i] == ']') { i++; break }
                    if (src[i] == ',') { i++; continue }
                    parts += parseString()
                }
                out[key] = parts.joinToString(", ")
            } else {
                out[key] = parseString()
            }
        }
        return out
    }

    /** Number of bound ports. Used by /rune status. */
    @JvmStatic
    fun count(): Int = byPort.size

    private fun nextRequestId(): Long = requestIdGen.incrementAndGet()

    private class DispatchHandler(
        private val dispatchProxyId: Long,
        private val timeoutMs: Long,
    ) : HttpHandler {
        override fun handle(exchange: HttpExchange) {
            val requestId = nextRequestId()
            val future = CompletableFuture<Response>()
            pending[requestId] = future
            try {
                val method = exchange.requestMethod
                val uri = exchange.requestURI
                val path = uri.rawPath ?: "/"
                val query = uri.rawQuery ?: ""
                val headers = LinkedHashMap<String, String>()
                for ((k, v) in exchange.requestHeaders) {
                    headers[k] = v.joinToString(", ")
                }
                val body = readAll(exchange.requestBody)
                val remote = exchange.remoteAddress?.toString() ?: ""

                JsProxyDispatcher.invokeByProxyId(
                    dispatchProxyId,
                    "dispatch",
                    requestId, method, path, query, headers, body, remote,
                )
                val response = try {
                    future.get(timeoutMs, TimeUnit.MILLISECONDS)
                } catch (_: TimeoutException) {
                    writePlain(exchange, 504, "Gateway Timeout (handler did not respond in ${timeoutMs}ms)")
                    return
                }
                writeResponse(exchange, response)
            } catch (t: Throwable) {
                System.err.println("[rune.serve] dispatch failed: ${t.javaClass.simpleName}: ${t.message}")
                t.printStackTrace(System.err)
                try { writePlain(exchange, 500, "Internal Server Error") } catch (_: Throwable) {}
            } finally {
                pending.remove(requestId)
                try { exchange.close() } catch (_: Throwable) {}
            }
        }

        private fun readAll(stream: InputStream): ByteArray {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) {
                val n = stream.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }

        private fun writeResponse(exchange: HttpExchange, response: Response) {
            for ((k, v) in response.headers) {
                // HttpExchange owns Content-Length; suppressing the script's
                // attempt to set it prevents a body-length mismatch.
                if (!k.equals("Content-Length", ignoreCase = true)) {
                    exchange.responseHeaders.add(k, v)
                }
            }
            val length = if (response.body.isEmpty()) -1L else response.body.size.toLong()
            exchange.sendResponseHeaders(response.status, length)
            if (response.body.isNotEmpty()) {
                exchange.responseBody.use { it.write(response.body) }
            }
        }

        private fun writePlain(exchange: HttpExchange, status: Int, message: String) {
            val bytes = message.toByteArray(Charsets.UTF_8)
            exchange.responseHeaders["Content-Type"] = listOf("text/plain; charset=utf-8")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }
}
