/** @jsxImportSource react */
import {
  Activity, Boxes, Flag, House, KeyRound, LayoutDashboard, ListTree, MapPin, Megaphone, MessageSquare,
  Puzzle, ScrollText, Server, Settings, Shield, SlidersHorizontal, Sword, UserRound, Users, type LucideIcon,
} from "lucide-react";
import { avatarKey, playerName } from "./avatar-url.ts";

const navigation = new Map<string, LucideIcon>([
  ["/", LayoutDashboard], ["/runes", Boxes], ["/server", Server], ["/players", Users],
  ["/logs", ScrollText], ["/settings", Settings], ["/activity", Activity], ["/account", UserRound],
  ["/access", KeyRound],
  ["moderation", Shield], ["permissions", KeyRound], ["announcements", Megaphone], ["anticheat", Sword],
  ["homes", House], ["warps", MapPin], ["npcs", Users], ["preferences", SlidersHorizontal],
  ["/tools/moderation/cases", ScrollText], ["/tools/moderation/reports", Flag], ["/tools/moderation/players", Users],
  ["/tools/permissions/groups", Users], ["/tools/permissions/players", UserRound], ["/tools/permissions/tracks", ListTree],
  ["/tools/permissions/chat", MessageSquare], ["/tools/moderation/chat", MessageSquare],
]);

export function NavIcon({ path }: { path: string }) {
  const Icon = navigation.get(path) ?? navigation.get(path.split("/")[2]) ?? Puzzle;
  return <Icon className="nav-icon" size={17} aria-hidden="true" focusable="false" />;
}

export function PlayerHead({ name, id }: { name: string; id?: string }) {
  const key = id ? avatarKey(id) : avatarKey(name);
  const query = id && playerName.test(name) && key !== name.toLowerCase() ? "?name=" + encodeURIComponent(name) : "";
  return <span className="player-avatar" aria-hidden="true">
    <UserRound size={16} focusable="false" />
    {key && <img src={"/avatars/" + key + query} alt="" width={26} height={26} loading="lazy" />}
  </span>;
}

export function PlayerIdentity({ name, id }: { name: string; id?: string }) {
  return <span className="player-identity">
    <PlayerHead name={name} id={id} />
    <span>{name}</span>
  </span>;
}
