export function nowIso(): string {
  return new Date().toISOString();
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString();
}
