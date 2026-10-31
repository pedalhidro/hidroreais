/**
 * Deploys the community currency to Gnosis Chiado (10200) or Gnosis (100).
 *
 *   BANK_ADDRESS=0x... npx hardhat run scripts/deploy.ts --network chiado
 *
 * Env:
 *   BANK_ADDRESS        central bank Safe (or, while testing, an EOA). Gets admin, MINTER_ROLE and
 *                       ENFORCER_ROLE on the token, and is the recovery guardian and invites bank.
 *                       The deployer holds the token roles only while wiring up Invites, then
 *                       renounces them.
 *   TOKEN_NAME/SYMBOL   default "Hidroreais" / "PHR"
 *   RECOVERY_DELAY      seconds, default 0 (instant recovery while testing)
 *   ALLOWANCE           optional, tokens per member per epoch for the example AllowanceMinter
 *   EPOCH_DAYS          default 7
 *   EPOCH_CAP           tokens per epoch, default ALLOWANCE * 250
 *   INVITES_PER_MEMBER  open invites a member can have at once, default 5
 *   INVITES_ONLY=1      replace only the Invites contract, keeping the token and every account,
 *                       name and passkey; the bank then imports the members (see the output)
 *
 * Writes ../deployments/<chainId>.json, which the PWA and the server read.
 */
import { network } from "hardhat";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";

const require = createRequire(import.meta.url);

// Canonical addresses (deterministic deployments, same on every chain that has them).
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
// Safe 1.4.1 core. Present on Gnosis (100); Chiado only has 1.3.0, so we deploy copies there.
const SAFE_1_4_1 = {
  safeSingleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
} as const;
// Official Safe module deployments (safe-modules-deployments). Present on Gnosis (100).
const SAFE_MODULES = {
  safe4337Module: "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226", // v0.3.0
  safeModuleSetup: "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47", // v0.3.0
  webAuthnSharedSigner: "0x94a4F6affBd8975951142c3999aEAB7ecee555c2", // passkey v0.2.1
  webAuthnSignerFactory: "0x1d31F259eE307358a26dFb23EB365939E8641195", // passkey v0.2.1
  p256Verifier: "0xc2b78104907F722DABAc4C69f826a522B2754De4", // Daimo, passkey v0.2.1
} as const;
const CANONICAL = { ...SAFE_1_4_1, ...SAFE_MODULES } as const;

