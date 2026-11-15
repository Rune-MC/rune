import { tell } from "@rune/paper-ui";
import { describeCase } from "../cases.ts";
import { remaining } from "../duration.ts";
import { active, fail, isTimed } from "../model.ts";
import { backend, can, mod, online, person, requirePermission } from "../platform.ts";
import { dashboard } from "../gui/index.ts";
import { inGame, pageArg, playerNames, positiveId, printPage, run } from "./common.ts";

const help = [
  "/mod gui • Open the moderation dashboard",
  "/mod ban|mute|freeze <player> <duration> <reason>",
  "/mod ipban <address> <duration> <reason>",
  "/mod kick|warn|note <player> <reason>",
  "/mod unban|unmute|unfreeze <player> <reason>",
  "/mod unipban <address> <reason> • /mod revoke <case> <reason>",
  "/mod case <id> • /mod cases [page] • /mod active [page]",
  "/mod history <player> [page] • /mod inspect|tp <player>",
  "/report <player> <reason> • /mod reports [page]",
  "/mod report <id> • /mod report claim|reopen <id>",
  "/mod report resolve <id> <resolution> • /mod reports closed [page]",
  "/channel [join|leave|focus] • /channel send <channel> <message>",
  "/staffchat <message> • /mod chat slow <seconds>",
  "/mod chat lock <duration> <reason> • /mod chat unlock",
  "/mod chat clear <reason> • /mod chat channel set|delete",
  "/mod lockdown <duration> <reason> • /mod unlock • /mod audit [page]",
];

@Command("mod", { ...mod, description: "Moderate players and manage chat", aliases: ["moderation"] })
export class ModRoot {
  @Run run({ sender }: CommandCtx) { printPage(sender, "Moderation commands • /mod help [page]", help); }
}

@Command("mod help", mod)
export class ModHelp {
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) { printPage(sender, "Moderation commands", help, this.page); }
}

@Command("mod gui", mod)
export class ModGui {
  @Run run({ sender }: CommandCtx) { run(sender, () => dashboard(inGame(sender))); }
}

@Command("mod cases", mod)
export class Cases {
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) {
    printPage(sender, "Cases", [...backend.value().cases].reverse().map((row) => describeCase(sender, row)), this.page);
  }
}

@Command("mod active", mod)
export class ActiveCases {
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) {
    printPage(sender, "Active punishments", [...backend.value().cases].reverse().filter((row) => active(row))
      .map((row) => describeCase(sender, row)), this.page);
  }
}

@Command("mod case", mod)
export class OneCase {
  @Arg("case", positiveId) id!: number;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const item = backend.value().cases.find((row) => row.id === this.id) ?? fail("Case not found.");
      tell(sender, describeCase(sender, item));
      tell(sender, `By ${item.actor.name} • ${new Date(item.at).toISOString()}`);
      if (isTimed(item.kind)) tell(sender, `Duration: ${remaining(item.expiresAt)}`);
      if (item.revoked) tell(sender, `Revoked by ${item.revoked.actor.name}: ${item.revoked.reason}`);
    });
  }
}

@Command("mod history", mod)
export class History {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const target = person(this.target);
      printPage(sender, `History for ${target.name}`, [...backend.value().cases].reverse()
        .filter((row) => row.target.id === target.id).map((row) => describeCase(sender, row)), this.page);
    });
  }
}

@Command("mod inspect", mod)
export class Inspect {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const target = person(this.target);
      const player = online(target.id);
      tell(sender, `${target.name} • ${target.id} • ${player ? "Online" : "Offline"}`);
      if (player) {
        const position = player.getLocation();
        tell(sender, `${position.getWorld().getName()} • ${position.getBlockX()} ${position.getBlockY()} ${position.getBlockZ()} • ${player.getGameMode()}`);
      }
    });
  }
}

@Command("mod tp", mod)
export class TeleportToPlayer {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      requirePermission(sender, "teleport");
      const staff = inGame(sender);
      const target = online(person(this.target).id) ?? fail("That player must be online.");
      if (!staff.teleport(target.getLocation())) fail("Paper denied the teleport.");
      tell(staff, `Teleported to ${target.getName()}.`, "green");
    });
  }
}

@Command("mod audit", mod)
export class AuditTrail {
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) {
    if (!can(sender, "audit")) { tell(sender, "Requires rune.moderation.audit.", "red"); return; }
    printPage(sender, "Settings and chat activity", [...backend.value().audit].reverse().map((row) =>
      `${new Date(row.at).toISOString()} • ${row.actor.name} • ${row.action}`), this.page);
  }
}
