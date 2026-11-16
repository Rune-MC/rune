package app.rune

import io.papermc.paper.chat.ChatRenderer
import io.papermc.paper.event.player.AsyncChatEvent
import net.kyori.adventure.audience.Audience
import net.kyori.adventure.bossbar.BossBar
import net.kyori.adventure.inventory.Book
import net.kyori.adventure.key.Key
import net.kyori.adventure.sound.Sound
import net.kyori.adventure.sound.SoundStop
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.JoinConfiguration
import net.kyori.adventure.text.event.ClickEvent
import net.kyori.adventure.text.event.HoverEvent
import net.kyori.adventure.text.format.NamedTextColor
import net.kyori.adventure.text.format.TextColor
import net.kyori.adventure.text.minimessage.MiniMessage
import net.kyori.adventure.text.minimessage.tag.resolver.Placeholder
import net.kyori.adventure.text.minimessage.tag.resolver.TagResolver
import net.kyori.adventure.text.serializer.gson.GsonComponentSerializer
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer
import net.kyori.adventure.title.Title
import org.bukkit.Bukkit
import org.bukkit.entity.Player
import java.time.Duration
import java.util.IdentityHashMap
import java.util.Locale
import java.util.UUID

/** Stable signatures for the Adventure operations that otherwise involve overloads or varargs. */
object AdventurePrimitives {
    private val miniMessage = MiniMessage.miniMessage()
    private val visibleBars = IdentityHashMap<BossBar, MutableSet<Audience>>()

    @JvmStatic
    fun player(nameOrId: String): Player? {
        val id = runCatching { UUID.fromString(nameOrId) }.getOrNull()
        return if (id != null) Bukkit.getPlayer(id) else Bukkit.getPlayerExact(nameOrId)
    }

    @JvmStatic
    fun text(value: String, color: String?): Component {
        if (color == null) return Component.text(value)
        val resolved = if (color.startsWith("#")) TextColor.fromHexString(color)
            else NamedTextColor.NAMES.value(color.lowercase(Locale.ROOT))
        return Component.text(value, requireNotNull(resolved) { "Unknown text color: $color" })
    }

    @JvmStatic
    fun literalTag(name: String, content: String): TagResolver = Placeholder.unparsed(name, content)

    @JvmStatic
    fun componentTag(name: String, content: Component): TagResolver = Placeholder.component(name, content)

    @JvmStatic
    fun deserialize(template: String, tags: List<TagResolver>): Component =
        miniMessage.deserialize(template, TagResolver.resolver(tags))

    @JvmStatic
    fun formatChat(event: AsyncChatEvent, template: String, tags: List<TagResolver>) {
        val placeholders = TagResolver.resolver(tags)
        event.renderer(ChatRenderer.viewerUnaware { _, displayName, message ->
            miniMessage.deserialize(template, placeholders,
                Placeholder.component("display_name", displayName),
                Placeholder.component("message", message))
        })
    }

    @JvmStatic
    fun serialize(component: Component, format: String): String = when (format) {
        "plain" -> PlainTextComponentSerializer.plainText().serialize(component)
        "minimessage" -> miniMessage.serialize(component)
        "legacy" -> LegacyComponentSerializer.legacySection().serialize(component)
        "json" -> GsonComponentSerializer.gson().serialize(component)
        else -> error("Unknown component format: $format")
    }

    @JvmStatic
    fun join(parts: List<Component>, separator: Component): Component =
        Component.join(JoinConfiguration.separator(separator), parts)

    @JvmStatic
    fun translate(key: String, arguments: List<Component>): Component =
        Component.translatable(key).arguments(arguments)

    @JvmStatic
    fun hover(component: Component, content: Component): Component = component.hoverEvent(HoverEvent.showText(content))

    @JvmStatic
    fun click(component: Component, action: String, value: String): Component =
        component.clickEvent(ClickEvent.clickEvent(ClickEvent.Action.valueOf(action.uppercase(Locale.ROOT)), value))

    @JvmStatic
    fun broadcast(component: Component): Int = Bukkit.getServer().broadcast(component)

    @JvmStatic
    fun title(title: Component, subtitle: Component, fadeIn: Long, stay: Long, fadeOut: Long): Title {
        val times = Title.Times.times(Duration.ofMillis(fadeIn), Duration.ofMillis(stay), Duration.ofMillis(fadeOut))
        return Title.title(title, subtitle, times)
    }

    @JvmStatic
    fun bossBar(name: Component, progress: Float, color: String, overlay: String): BossBar =
        BossBar.bossBar(
            name, progress, BossBar.Color.valueOf(color.uppercase(Locale.ROOT)),
            BossBar.Overlay.valueOf(overlay.uppercase(Locale.ROOT)),
        )

    @JvmStatic
    fun showBossBar(audience: Audience, bar: BossBar) {
        audience.showBossBar(bar)
        visibleBars.getOrPut(bar) { linkedSetOf() }.add(audience)
    }

    @JvmStatic
    fun hideBossBar(audience: Audience, bar: BossBar) {
        audience.hideBossBar(bar)
        val audiences = visibleBars[bar] ?: return
        audiences.remove(audience)
        if (audiences.isEmpty()) visibleBars.remove(bar)
    }

    fun clearBossBars() {
        for ((bar, audiences) in visibleBars) {
            for (audience in audiences) runCatching { audience.hideBossBar(bar) }
        }
        visibleBars.clear()
    }

    @JvmStatic
    fun sound(key: String, source: String, volume: Float, pitch: Float): Sound =
        Sound.sound(Key.key(key), Sound.Source.valueOf(source.uppercase(Locale.ROOT)), volume, pitch)

    @JvmStatic
    fun soundStop(key: String?, source: String?): SoundStop {
        val category = source?.let { Sound.Source.valueOf(it.uppercase(Locale.ROOT)) }
        return when {
            key != null && category != null -> SoundStop.namedOnSource(Key.key(key), category)
            key != null -> SoundStop.named(Key.key(key))
            category != null -> SoundStop.source(category)
            else -> SoundStop.all()
        }
    }

    @JvmStatic
    fun book(title: Component, author: Component, pages: List<Component>): Book = Book.book(title, author, pages)

    @JvmStatic
    fun audience(viewers: List<Audience>): Audience = Audience.audience(viewers)
}
