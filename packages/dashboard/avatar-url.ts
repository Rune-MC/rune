export const playerUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const playerName = /^[a-z0-9_]{1,16}$/i;

export function avatarKey(value: string) {
  if (playerUuid.test(value)) return value.replaceAll("-", "").toLowerCase();
  if (playerName.test(value) || /^[a-f0-9]{32}$/i.test(value)) return value.toLowerCase();
}
