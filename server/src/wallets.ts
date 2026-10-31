/**
 * Which plain wallets (MetaMask, Rabby, …) are owners of which member accounts. A member can add
 * a wallet as a backup key; the directory then shows it under their name, and the rescue screen
 * finds the account from the wallet. Read from the chain every minute with one multicall. Owners
 * with code are passkey signers (shared signer or a signer proxy) and are left out.
 */
import { parseAbi, type Address } from "viem";
import { publicClient } from "./indexer.js";
import { state } from "./store.js";

const getOwnersAbi = parseAbi(["function getOwners() view returns (address[])"]);
const hasCode = new Map<string, boolean>(); // an owner never turns from contract into wallet here
let walletToSafe = new Map<string, string>();
let safeToWallets = new Map<string, string[]>();

export async function refreshWallets() {
  const safes = Object.keys(state.members);
  if (safes.length === 0) return;
  const results = await publicClient.multicall({
    contracts: safes.map((s) => ({ address: s as Address, abi: getOwnersAbi, functionName: "getOwners" }) as const),
    allowFailure: true,
  });
  const nextWalletToSafe = new Map<string, string>();
  const nextSafeToWallets = new Map<string, string[]>();
  for (const [i, r] of results.entries()) {
    if (r.status !== "success") continue; // an external-wallet member, not a Safe
    const safe = safes[i]!;
    for (const owner of r.result as readonly Address[]) {
      const o = owner.toLowerCase();
      if (!hasCode.has(o)) hasCode.set(o, ((await publicClient.getCode({ address: owner })) ?? "0x") !== "0x");
      if (hasCode.get(o)) continue;
      nextWalletToSafe.set(o, safe);
      nextSafeToWallets.set(safe, [...(nextSafeToWallets.get(safe) ?? []), o]);
    }
  }
  walletToSafe = nextWalletToSafe;
  safeToWallets = nextSafeToWallets;
}

export const safeOfWallet = (wallet: string) => walletToSafe.get(wallet.toLowerCase()) ?? null;
export const walletsOf = (safe: string) => safeToWallets.get(safe.toLowerCase()) ?? [];

/** "abiruto (carteira)" for each backup wallet, to merge into the names the app shows. */
export function walletNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [wallet, safe] of walletToSafe) {
    const name = state.index.names[safe];
    if (name) names[wallet] = `${name} (carteira)`;
  }
  return names;
}
