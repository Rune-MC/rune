# @rune/paper-ui

Build Paper inventory screens, searchable lists, draft forms, and private
chat prompts on top of `rune.gui`.

## Install and use

```sh
rune add @rune/paper-ui
```

Restart Paper to link the library, then import it from your TypeScript Rune.

```typescript
import { createMenus, createWidgets, tell } from "@rune/paper-ui";

const ui = createMenus({
  title: "Tools",
  canView: (player) => player.hasPermission("rune.tools"),
});

export function openTools(player: Player) {
  const open = () => openTools(player);
  const menu = new ui.Menu(player, "Settings");
  menu.button(13, "PAPER", "Set a label", [], () =>
    ui.prompt(player, "Label", "Enter your new label.", open, (text) => {
      tell(player, "New label: " + text);
      open();
    }),
  );
  menu.open();
}

const { list, choose, form, confirm } = createWidgets(ui);
```

`Menu` builds a six-row inventory with Back and Close controls.
`list` supplies search and pagination, `choose` supports pickers,
`form` collects and validates drafts, and `confirm` gates a deliberate action.
`createMenus` accepts a viewing predicate. Check mutation permissions in the
action handler as well.

## Built-in Rune GUI support

Rune 0.5.1 adds native drag and creative-click protection to `rune.gui`.
The library uses the built-in chat prompt on 0.5.1 and provides the same
workflow on Rune 0.5.0.

```typescript
export function askForReason(player: Player) {
  rune.gui.prompt(player, {
    title: "Enter a reason",
    hint: "Reply in chat, or type !cancel.",
    timeoutMs: 60_000,
    onReply: (text, player) => player.sendMessage("Reason recorded: " + text),
    onCancel: (player) => player.sendMessage("Canceled."),
    onTimeout: (player) => player.sendMessage("Prompt expired."),
  });
}
```

You can also call `gui.prompt(player, spec)` on an inventory. Opening
another Rune GUI cancels the active prompt. Use `rune.gui.hasPrompt(player)`
to inspect it and `rune.gui.cancelPrompt(player)` to clear it. Chat resumes
after the reply, cancellation, timeout, or disconnect.
