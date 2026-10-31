/**
 * Sponsorship policy: which user operations the central bank pays gas for.
 *
 * Sponsored:
 *   - Deploying a new member Safe, once per unused invite code, and only if the Safe is a
 *     standard Safe 1.4.1 whose setup enables the community RecoveryModule.
 *   - Operations from registered members whose calls are all on the allow-list below.
 * Everything else is refused, so a leaked app or a curious member cannot spend the budget
 * on arbitrary contract calls.
 */
import {
  decodeFunctionData,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  parseAbi,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { deployment } from "./config.js";

export type RpcUserOperation = {
  sender: Address;
  nonce: Hex;
  factory?: Address | null;
  factoryData?: Hex | null;
  callData: Hex;
};

export class PolicyError extends Error {}

const safe4337Abi = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
  "function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)",
]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)",
]);
const setupAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);
const enableModulesAbi = parseAbi(["function enableModules(address[] modules)"]);
const configureAbi = parseAbi(["function configure((uint256 x, uint256 y, uint176 verifiers) signer)"]);

// target -> allowed function signatures. `self` means the sender Safe itself.
const allowed: { target: Address | "self"; abi: ReturnType<typeof parseAbi> }[] = [
  {
    target: deployment.token.address,
    abi: parseAbi(["function transfer(address to, uint256 value)"]),
  },
  {
    target: deployment.directory,
    abi: parseAbi([
      "function setName(string name)",
      "function linkCredential(bytes32 credentialHash, address signer, uint256 x, uint256 y)",
    ]),
  },
  {
    target: "self",
    abi: parseAbi([
      "function addOwnerWithThreshold(address owner, uint256 threshold)",
      "function removeOwner(address prevOwner, address owner, uint256 threshold)",
    ]),
  },
  {
    target: deployment.aa.webAuthnSignerFactory,
    abi: parseAbi(["function createSigner(uint256 x, uint256 y, uint176 verifiers)"]),
  },
  {
    target: deployment.recoveryModule,
    abi: parseAbi(["function cancelRecovery()"]),
  },
  ...(deployment.allowanceMinter
    ? [{ target: deployment.allowanceMinter, abi: parseAbi(["function claim(address member)"]) }]
    : []),
];

type Call = { to: Address; value: bigint; data: Hex; operation: number };

function decodeMultiSend(packed: Hex, allowDelegatecall = false): Call[] {
  const calls: Call[] = [];
  let pos = 0;
  const len = size(packed);
  while (pos < len) {
    const operation = hexToNumber(slice(packed, pos, pos + 1));
    if (operation !== 0 && !(allowDelegatecall && operation === 1)) {
      throw new PolicyError("delegatecall inside multisend is not allowed");
    }
    const to = getAddress(slice(packed, pos + 1, pos + 21));
    const value = hexToBigInt(slice(packed, pos + 21, pos + 53));
    const dataLen = Number(hexToBigInt(slice(packed, pos + 53, pos + 85)));
    const data = dataLen === 0 ? "0x" : slice(packed, pos + 85, pos + 85 + dataLen);
    calls.push({ to, value, data, operation });
    pos += 85 + dataLen;
  }
  return calls;
}

export function decodeCalls(op: RpcUserOperation): Call[] {
  const { functionName, args } = decodeFunctionData({ abi: safe4337Abi, data: op.callData });
  if (functionName !== "executeUserOp" && functionName !== "executeUserOpWithErrorString") {
    throw new PolicyError("unexpected entry point");
  }
  const [to, value, data, operation] = args;
  if (operation === 0) return [{ to, value, data, operation }];
  if (operation === 1 && isAddressEqual(to, deployment.aa.multiSendCallOnly)) {
    const inner = decodeFunctionData({ abi: multiSendAbi, data });
    return decodeMultiSend(inner.args[0]);
  }
  throw new PolicyError("delegatecall is only allowed into MultiSendCallOnly");
}

