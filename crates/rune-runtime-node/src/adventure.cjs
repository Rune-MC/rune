
(() => {
  const rune = globalThis.rune;
  const bridge = (method, ...args) => rune.callStatic('app.rune.AdventurePrimitives', method, ...args);
  const text = (value = '', color) => bridge('text', String(value), color ?? null);
  const component = (value) => typeof value === 'string' || value == null ? text(value ?? '') : value;
  const messageTags = (values) => Object.entries(values).map(([key, value]) =>
      _looksLikeComponent(value)
        ? bridge('componentTag', key, value)
        : bridge('literalTag', key, String(value)));
  const miniMessage = (template, values = {}) => bridge('deserialize', String(template ?? ''), messageTags(values));
  const formatted = (value) => typeof value === 'string' || value == null ? miniMessage(value) : value;
  const viewers = (target) => Array.isArray(target) ? target : [target];
  const dispatch = (target, method, ...args) => {
    for (const audience of viewers(target)) audience[method](...args);
  };

  function title(target, name, subtitle, timings = {}) {
    const durations = [timings.fadeInMs ?? 500, timings.stayMs ?? 3000, timings.fadeOutMs ?? 500];
    if (durations.some((duration) => !Number.isSafeInteger(duration) || duration < 0)) {
      throw new RangeError('Title times must be non-negative whole milliseconds');
    }
    dispatch(target, 'showTitle', bridge('title', name, subtitle, ...durations));
  }

  const sound = (key, { source = 'master', volume = 1, pitch = 1 } = {}) => {
    if (!Number.isFinite(volume) || volume < 0 || !Number.isFinite(pitch) || pitch < 0 || pitch > 2) {
      throw new RangeError('Use a non-negative volume and a pitch from 0 to 2');
    }
    return bridge('sound', key, source, volume, pitch);
  };

  rune.adventure = Object.freeze({
    text,
    miniMessage,
    formatChat(event, template, values = {}) {
      for (const key of ['display_name', 'message']) {
        if (Object.hasOwn(values, key)) throw new TypeError('Paper supplies the <' + key + '> placeholder');
      }
      bridge('formatChat', event, String(template), messageTags(values));
    },
    format(template, ...values) {
      const replacements = Object.fromEntries(values.map((value, index) => ['rune_arg_' + index, value]));
      const source = template.reduce((result, part, index) =>
        index === 0 ? part : result + '<rune_arg_' + (index - 1) + '>' + part, '');
      return miniMessage(source, replacements);
    },
    serialize(value, format = 'plain') { return bridge('serialize', component(value), format); },
    join(parts, separator = '') { return bridge('join', parts.map(component), component(separator)); },
    translate(key, ...args) { return bridge('translate', key, args.map(component)); },
    hover(value, tooltip) { return bridge('hover', component(value), component(tooltip)); },
    click(value, action, argument) { return bridge('click', component(value), action, argument); },
    audience(...targets) { return bridge('audience', targets.flatMap(viewers)); },
    send(target, message) { dispatch(target, 'sendMessage', component(message)); },
    broadcast(message) { return bridge('broadcast', component(message)); },
    actionBar(target, message) { dispatch(target, 'sendActionBar', component(message)); },
    title(target, name, subtitle, timings) { title(target, component(name), component(subtitle), timings); },
    clearTitle(target) { dispatch(target, 'clearTitle'); },
    tabList(target, header, footer) {
      dispatch(target, 'sendPlayerListHeaderAndFooter', component(header), component(footer));
    },
    bossBar(name, { progress = 1, color = 'white', overlay = 'progress' } = {}) {
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
        throw new RangeError('Boss bar progress must be between 0 and 1');
      }
      return bridge('bossBar', component(name), progress, color, overlay);
    },
    showBossBar(target, bar) {
      for (const viewer of viewers(target)) bridge('showBossBar', viewer, bar);
    },
    hideBossBar(target, bar) {
      for (const viewer of viewers(target)) bridge('hideBossBar', viewer, bar);
    },
    sound,
    playSound(target, soundOrKey, options) {
      dispatch(target, 'playSound', typeof soundOrKey === 'string' ? sound(soundOrKey, options) : soundOrKey);
    },
    stopSound(target, key, source) {
      dispatch(target, 'stopSound', bridge('soundStop', key ?? null, source ?? null));
    },
    book(titleText, author, pages) {
      return bridge('book', component(titleText), component(author), pages.map(component));
    },
    openBook(target, book) { dispatch(target, 'openBook', book); },
    Component: kyori.adventure.text.Component,
    TextColor: kyori.adventure.text.format.TextColor,
    NamedTextColor: kyori.adventure.text.format.NamedTextColor,
    TextDecoration: kyori.adventure.text.format.TextDecoration,
    Style: kyori.adventure.text.format.Style,
    ClickEvent: kyori.adventure.text.event.ClickEvent,
    HoverEvent: kyori.adventure.text.event.HoverEvent,
    Key: kyori.adventure.key.Key,
    MiniMessage: kyori.adventure.text.minimessage.MiniMessage,
    TagResolver: kyori.adventure.text.minimessage.tag.resolver.TagResolver,
    Placeholder: kyori.adventure.text.minimessage.tag.resolver.Placeholder,
    Audience: kyori.adventure.audience.Audience,
    Title: kyori.adventure.title.Title,
    BossBar: kyori.adventure.bossbar.BossBar,
    Sound: kyori.adventure.sound.Sound,
    SoundStop: kyori.adventure.sound.SoundStop,
    Book: kyori.adventure.inventory.Book,
  });

  // Existing helpers retain their MiniMessage string semantics.
  rune.mm = miniMessage;
  rune.msg = (target, message) => dispatch(target, 'sendMessage', formatted(message));
  rune.actionBar = (target, message) => dispatch(target, 'sendActionBar', formatted(message));
  rune.title = (target, name, subtitle, timings) => title(target, formatted(name), formatted(subtitle), timings);

  rune.player = (nameOrUuid) => bridge('player', nameOrUuid);
  rune.players = (predicate) => {
    const online = rune.bukkit.getOnlinePlayers();
    return predicate ? online.filter(predicate) : online;
  };
  rune.world = (name) => rune.bukkit.getWorld(name);
  rune.vector = (x, y, z) => new bukkit.util.Vector(x, y, z);
  rune.blockAt = (world, x, y, z) => world.getBlockAt(Math.floor(x), Math.floor(y), Math.floor(z));
  rune.types = Object.freeze({
    Location: bukkit.Location,
    Vector: bukkit.util.Vector,
    NamespacedKey: bukkit.NamespacedKey,
    ItemStack: bukkit.inventory.ItemStack,
    Material: bukkit.Material,
    EntityType: bukkit.entity.EntityType,
    GameMode: bukkit.GameMode,
    PotionEffect: bukkit.potion.PotionEffect,
    PotionEffectType: bukkit.potion.PotionEffectType,
  });
})();
