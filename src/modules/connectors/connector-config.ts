/** Small, total readers for untyped connector configuration JSON. */

export function optionString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionNumber(source: unknown, key: string, fallback: number, min: number, max: number): number {
  const raw = source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (raw === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)));
}

export function usesOutboundRelay(config: Record<string, unknown>): boolean {
  const connectivity = config.connectivity;
  return Boolean(connectivity && typeof connectivity === 'object'
    && (connectivity as Record<string, unknown>).mode === 'relay');
}