function artifact(path: string): { abi: unknown[]; bytecode: Hex } {
  return require(path);
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const bankEnv = process.env.BANK_ADDRESS;
if (!bankEnv || !isAddress(bankEnv, { strict: false })) throw new Error("Set BANK_ADDRESS to the central bank Safe (or a test EOA)");
const bank = getAddress(bankEnv);
const name = process.env.TOKEN_NAME ?? "Hidroreais";
const symbol = process.env.TOKEN_SYMBOL ?? "PHR";
const recoveryDelay = BigInt(process.env.RECOVERY_DELAY ?? "0");

// Fees from the median tip of recent blocks. Chiado's suggested tip jumps between 0 and 1 gwei
// (base fee ~7 wei), and one such reading once priced a whole deploy 10^8 times too high.
const history = await publicClient.getFeeHistory({ blockCount: 20, rewardPercentiles: [50] });
const tips = (history.reward ?? []).map((r) => r[0]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const tip = tips[Math.floor(tips.length / 2)] ?? 0n;
const fees = { maxPriorityFeePerGas: tip, maxFeePerGas: history.baseFeePerGas.at(-1)! * 2n + tip };

const hasCode = async (a: Address) => ((await publicClient.getCode({ address: a })) ?? "0x") !== "0x";

console.log(`Chain ${chainId}, deployer ${deployer.account.address}, bank ${bank}`);
console.log(`Fees: max ${fees.maxFeePerGas} wei, tip ${fees.maxPriorityFeePerGas} wei`);

// 1. The EntryPoint must already exist (skipped for a local dry run on 31337).
const isLocal = chainId === 31337;
if (!isLocal && !(await hasCode(ENTRY_POINT_V07))) {
  throw new Error(`entryPoint (${ENTRY_POINT_V07}) is not deployed on chain ${chainId}`);
}

// 2. Safe 1.4.1 + 4337 + passkey contracts: reuse the official ones, deploy our own copies where missing.
// Copies from an earlier deployment on this chain are reused, so a redeploy only adds our contracts.
const file = new URL(`../../deployments/${chainId}.json`, import.meta.url);
type Deployed = { bank?: Address; token?: { address: Address }; invites?: Address; previousInvites?: Address[]; aa?: Record<string, Address> };
const previous: Deployed | null = await readFile(file, "utf8").then(JSON.parse, () => null);

async function ensure(label: keyof typeof CANONICAL, deploy: () => Promise<Address>): Promise<Address> {
  const canonical = CANONICAL[label];
  if (await hasCode(canonical)) return canonical;
  const earlier = previous?.aa?.[label];
  if (earlier && (await hasCode(earlier))) {
    console.log(`  ${label} reusing the copy at ${earlier}`);
    return earlier;
  }
  console.log(`  ${label} missing on this chain, deploying a copy…`);
  return deploy();
}
async function deployArtifact(path: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(path);
  const hash = await deployer.deployContract({ abi, bytecode, args, ...fees } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy of ${path} failed`);
  return receipt.contractAddress;
}

const aa = {
  entryPoint: ENTRY_POINT_V07,
  safeSingleton: await ensure("safeSingleton", () =>
    deployArtifact("@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json"),
  ),
  safeProxyFactory: await ensure("safeProxyFactory", () =>
    deployArtifact("@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json"),
  ),
  multiSend: await ensure("multiSend", () =>
    deployArtifact("@safe-global/safe-contracts/build/artifacts/contracts/libraries/MultiSend.sol/MultiSend.json"),
  ),
  multiSendCallOnly: await ensure("multiSendCallOnly", () =>
    deployArtifact(
      "@safe-global/safe-contracts/build/artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
    ),
  ),
  safe4337Module: await ensure("safe4337Module", () =>
    deployArtifact("@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json", [
      ENTRY_POINT_V07,
    ]),
  ),
  safeModuleSetup: await ensure("safeModuleSetup", () =>
    deployArtifact("@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json"),
  ),
  webAuthnSharedSigner: await ensure("webAuthnSharedSigner", () =>
    deployArtifact(
      "@safe-global/safe-passkey/build/artifacts/contracts/4337/SafeWebAuthnSharedSigner.sol/SafeWebAuthnSharedSigner.json",
    ),
  ),
  webAuthnSignerFactory: await ensure("webAuthnSignerFactory", () =>
    deployArtifact(
      "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json",
    ),
  ),
  p256Verifier: await ensure("p256Verifier", () =>
    deployArtifact(
      "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json",
    ),
  ),
};

async function writeAbis() {
  // Keep a copy of the ABIs next to the addresses for the app and server.
  const abis: Record<string, unknown> = {};
  for (const c of ["CommunityToken", "RecoveryModule", "MemberDirectory", "AllowanceMinter", "Invites"]) {
    const a = JSON.parse(await readFile(new URL(`../artifacts/contracts/${c}.sol/${c}.json`, import.meta.url), "utf8"));
    abis[c] = a.abi;
  }
  await writeFile(new URL("../../deployments/abis.json", import.meta.url), JSON.stringify(abis, null, 2) + "\n");
}

// INVITES_ONLY: swap just the Invites contract. Everything members have (account, coins, name,
// passkeys) lives elsewhere and stays; only membership is carried over, by the bank.
if (process.env.INVITES_ONLY) {
  if (!previous?.token || !previous.invites) throw new Error(`INVITES_ONLY needs an existing deployments/${chainId}.json`);
  if (!previous.bank || previous.bank.toLowerCase() !== bank.toLowerCase()) throw new Error("BANK_ADDRESS differs from the deployed bank");
  const perMember = Number(process.env.INVITES_PER_MEMBER ?? "5");
  const invites = await viem.deployContract("Invites", [previous.token.address, bank, perMember], fees);
  console.log(`Invites           ${invites.address} (replaces ${previous.invites})`);
  const out = { ...previous, aa, invites: invites.address, previousInvites: [...(previous.previousInvites ?? []), previous.invites] };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  await writeAbis();
  console.log(`\nWrote ${file.pathname}`);
  console.log("Next, from the bank console (#/bank → Ajustes): import the current members into the new Invites,");
  console.log("let it mint, and stop the old one from minting. Then restart the server and redeploy the app.");
  process.exit(0);
}

// 3. Our contracts.
const startBlock = await publicClient.getBlockNumber();
const me = deployer.account.address;
const mined = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });
// The deployer starts as token admin so it can let Invites mint, then hands everything to the bank.
const token = await viem.deployContract("CommunityToken", [name, symbol, me], fees);
console.log(`CommunityToken    ${token.address}`);
const invitesPerMember = Number(process.env.INVITES_PER_MEMBER ?? "5");
const invites = await viem.deployContract("Invites", [token.address, bank, invitesPerMember], fees);
console.log(`Invites           ${invites.address} (${invitesPerMember} open invites per member)`);

const [admin, minter, enforcer] = await Promise.all([
  token.read.DEFAULT_ADMIN_ROLE(),
  token.read.MINTER_ROLE(),
  token.read.ENFORCER_ROLE(),
]);
await mined(await token.write.grantRole([minter, invites.address], fees));
for (const role of [admin, minter, enforcer]) await mined(await token.write.grantRole([role, bank], fees));
for (const role of [minter, enforcer, admin]) await mined(await token.write.renounceRole([role, me], fees));
for (const role of [admin, minter, enforcer]) {
  if (await token.read.hasRole([role, me])) throw new Error("deployer still holds a token role");
  if (!(await token.read.hasRole([role, bank]))) throw new Error("bank is missing a token role");
}
console.log("  token roles: bank is admin, minter and enforcer; Invites can mint; deployer has none");
const recovery = await viem.deployContract("RecoveryModule", [bank, recoveryDelay], fees);
console.log(`RecoveryModule    ${recovery.address} (delay ${recoveryDelay}s)`);
const directory = await viem.deployContract("MemberDirectory", [], fees);
console.log(`MemberDirectory   ${directory.address}`);

let allowanceMinter: Address | undefined;
if (process.env.ALLOWANCE) {
  const allowance = parseEther(process.env.ALLOWANCE);
  const epoch = BigInt(Number(process.env.EPOCH_DAYS ?? "7") * 86400);
  const cap = process.env.EPOCH_CAP ? parseEther(process.env.EPOCH_CAP) : allowance * 250n;
  const minter = await viem.deployContract("AllowanceMinter", [token.address, bank, allowance, epoch, cap], fees);
  allowanceMinter = minter.address;
  console.log(`AllowanceMinter   ${allowanceMinter}`);
  console.log("  → the bank must call token.grantRole(MINTER_ROLE, AllowanceMinter) to activate it");
}

const out = {
  chainId,
  startBlock: Number(startBlock),
  bank,
  token: { address: token.address, name, symbol, decimals: 18 },
  recoveryModule: recovery.address,
  directory: directory.address,
  invites: invites.address,
  allowanceMinter,
  aa,
};
await writeFile(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${file.pathname}`);
await writeAbis();
