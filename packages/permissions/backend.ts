import { paperStore } from "@rune/storage";
import { initial, type PermissionState } from "./model.ts";

export const backend = paperStore<PermissionState>(rune, {
  id: "permissions",
  localName: "rune-permissions",
  localKey: "state",
  remoteKey: "permissions:state:v1",
  initial,
  clearAfterMs: 30_000,
});
