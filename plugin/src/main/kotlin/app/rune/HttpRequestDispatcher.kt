package app.rune

/**
 * Single-method interface that `rune.serve` implements via `rune.implement`.
 *
 * Each HTTP request dispatched by [HttpServerRegistry.DispatchHandler]
 * arrives here as separate args (instead of a single CBOR blob) so the
 * cross-bridge marshaller decodes everything into native JS values:
 *   * `headers` arrives as a plain JS object,
 *   * `body` as a `Uint8Array`,
 *   * other primitives as themselves.
 *
 * The JS side schedules the user's async handler and (separately) calls
 * back via [HttpServerRegistry.respond] when the handler resolves --
 * this method itself is fire-and-forget.
 */
fun interface HttpRequestDispatcher {
    fun dispatch(
        requestId: Long,
        method: String,
        path: String,
        query: String,
        headers: Map<String, String>,
        body: ByteArray,
        remote: String,
    )
}
