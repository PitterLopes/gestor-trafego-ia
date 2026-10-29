/** Utilitários pequenos compartilhados pelo Worker. */
export const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function clampInt(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