export function checkCalls(op: RpcUserOperation) {
  const calls = decodeCalls(op);
  if (calls.length === 0) throw new PolicyError("no calls");
  for (const call of calls) {
    if (call.value !== 0n) throw new PolicyError("sending xDAI is not sponsored");
    const rule = allowed.find((r) =>
      r.target === "self" ? isAddressEqual(call.to, op.sender) : isAddressEqual(call.to, r.target),
    );
    if (!rule) throw new PolicyError(`calls to ${call.to} are not sponsored`);
    try {
      decodeFunctionData({ abi: rule.abi, data: call.data });
    } catch {
      throw new PolicyError(`this function on ${call.to} is not sponsored`);
    }
  }
  return calls;
}

/**
 * A sponsored deployment must be exactly the Safe the app creates: Safe 1.4.1, a single
 * passkey owner through the shared signer, the 4337 module as module and fallback handler,
 * the community RecoveryModule enabled, no payment, and nothing else run during setup.
 */
export function checkDeployment(op: RpcUserOperation) {
  if (!op.factory || !op.factoryData) return;
  const aa = deployment.aa;
  if (!isAddressEqual(op.factory, aa.safeProxyFactory)) throw new PolicyError("unknown factory");
  const [singleton, initializer] = decodeFunctionData({ abi: factoryAbi, data: op.factoryData }).args;
  if (!isAddressEqual(singleton, aa.safeSingleton)) throw new PolicyError("unknown Safe singleton");

  let setup;
  try {
    setup = decodeFunctionData({ abi: setupAbi, data: initializer }).args;
  } catch {
    throw new PolicyError("unexpected Safe setup");
  }
  const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] = setup;
  const bad =
    owners.length !== 1 ||
    !isAddressEqual(owners[0], aa.webAuthnSharedSigner) ||
    threshold !== 1n ||
    !isAddressEqual(to, aa.multiSend) ||
    !isAddressEqual(fallbackHandler, aa.safe4337Module) ||
    !isAddressEqual(paymentToken, zeroAddress) ||
    payment !== 0n ||
    !isAddressEqual(paymentReceiver, zeroAddress);
  if (bad) throw new PolicyError("unexpected Safe setup");

  const steps = decodeMultiSend(decodeFunctionData({ abi: multiSendAbi, data }).args[0], true);
  const [enable, configure] = steps;
  if (steps.length !== 2 || !enable || !configure) throw new PolicyError("unexpected Safe setup steps");

  if (enable.operation !== 1 || !isAddressEqual(enable.to, aa.safeModuleSetup)) throw new PolicyError("unexpected module setup");
  const [modules] = decodeFunctionData({ abi: enableModulesAbi, data: enable.data }).args;
  if (
    modules.length !== 2 ||
    !isAddressEqual(modules[0], aa.safe4337Module) ||
    !isAddressEqual(modules[1], deployment.recoveryModule)
  ) {
    throw new PolicyError("new Safes must enable the 4337 module and the community RecoveryModule");
  }

  if (configure.operation !== 1 || !isAddressEqual(configure.to, aa.webAuthnSharedSigner)) {
    throw new PolicyError("unexpected passkey setup");
  }
  const [signer] = decodeFunctionData({ abi: configureAbi, data: configure.data }).args;
  if (signer.verifiers !== BigInt(aa.p256Verifier)) throw new PolicyError("unexpected passkey verifier");
}

/** Caps so a member cannot request inflated gas prices or limits and pocket the difference. */
export const GAS_LIMITS = {
  callGasLimit: 1_500_000n,
  verificationGasLimit: 2_500_000n,
  preVerificationGas: 1_000_000n,
};

export function checkGas(
  op: RpcUserOperation & Partial<Record<"maxFeePerGas" | "maxPriorityFeePerGas" | keyof typeof GAS_LIMITS, Hex>>,
  price: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
) {
  const n = (h?: Hex) => (h ? BigInt(h) : 0n);
  if (n(op.maxFeePerGas) > price.maxFeePerGas * 2n) throw new PolicyError("gas price too high");
  if (n(op.maxPriorityFeePerGas) > price.maxPriorityFeePerGas * 2n) throw new PolicyError("priority fee too high");
  for (const [field, cap] of Object.entries(GAS_LIMITS) as [keyof typeof GAS_LIMITS, bigint][]) {
    if (n(op[field]) > cap) throw new PolicyError(`${field} too high`);
  }
}
