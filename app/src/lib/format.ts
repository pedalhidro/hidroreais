import { formatUnits, parseUnits, type Address } from "viem";
import { currency } from "../config";

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export const coins = (wei: bigint | string) => nf.format(Number(formatUnits(BigInt(wei), 18)));
export const coinsWithSymbol = (wei: bigint | string) => `${coins(wei)} ${currency}`;

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
  console.error(err);
  const first = err instanceof Error ? err.message : String(err);
  // Wrapped errors (viem, ox) keep the browser's reason in `cause`, and a DOMException puts
  // it in `name` ("NotAllowedError"), not in the message.
  let raw = "";
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    raw += e instanceof Error ? `${e.name}: ${e.message}\n` : `${String(e)}\n`;
  }
  if (/NotAllowedError|cancel|abort/i.test(raw)) return "A confirmação com a passkey foi cancelada.";
  // Invites reverts: by name, or by selector when the bundler only passes the raw revert data.
  if (/TooManyOpenInvites|0x12405a39/i.test(raw)) {
    return "Você já tem convites abertos demais. Cancele um ou espere algum expirar.";
  }
  if (/invite/i.test(raw)) return "Este convite não vale mais: expirou, já foi usado ou é de outra conta. Peça um novo.";
  if (/daily limit/i.test(raw)) return "Você atingiu o limite diário de operações gratuitas. Tente amanhã.";
  if (/only community members/i.test(raw)) return "Esta conta ainda não foi aprovada como membro.";
  if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(raw)) return "Saldo insuficiente.";
  const rejected = raw.match(/user operation rejected: ([^\n]*)/);
  if (rejected) return `A rede recusou a operação (${rejected[1]}). Tente de novo em instantes.`;
  if (/fetch|network/i.test(raw)) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
  return first.split("\n")[0].slice(0, 200);
}
