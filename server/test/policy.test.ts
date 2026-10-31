import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, encodeFunctionData, encodePacked, parseAbi, size, type Address, type Hex } from "viem";

process.env.DEPLOYMENT_FILE = new URL("./fixture-deployment.json", import.meta.url).pathname;
process.env.PIMLICO_API_KEY = "test";
process.env.RELAYER_PRIVATE_KEY = "0x" + "11".repeat(32);
process.env.ADMIN_TOKEN = "test";

const { checkCalls, checkDeployment, checkGas, findClaim, PolicyError } = await import("../src/policy.js");
const { deployment } = await import("../src/config.js");

const sender: Address = "0x000000000000000000000000000000000000cafe";
const execAbi = parseAbi(["function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)"]);
const erc20 = parseAbi(["function transfer(address to, uint256 value)", "function approve(address s, uint256 v)"]);
const safeAbi = parseAbi(["function addOwnerWithThreshold(address owner, uint256 threshold)", "function enableModule(address module)"]);
const dirAbi = parseAbi(["function setName(string name)"]);

const single = (to: Address, data: Hex, value = 0n) =>
  ({ sender, nonce: "0x0", callData: encodeFunctionData({ abi: execAbi, args: [to, value, data, 0] }) }) as const;

const batch = (calls: { to: Address; data: Hex; op?: number }[]) => {
  const packed = concat(
    calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [c.op ?? 0, c.to, 0n, BigInt(size(c.data)), c.data])),
  );
  const multi = encodeFunctionData({ abi: parseAbi(["function multiSend(bytes transactions)"]), args: [packed] });
  return { sender, nonce: "0x0", callData: encodeFunctionData({ abi: execAbi, args: [deployment.aa.multiSendCallOnly, 0n, multi, 1] }) } as const;
};

test("token transfer is sponsored", () => {
  checkCalls(single(deployment.token.address, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender, 1n] })));
});

test("approve is only sponsored for Invites, and unknown targets are refused", () => {
  assert.throws(() => checkCalls(single(deployment.token.address, encodeFunctionData({ abi: erc20, functionName: "approve", args: [sender, 1n] }))), PolicyError);
  checkCalls(single(deployment.token.address, encodeFunctionData({ abi: erc20, functionName: "approve", args: [deployment.invites, 1n] })));
  assert.throws(() => checkCalls(single("0x00000000000000000000000000000000000000aa", "0x")), PolicyError);
});

test("creating an invite is sponsored, and the claim is found in a signup batch", () => {
  const invitesAbi = parseAbi([
    "function create(address key, uint256 amount, uint64 expiresAt, bool openToMembers)",
    "function claim(address key, bytes signature)",
  ]);
  const key: Address = "0x00000000000000000000000000000000000000c1";
  const create = batch([
    { to: deployment.token.address, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [deployment.invites, 5n] }) },
    { to: deployment.invites, data: encodeFunctionData({ abi: invitesAbi, functionName: "create", args: [key, 5n, 1n, true] }) },
  ]);
  assert.equal(checkCalls(create).length, 2);
  assert.equal(findClaim(create), null);

  const signup = batch([
    { to: deployment.invites, data: encodeFunctionData({ abi: invitesAbi, functionName: "claim", args: [key, "0xabcd"] }) },
    { to: deployment.directory, data: encodeFunctionData({ abi: dirAbi, args: ["Joana"] }) },
  ]);
  checkCalls(signup);
  const claim = findClaim(signup);
  assert.equal(claim?.key.toLowerCase(), key);
  assert.equal(claim?.signature, "0xabcd");
  // A signup batch without a claim has nothing to show for the invite requirement.
  assert.equal(findClaim(batch([{ to: deployment.directory, data: encodeFunctionData({ abi: dirAbi, args: ["Joana"] }) }])), null);
});

test("sending xDAI is refused", () => {
  assert.throws(() => checkCalls(single(deployment.token.address, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender, 1n] }), 1n)), PolicyError);
});

test("device linking batch is sponsored, enableModule is not", () => {
  const ok = batch([
    { to: sender, data: encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: ["0x00000000000000000000000000000000000000bb", 1n] }) },
    { to: deployment.directory, data: encodeFunctionData({ abi: dirAbi, args: ["Joana"] }) },
  ]);
  assert.equal(checkCalls(ok).length, 2);
  const bad = batch([{ to: sender, data: encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: ["0x00000000000000000000000000000000000000bb"] }) }]);
  assert.throws(() => checkCalls(bad), PolicyError);
});

test("delegatecall inside the batch is refused", () => {
  const bad = batch([{ to: deployment.directory, data: encodeFunctionData({ abi: dirAbi, args: ["x"] }), op: 1 }]);
  assert.throws(() => checkCalls(bad), PolicyError);
});

test("only the app's exact Safe setup is sponsored for deployment", () => {
  const aa = deployment.aa;
  const factoryAbi = parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)"]);
  const setupAbi = parseAbi([
    "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  ]);
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const pack = (calls: { to: Address; data: Hex; op: number }[]) =>
    encodeFunctionData({
      abi: parseAbi(["function multiSend(bytes transactions)"]),
      args: [concat(calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [c.op, c.to, 0n, BigInt(size(c.data)), c.data])))],
    });
  const build = (opts: { modules?: Address[]; owner?: Address; fallback?: Address }) => {
    const enable = encodeFunctionData({ abi: parseAbi(["function enableModules(address[] modules)"]), args: [opts.modules ?? [aa.safe4337Module, deployment.recoveryModule]] });
    const configure = encodeFunctionData({
      abi: parseAbi(["function configure((uint256 x, uint256 y, uint176 verifiers) signer)"]),
      args: [{ x: 1n, y: 2n, verifiers: BigInt(aa.p256Verifier) }],
    });
    const setup = encodeFunctionData({
      abi: setupAbi,
      args: [[opts.owner ?? aa.webAuthnSharedSigner], 1n, aa.multiSend, pack([{ to: aa.safeModuleSetup, data: enable, op: 1 }, { to: aa.webAuthnSharedSigner, data: configure, op: 1 }]), opts.fallback ?? aa.safe4337Module, zero, 0n, zero],
    });
    return { sender, nonce: "0x0" as Hex, callData: "0x" as Hex, factory: aa.safeProxyFactory, factoryData: encodeFunctionData({ abi: factoryAbi, args: [aa.safeSingleton, setup, 0n] }) };
  };

  checkDeployment(build({}));
  assert.throws(() => checkDeployment(build({ modules: [aa.safe4337Module] })), PolicyError);
  assert.throws(() => checkDeployment(build({ owner: "0x00000000000000000000000000000000000000ee" })), PolicyError);
  assert.throws(() => checkDeployment(build({ fallback: "0x00000000000000000000000000000000000000ee" })), PolicyError);
});

test("inflated gas is refused", () => {
  const price = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
  const op = single(deployment.token.address, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender, 1n] }));
  checkGas({ ...op, maxFeePerGas: "0x7d0", maxPriorityFeePerGas: "0xc8", callGasLimit: "0x30d40" }, price);
  assert.throws(() => checkGas({ ...op, maxFeePerGas: "0x7d1" }, price), PolicyError);
  assert.throws(() => checkGas({ ...op, callGasLimit: "0xffffff" }, price), PolicyError);
});
