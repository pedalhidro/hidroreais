import { readFileSync } from "node:fs";
import { gnosis, gnosisChiado } from "viem/chains";
import type { Abi, Address, Chain } from "viem";

export type Deployment = {
  chainId: number;
  startBlock: number;
  bank: Address;
  token: { address: Address; name: string; symbol: string; decimals: number };
  recoveryModule: Address;
  directory: Address;
  invites: Address;
  /** Earlier Invites contracts, replaced with INVITES_ONLY; their links no longer work. */
  previousInvites?: Address[];
  allowanceMinter?: Address;
  aa: {
    entryPoint: Address;
    safeSingleton: Address;
    safeProxyFactory: Address;
    multiSend: Address;
    multiSendCallOnly: Address;
    safe4337Module: Address;
    safeModuleSetup: Address;
    webAuthnSharedSigner: Address;
    webAuthnSignerFactory: Address;
    p256Verifier: Address;
  };
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

const chainId = Number(env("CHAIN_ID", "10200"));
const chains: Record<number, Chain> = { 100: gnosis, 10200: gnosisChiado };
const chain = chains[chainId];
if (!chain) throw new Error(`Unsupported CHAIN_ID ${chainId}`);

const deploymentsDir = new URL("../../deployments/", import.meta.url);
const deploymentFile = process.env.DEPLOYMENT_FILE ?? new URL(`${chainId}.json`, deploymentsDir);
export const deployment: Deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
export const abis: Record<"CommunityToken" | "RecoveryModule" | "MemberDirectory" | "AllowanceMinter" | "Invites", Abi> =
  JSON.parse(readFileSync(new URL("abis.json", deploymentsDir), "utf8"));

const pimlicoSlug = chainId === 100 ? "gnosis" : "chiado-testnet";

export const config = {
  chain,
  chainId,
  port: Number(env("PORT", "8787")),
  rpcUrl: env("RPC_URL", chain.rpcUrls.default.http[0]),
  pimlicoUrl: `https://api.pimlico.io/v2/${pimlicoSlug}/rpc?apikey=${env("PIMLICO_API_KEY")}`,
  sponsorshipPolicyId: process.env.PIMLICO_SPONSORSHIP_POLICY_ID || undefined,
  relayerPrivateKey: env("RELAYER_PRIVATE_KEY") as `0x${string}`,
  adminToken: env("ADMIN_TOKEN"),
  allowedOrigin: env("ALLOWED_ORIGIN", "*"),
  dataDir: env("DATA_DIR", new URL("../data/", import.meta.url).pathname),
  maxOpsPerDay: Number(env("MAX_OPS_PER_DAY", "50")),
  maxRelaysPerDay: Number(env("MAX_RELAYS_PER_DAY", "20")),
  maxRelaysGlobalPerDay: Number(env("MAX_RELAYS_GLOBAL_PER_DAY", "500")),
  logChunk: BigInt(env("LOG_CHUNK", "5000")),
  pollMs: Number(env("POLL_MS", "10000")),
  vapid: process.env.VAPID_PUBLIC_KEY
    ? {
        publicKey: env("VAPID_PUBLIC_KEY"),
        privateKey: env("VAPID_PRIVATE_KEY"),
        subject: env("VAPID_SUBJECT", "mailto:admin@example.org"),
      }
    : undefined,
};
