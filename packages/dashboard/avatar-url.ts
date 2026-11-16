export function avatarKey(value: string) {
  return /^(?:[a-z0-9_]{1,16}|[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ? value.toLowerCase() : undefined;
}
