import { chatPermissions, defaultFormats, enabled, preview, saveFormat, scopes, setEnabled, templateFor } from "../chat-format.ts";

const view = { permission: chatPermissions.view };
const edit = { permission: chatPermissions.edit };
const scopeArg = { type: "word", suggest: scopes } as const;
const templates = (_partial: string, { args }: CommandSuggestionContext) => {
  const scope = String(args.scope ?? "global");
  return [
    templateFor(scope), defaultFormats.global, defaultFormats.channels,
    "<prefix><username><suffix> <dark_gray>»</dark_gray> <message>",
    "<gray>[<group>]</gray> <username><gray>: </gray><message>",
  ];
};
const templateArg = { type: "greedy", suggest: templates } as const;

@Command("permissions chat", { description: "Configure global and channel chat formats" })
export class ChatHelp {
  @Run run({ sender }: CommandCtx) {
    if (!sender.hasPermission(chatPermissions.view)) return;
    sender.sendMessage("Chat formatting: " + (enabled() ? "enabled" : "disabled"));
    sender.sendMessage("Scopes: " + scopes().join(", "));
    sender.sendMessage("/permissions chat show, preview, set, reset, or toggle");
  }
}

@Command("permissions chat show", view)
export class ShowChatFormat {
  @Arg("scope", { ...scopeArg, optional: true }) scope?: string;
  @Run run({ sender }: CommandCtx) {
    const scope = this.scope?.toLowerCase() ?? "global";
    if (!scopes().includes(scope)) { sender.sendMessage("Choose a known chat scope."); return; }
    sender.sendMessage(`${scope}: ${templateFor(scope)}`);
  }
}

@Command("permissions chat preview", view)
export class PreviewChatFormat {
  @Arg("scope", { ...scopeArg, optional: true }) scope?: string;
  @Arg("format", { ...templateArg, optional: true }) format?: string;
  @Run run({ sender }: CommandCtx) {
    const scope = this.scope?.toLowerCase() ?? "global";
    if (!scopes().includes(scope)) { sender.sendMessage("Choose a known chat scope."); return; }
    try {
      rune.adventure.send(sender, preview(scope, this.format ?? templateFor(scope),
        sender.isPlayer ? sender as unknown as Player : undefined));
    } catch (error) {
      sender.sendMessage(error instanceof Error ? error.message : "Invalid chat format.");
    }
  }
}

@Command("permissions chat set", edit)
export class SetChatFormat {
  @Arg("scope", scopeArg) scope!: string;
  @Arg("format", templateArg) format!: string;
  @Run run({ sender }: CommandCtx) {
    const scope = this.scope.toLowerCase();
    saveFormat(sender, scope, this.format, () => sender.sendMessage("Saved format for " + scope + "."),
      (error) => sender.sendMessage(error));
  }
}

@Command("permissions chat reset", edit)
export class ResetChatFormat {
  @Arg("scope", { ...scopeArg, optional: true }) scope?: string;
  @Run run({ sender }: CommandCtx) {
    const scope = this.scope?.toLowerCase() ?? "global";
    saveFormat(sender, scope, undefined, () => sender.sendMessage("Reset format for " + scope + "."),
      (error) => sender.sendMessage(error));
  }
}

@Command("permissions chat toggle", edit)
export class ToggleChatFormat {
  @Arg("enabled", { type: "bool" }) value!: boolean;
  @Run run({ sender }: CommandCtx) {
    setEnabled(sender, this.value, () => sender.sendMessage("Chat formatting " + (this.value ? "enabled." : "disabled.")),
      (error) => sender.sendMessage(error));
  }
}
