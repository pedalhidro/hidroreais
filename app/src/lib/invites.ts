import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chain, deployment, invitesAbi, tokenAbi } from "../config";
import { sendCalls, type AccountInput } from "./account";
import { publicClient } from "./chain";
import { base } from "./links";

/*
 * An invite is a throwaway key pair. The Invites contract stores its address; its private key
 * travels in the link, after the "#", so it never reaches a server. Claiming signs the new
 * account's address with it (Invites.claimDigest), so a copied transaction cannot redirect it.
 */

export const EXPIRY_PRESETS = [
  { label: "1 hora", seconds: 3600 },
  { label: "6 horas", seconds: 6 * 3600 },
  { label: "24 horas", seconds: 24 * 3600 },
  { label: "1 semana", seconds: 7 * 24 * 3600 },
] as const;
export const DEFAULT_EXPIRY = 24 * 3600;

/** Payment links are like cash in hand: short by default. */
export const PAY_LINK_PRESETS = [
  { label: "5 min", seconds: 5 * 60 },
  { label: "1 hora", seconds: 3600 },
  { label: "1 dia", seconds: 24 * 3600 },
  { label: "1 semana", seconds: 7 * 24 * 3600 },
] as const;
export const PAY_LINK_DEFAULT_EXPIRY = 5 * 60;

export const inviteKeyOf = (pk: Hex): Address => privateKeyToAccount(pk).address;
export const inviteLink = (pk: Hex) => `${base()}#/welcome?i=${pk.slice(2)}`;

export function parseInvitePk(s: string | null): Hex | null {
  if (!s) return null;
  const hex = s.startsWith("0x") ? s : `0x${s}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as Hex) : null;
}

export async function claimSignature(pk: Hex, account: Address): Promise<Hex> {
  const digest = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }],
      [BigInt(chain.id), deployment.invites, account],
    ),
  );
  return privateKeyToAccount(pk).signMessage({ message: { raw: digest } });
}

/**
 * Expiry from the chain's clock, not the phone's: the contract caps invites at 7 days from the
 * block time, and a phone clock running ahead would push "1 semana" past that.
 */
export async function expiryFromNow(seconds: number): Promise<bigint> {
  const { timestamp } = await publicClient.getBlock();
  // A minute of slack only at the 7-day cap, so a 5-minute link really lasts 5 minutes.
  return timestamp + BigInt(seconds) - (seconds >= 7 * 24 * 3600 ? 60n : 0n);
}

// The creator keeps each invite's private key on this device, to show the link again later.
const KEYS = "coin.invite-keys";
function savedKeys(): Record<string, Hex> {
  try {
    return JSON.parse(localStorage.getItem(KEYS) ?? "{}");
  } catch {
    return {};
  }
}
export function rememberInvite(pk: Hex) {
  try {
    localStorage.setItem(KEYS, JSON.stringify({ ...savedKeys(), [inviteKeyOf(pk).toLowerCase()]: pk }));
  } catch {
    // Storage blocked: the link is still shown once, right after creating it.
  }
}
export const savedInvitePk = (key: string): Hex | null => savedKeys()[key.toLowerCase()] ?? null;

/** A fresh key, remembered on this device before anything is sent. */
export function newInvite(): { pk: Hex; key: Address } {
  const pk = generatePrivateKey();
  rememberInvite(pk);
  return { pk, key: inviteKeyOf(pk) };
}

/**
 * A member locks `amount` (may be 0) for one person until it is claimed or closed: a newcomer
 * (an invite), or with `openToMembers` also an existing member (a payment by link).
 */
export async function createMemberInvite(
  identity: AccountInput,
  amount: bigint,
  seconds: number,
  openToMembers = false,
): Promise<Hex> {
  const { pk, key } = newInvite();
  const expiresAt = await expiryFromNow(seconds);
  const create = {
    to: deployment.invites,
    data: encodeFunctionData({ abi: invitesAbi, functionName: "create", args: [key, amount, expiresAt, openToMembers] }),
  };
  const approve = {
    to: deployment.token.address,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [deployment.invites, amount] }),
  };
  await sendCalls(identity, amount > 0n ? [approve, create] : [create]);
  return pk;
}

export async function cancelInvite(identity: AccountInput, key: string) {
  await sendCalls(identity, [
    { to: deployment.invites, data: encodeFunctionData({ abi: invitesAbi, functionName: "cancel", args: [key as Address] }) },
  ]);
}
