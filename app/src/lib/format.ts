import { formatUnits, parseUnits, type Address } from "viem";
import { symbol } from "../config";

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export const coins = (wei: bigint | string) => nf.format(Number(formatUnits(BigInt(wei), 18)));
export const coinsWithSymbol = (wei: bigint | string) => `${coins(wei)} ${symbol}`;

/** Accepts "10", "10,5" or "10.50" (people in Brazil type a comma). */
export function parseAmount(input: string): bigint | null {
  const clean = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,18})?$/.test(clean)) return null;
  const value = parseUnits(clean, 18);
  return value > 0n ? value : null;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const nameOr = (names: Record<string, string | null | undefined>, a: string) =>
  names[a.toLowerCase()] ?? short(a);

export const sameAddress = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type { Address };

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/NotAllowedError|cancel|abort/i.test(raw)) return "A confirmação com a passkey foi cancelada.";
  if (/invite/i.test(raw)) return "Este convite não é válido ou já foi usado. Peça um novo convite.";
  if (/daily limit/i.test(raw)) return "Você atingiu o limite diário de operações gratuitas. Tente amanhã.";
  if (/only community members/i.test(raw)) return "Esta conta ainda não foi aprovada como membro.";
  if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(raw)) return "Saldo insuficiente.";
  if (/fetch|network/i.test(raw)) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
  return raw.split("\n")[0].slice(0, 200);
}
