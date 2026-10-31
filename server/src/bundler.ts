/**
 * Minimal bundler: submits sponsored user operations straight to the EntryPoint from the
 * relayer key, one operation per transaction. A hosted bundler is one more thing that can
 * break (Pimlico's fails on Chiado), and at community scale one key is plenty. Gas estimation
 * and the paymaster stay with Pimlico. The EntryPoint refunds the relayer (the beneficiary)
 * from the paymaster's deposit, so the relayer only needs a small float of xDAI.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  getAbiItem,
  isAddressEqual,
  parseEventLogs,
  toHex,
  type Address,
  type Hash,
  type RpcTransactionReceipt,
} from "viem";
import {
  entryPoint07Abi,
  formatUserOperation,
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { config, deployment } from "./config.js";
import { publicClient } from "./indexer.js";
import { PolicyError, checkCalls, checkDeployment, type RpcUserOperation } from "./policy.js";
import { relayerAccount, relayerWallet } from "./relay.js";

const entryPoint = deployment.aa.entryPoint;
const userOperationEvent = getAbiItem({ abi: entryPoint07Abi, name: "UserOperationEvent" });

// userOpHash -> transaction that carried it. Lost on restart; receipts then fall back to logs.
const sent = new Map<Hash, Hash>();

export async function sendUserOperation(rpcOp: RpcUserOperation & { paymaster?: Address | null }, entryPointArg: Address) {
  if (!isAddressEqual(entryPointArg, entryPoint)) throw new PolicyError("unsupported EntryPoint");
  // The paymaster was asked through our /rpc already, but this endpoint spends relayer gas,
  // so the same rules apply again here.
  if (!rpcOp?.paymaster) throw new PolicyError("only sponsored operations are accepted");
  if (rpcOp.factory) checkDeployment(rpcOp);
  checkCalls(rpcOp);

  const op = formatUserOperation(rpcOp as never) as UserOperation<"0.7">;
  const hash = getUserOperationHash({
    chainId: config.chainId,
    entryPointAddress: entryPoint,
    entryPointVersion: "0.7",
    userOperation: op,
  });
  const args = [[toPackedUserOperation(op)], relayerAccount.address] as const;

  // Simulate first: a failing operation costs nothing, and its "AAxx" reason goes back to the app.
  try {
    await publicClient.simulateContract({ account: relayerAccount, address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args });
  } catch (err) {
    const reason = revertReason(err);
    // The whole operation, so a rejection can be replayed and picked apart (nothing in it is secret).
    console.warn(`rejected user operation from ${rpcOp.sender}: ${reason}\n${JSON.stringify(rpcOp)}`);
    throw new PolicyError(`user operation rejected: ${reason}`);
  }
  // The operation's own limits plus EntryPoint overhead; unused gas is not charged.
  const gas =
    op.preVerificationGas +
    op.verificationGasLimit +
    op.callGasLimit +
    (op.paymasterVerificationGasLimit ?? 0n) +
    (op.paymasterPostOpGasLimit ?? 0n) +
    100_000n;
  const tx = await relayerWallet.writeContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args, gas });
  sent.set(hash, tx);
  return hash;
}

function revertReason(err: unknown): string {
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const data = (revert as ContractFunctionRevertedError | null)?.data;
  // FailedOp(opIndex, reason) and FailedOpWithRevert(opIndex, reason, inner)
  if (data?.errorName.startsWith("FailedOp")) return String(data.args?.[1]);
  return (err as Error).message.split("\n")[0];
}

/** Returns null until the operation is mined, which tells the client to keep polling. */
export async function getUserOperationReceipt(hash: Hash) {
  let tx = sent.get(hash);
  if (!tx) {
    const latest = await publicClient.getBlockNumber();
    const [log] = await publicClient.getLogs({
      address: entryPoint,
      event: userOperationEvent,
      args: { userOpHash: hash },
      fromBlock: latest > config.logChunk ? latest - config.logChunk : 0n,
    });
    if (!log) return null;
    tx = log.transactionHash;
  }
  const receipt = (await publicClient.request({ method: "eth_getTransactionReceipt", params: [tx] })) as RpcTransactionReceipt | null;
  if (!receipt) return null;
  const [event] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs as never }).filter(
    (e) => e.args.userOpHash === hash,
  );
  if (!event) throw new PolicyError("user operation rejected: the bundle transaction reverted");
  return {
    userOpHash: hash,
    entryPoint,
    sender: event.args.sender,
    nonce: toHex(event.args.nonce),
    paymaster: event.args.paymaster,
    actualGasCost: toHex(event.args.actualGasCost),
    actualGasUsed: toHex(event.args.actualGasUsed),
    success: event.args.success,
    logs: receipt.logs,
    receipt,
  };
}
