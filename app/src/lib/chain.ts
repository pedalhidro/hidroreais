import { createPublicClient, getAddress, http, isAddressEqual, parseAbi, zeroAddress, type Address } from "viem";
import { chain, deployment, p256Verifiers, recoveryAbi, rpcUrl, serverUrl, tokenAbi } from "../config";
import { credentialHash, toPublicKey } from "./passkey";
import type { Identity } from "./identity";

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function isOwner(address owner) view returns (bool)",
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 threshold)",
]);
export const signerFactoryAbi = parseAbi([
  "function getSigner(uint256 x, uint256 y, uint176 verifiers) view returns (address)",
  "function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address)",
]);
const sharedSignerAbi = parseAbi([
  "function getConfiguration(address account) view returns ((uint256 x, uint256 y, uint176 verifiers))",
]);

// ------------------------------------------------------------------ server index
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`);
  if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
  return res.json() as Promise<T>;
}

export type Member = { address: Address; name: string | null };
/** confiscation: burned by the central bank; forced: moved by the central bank. Both carry a reason. */
export type ActivityItem = {
  kind: "transfer" | "mint" | "confiscation" | "forced";
  from: string;
  to: string;
  value: string;
  reason?: string;
  tx: string;
  block: number;
};
export type RecoveryItem = {
  /** taken: the central bank took control of the account (immediate, cannot be cancelled). */
  kind: "initiated" | "executed" | "cancelled" | "taken";
  safe: string;
  reason?: string;
  newOwner?: string;
  removeOthers?: boolean;
  executeAfter?: number;
  tx: string;
  block: number;
};
/** An invite as the server indexed it from the Invites contract. */
export type InviteRecord = {
  key: string;
  creator: string;
  amount: string;
  minting: boolean;
  maxUses: number;
  uses: number;
  expiresAt: number;
  closed: boolean;
  refunded?: string;
};
type CredentialRow = { credentialHash: string; safe: string; signer: string; x: string; y: string; block: number };

export const api = {
  config: () => get<{ chainId: number; vapidPublicKey: string | null; relayer: Address }>("/config"),
  directory: () => get<Member[]>("/directory"),
  activity: (a: Address) => get<{ names: Record<string, string>; items: ActivityItem[] }>(`/activity/${a}`),
  credentials: (hash: string) => get<CredentialRow[]>(`/credential/${hash}`),
  recoveries: (safe: Address) => get<RecoveryItem[]>(`/recoveries/${safe}`),
  recoveredBy: (owner: Address) => get<RecoveryItem[]>(`/recovered-by/${owner}`),
  invite: (key: Address) => get<{ invite: InviteRecord | null; creatorName: string | null }>(`/invite/${key}`),
  invitesBy: (creator: Address) => get<InviteRecord[]>(`/invites/by/${creator}`),
  transparency: () =>
    get<{
      names: Record<string, string>;
      accounts: { address: string; balance: string }[];
      mints: ActivityItem[];
      enforcement: ActivityItem[];
      recoveries: RecoveryItem[];
      indexedBlock: number;
    }>("/transparency"),
};

// ------------------------------------------------------------------ chain reads
export async function balanceOf(a: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: deployment.token.address,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [a],
  })) as bigint;
}

export async function getOwners(safe: Address): Promise<Address[]> {
  const code = await publicClient.getCode({ address: safe });
  if (!code || code === "0x") return [];
  return [...(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }))];
}

/** The signer proxy address a passkey gets on any device other than the first. */
export function signerFor(x: bigint, y: bigint): Promise<Address> {
  return publicClient.readContract({
    address: deployment.aa.webAuthnSignerFactory,
    abi: signerFactoryAbi,
    functionName: "getSigner",
    args: [x, y, p256Verifiers],
  });
}

export type PendingRecovery = { newOwner: Address; removeOthers: boolean; executeAfter: number } | null;

export async function pendingRecovery(safe: Address): Promise<PendingRecovery> {
  const [newOwner, removeOthers, executeAfter] = (await publicClient.readContract({
    address: deployment.recoveryModule,
    abi: recoveryAbi,
    functionName: "pending",
    args: [safe],
  })) as [Address, boolean, bigint];
  if (isAddressEqual(newOwner, zeroAddress)) return null;
  return { newOwner, removeOthers, executeAfter: Number(executeAfter) };
}

export async function recoveryDelay(): Promise<number> {
  return Number(
    (await publicClient.readContract({ address: deployment.recoveryModule, abi: recoveryAbi, functionName: "recoveryDelay" })) as bigint,
  );
}

/**
 * Directory entries are self-asserted, so never trust one blindly: the signer must be a
 * current owner of the Safe, and must really be the signer for this public key.
 */
async function verify(row: CredentialRow): Promise<boolean> {
  const safe = getAddress(row.safe);
  const signer = getAddress(row.signer);
  const x = BigInt(row.x);
  const y = BigInt(row.y);
  const isOwner = await publicClient
    .readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [signer] })
    .catch(() => false);
  if (!isOwner) return false;
  if (isAddressEqual(signer, deployment.aa.webAuthnSharedSigner)) {
    const cfg = await publicClient.readContract({
      address: deployment.aa.webAuthnSharedSigner,
      abi: sharedSignerAbi,
      functionName: "getConfiguration",
      args: [safe],
    });
    return cfg.x === x && cfg.y === y;
  }
  return isAddressEqual(await signerFor(x, y), signer);
}

/**
 * Finds the account a passkey belongs to, from its credential id. `keyMatches` must confirm
 * the candidate public key really is this passkey's (a fresh WebAuthn signature on login, or
 * the key this device created), otherwise a copied credential hash could hijack the lookup.
 */
export async function lookupCredential(
  credentialId: string,
  keyMatches: (x: bigint, y: bigint) => boolean,
): Promise<Identity | null> {
  const rows = await api.credentials(credentialHash(credentialId));
  for (const row of [...rows].reverse()) {
    if (!keyMatches(BigInt(row.x), BigInt(row.y))) continue;
    if (await verify(row)) {
      return {
        credentialId,
        publicKey: toPublicKey(BigInt(row.x), BigInt(row.y)),
        signer: getAddress(row.signer),
        safe: getAddress(row.safe),
      };
    }
  }
  return null;
}
