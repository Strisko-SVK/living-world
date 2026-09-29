export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, " ");
}
