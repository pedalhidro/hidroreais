import { gnosis, gnosisChiado } from "viem/chains";
import type { Abi, Address, Chain } from "viem";
import abis from "../../deployments/abis.json";

export type Deployment = {
  chainId: number;
  startBlock: number;
  bank: Address;
  token: { address: Address; name: string; symbol: string; decimals: number };
  recoveryModule: Address;
  directory: Address;
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

const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 10200);
const chains: Record<number, Chain> = { 100: gnosis, 10200: gnosisChiado };
export const chain = chains[chainId];
if (!chain) throw new Error(`Unsupported VITE_CHAIN_ID ${chainId}`);

const all = import.meta.glob<{ default: Deployment }>("../../deployments/[0-9]*.json", { eager: true });
const found = Object.entries(all).find(([path]) => path.endsWith(`/${chainId}.json`));
if (!found) throw new Error(`No deployments/${chainId}.json. Run the contracts deploy script first.`);
export const deployment: Deployment = found[1].default;

export const serverUrl: string = (import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const rpcUrl: string = import.meta.env.VITE_RPC_URL ?? chain.rpcUrls.default.http[0];
export const explorerUrl = chain.blockExplorers?.default.url ?? "";

export const symbol = deployment.token.symbol;
/** What amounts are shown in ("10 Hidroreais"). The symbol (PHR) is for wallets and the logo. */
export const currency = deployment.token.name;

/** P256 verifier config used for every passkey signer: no precompile, fallback contract only. */
export const p256Verifiers = BigInt(deployment.aa.p256Verifier);

export const tokenAbi = abis.CommunityToken as Abi;
export const recoveryAbi = abis.RecoveryModule as Abi;
export const directoryAbi = abis.MemberDirectory as Abi;
export const allowanceMinterAbi = abis.AllowanceMinter as Abi;
