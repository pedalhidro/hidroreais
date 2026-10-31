/**
 * Gasless sends for members using an external wallet (MetaMask, Rabby, …): the member signs
 * an EIP-3009 TransferWithAuthorization message, the relayer submits it and pays the xDAI.
 * The same key submits user operations (bundler.ts). Keep its balance small; the central bank
 * tops it up.
 */
import { createWalletClient, getAddress, http, isAddress, isHex, nonceManager, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abis, config, deployment } from "./config.js";
import { publicClient } from "./indexer.js";
import { consume, isMember, state } from "./store.js";

// The nonce manager keeps concurrent sends (relays, user operations, the keeper) from colliding.
const account = privateKeyToAccount(config.relayerPrivateKey, { nonceManager });
const wallet = createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl) });

export const relayerAddress = account.address;
export const relayerAccount = account;
export const relayerWallet = wallet;

export type RelayRequest = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
};

export class RelayError extends Error {}

export async function relayTransfer(r: RelayRequest): Promise<Hex> {
  if (!isAddress(r.from, { strict: false }) || !isAddress(r.to, { strict: false })) throw new RelayError("bad address");
  if (!isHex(r.nonce) || r.nonce.length !== 66 || !isHex(r.signature)) throw new RelayError("bad nonce or signature");
  const value = BigInt(r.value);
  const validAfter = BigInt(r.validAfter);
  const validBefore = BigInt(r.validBefore);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (value <= 0n) throw new RelayError("value must be positive");
  if (validBefore - now > 3600n) throw new RelayError("authorization must expire within an hour");
  // Only registered members (an admin adds external wallets via /admin/members).
  if (!isMember(r.from)) throw new RelayError("this wallet is not registered as a community member");

  const args = [getAddress(r.from), getAddress(r.to), value, validAfter, validBefore, r.nonce as Hex, r.signature as Hex] as const;
  // Simulate first so an invalid signature costs us nothing.
  const { request } = await publicClient.simulateContract({
    account,
    address: deployment.token.address,
    abi: abis.CommunityToken,
    functionName: "transferWithAuthorization",
    args,
  });
  // Count usage only for requests that would succeed, so garbage cannot burn a member's quota.
  if (!consume(r.from, "relays", config.maxRelaysPerDay)) throw new RelayError("daily limit reached");
  if (!consume("global", "relays", config.maxRelaysGlobalPerDay)) throw new RelayError("daily limit reached");
  return wallet.writeContract(request);
}

/**
 * Keeper: closes expired member invites so the locked coins go back to their creators (and the
 * creator's open-invite slot frees up). Anyone may call refund; the relayer pays the gas.
 */
export async function refundExpiredInvites() {
  const now = Math.floor(Date.now() / 1000);
  for (const inv of Object.values(state.index.invites)) {
    if (inv.closed || inv.minting || inv.expiresAt > now) continue;
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: deployment.invites,
        abi: abis.Invites,
        functionName: "refund",
        args: [getAddress(inv.key)],
      });
      const hash = await wallet.writeContract(request);
      inv.closed = true; // the indexer fills in the refund once the event arrives
      console.log(`refunded expired invite ${inv.key}: ${hash}`);
    } catch (err) {
      console.warn(`invite ${inv.key} not refundable: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

/**
 * Keeper: executes queued recoveries once their delay has passed (anyone may call
 * executeRecovery; the relayer pays the gas). Not needed while the delay is zero.
 */
export async function executeDueRecoveries() {
  const latest = new Map<string, (typeof state.index.recoveries)[number]>();
  for (const r of state.index.recoveries) latest.set(r.safe, r);
  const now = Math.floor(Date.now() / 1000);
  for (const r of latest.values()) {
    if (r.kind !== "initiated" || !r.executeAfter || r.executeAfter > now) continue;
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: deployment.recoveryModule,
        abi: abis.RecoveryModule,
        functionName: "executeRecovery",
        args: [getAddress(r.safe)],
      });
      const hash = await wallet.writeContract(request);
      console.log(`executed recovery for ${r.safe}: ${hash}`);
    } catch (err) {
      // Already executed, cancelled, or replaced: the indexer will catch up.
      console.warn(`recovery for ${r.safe} not executable: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}
