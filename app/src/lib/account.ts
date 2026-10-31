import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { encodeFunctionData, http, type Address, type Hex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { chain, deployment, directoryAbi, serverUrl } from "../config";
import { publicClient } from "./chain";
import type { Passkey } from "./passkey";
import { credentialHash } from "./passkey";

// Bundler and paymaster both go through our server, which holds the provider key and
// decides what the central bank sponsors.
const rpc = http(`${serverUrl}/rpc`);
const entryPoint = { address: deployment.aa.entryPoint, version: "0.7" } as const;
export const pimlicoClient = createPimlicoClient({ transport: rpc, entryPoint });

export type Call = { to: Address; data: Hex; value?: bigint };

type AccountInput = {
  credentialId: string;
  publicKey: Hex;
  /** Safe owner for this passkey. The first device uses the shared signer. */
  signer: Address;
  /** Known once the account exists; omitted when creating a new account. */
  safe?: Address;
};

function safeAccount(input: AccountInput) {
  return toSafeSmartAccount({
    client: publicClient,
    owners: [toWebAuthnAccount({ credential: { id: input.credentialId, publicKey: input.publicKey } })],
    version: "1.4.1",
    entryPoint,
    address: input.safe,
    safe4337ModuleAddress: deployment.aa.safe4337Module,
    safeModuleSetupAddress: deployment.aa.safeModuleSetup,
    safeProxyFactoryAddress: deployment.aa.safeProxyFactory,
    safeSingletonAddress: deployment.aa.safeSingleton,
    multiSendAddress: deployment.aa.multiSend,
    multiSendCallOnlyAddress: deployment.aa.multiSendCallOnly,
    // permissionless names this "shared signer", but any WebAuthn signer contract works:
    // devices linked later sign through their own SafeWebAuthnSignerProxy.
    safeWebAuthnSharedSignerAddress: input.signer,
    safeP256VerifierAddress: deployment.aa.p256Verifier,
    // Every member Safe enables the community RecoveryModule from day one.
    safeModules: [deployment.recoveryModule],
  });
}

/** Sends calls from the member's Safe; gas is sponsored. Resolves with the tx hash once mined. */
export async function sendCalls(input: AccountInput, calls: Call[], invite?: string): Promise<Hex> {
  const account = await safeAccount(input);
  const client = createSmartAccountClient({
    account,
    chain,
    bundlerTransport: rpc,
    paymaster: pimlicoClient,
    paymasterContext: invite ? { invite } : {},
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });
  const hash = await client.sendUserOperation({ calls });
  const receipt = await client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  if (!receipt.success) throw new Error("A operação foi incluída mas falhou na rede.");
  return receipt.receipt.transactionHash;
}

/** Address the new account will have, before it exists on-chain. */
export async function predictSafe(passkey: Passkey): Promise<Address> {
  const account = await safeAccount({
    credentialId: passkey.id,
    publicKey: passkey.publicKey,
    signer: deployment.aa.webAuthnSharedSigner,
  });
  return account.address;
}

/** First operation of a new member: deploys the Safe, sets the name, publishes the passkey. */
export async function createAccount(passkey: Passkey, name: string, invite: string) {
  const signer = deployment.aa.webAuthnSharedSigner;
  const input = { credentialId: passkey.id, publicKey: passkey.publicKey, signer };
  const safe = await predictSafe(passkey);
  await sendCalls(
    input,
    [
      { to: deployment.directory, data: encodeFunctionData({ abi: directoryAbi, functionName: "setName", args: [name] }) },
      {
        to: deployment.directory,
        data: encodeFunctionData({
          abi: directoryAbi,
          functionName: "linkCredential",
          args: [credentialHash(passkey.id), signer, passkey.x, passkey.y],
        }),
      },
    ],
    invite,
  );
  return { ...input, safe, name };
}
