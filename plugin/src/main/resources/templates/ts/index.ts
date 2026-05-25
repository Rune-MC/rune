// __SCRIPT_NAME__ -- a Rune folder script.
//
// Side-effect-import any sibling files here. Each @Command / @Listener
// decorator registers itself when the module loads.

// import "./commands/example.ts";

rune.on(Events.PlayerJoinEvent, (e) => {
  e.player.sendMessage("hello from __SCRIPT_NAME__");
});
