import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress, isAddress, isAddressEqual, toHex, zeroAddress, type Address, type Hex } from "viem";
import { getUserOperationReceipt, sendUserOperation } from "./bundler.js";
import { abis, config, deployment } from "./config.js";
import { poll, publicClient, startIndexer } from "./indexer.js";
import { PolicyError, checkCalls, checkDeployment, checkGas, findClaim, type RpcUserOperation } from "./policy.js";
import { subscribe } from "./push.js";
import { RelayError, executeDueRecoveries, refundExpiredInvites, relayTransfer, relayerAddress, type RelayRequest } from "./relay.js";
import { consume, isMember, save, saveNow, state } from "./store.js";
import { refreshWallets, safeOfWallet, walletNames, walletsOf } from "./wallets.js";

const app = new Hono();
// ALLOWED_ORIGIN: "*" or a comma-separated list, e.g. the PWA's domain plus http://localhost:5173.
const origins = config.allowedOrigin === "*" ? "*" : config.allowedOrigin.split(",").map((o) => o.trim());
app.use("*", cors({ origin: origins }));

// ------------------------------------------------------------------ JSON-RPC: bundler + paymaster
const BUNDLER_METHODS = new Set([
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
]);
const PAYMASTER_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);

type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown[] };

async function forward(req: RpcRequest) {
  const res = await fetch(config.pimlicoUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (json.error) console.warn(`upstream ${req.method}: ${json.error.message}`);
  return json;
}

const rpcError = (id: RpcRequest["id"], message: string, code = -32000) => ({ jsonrpc: "2.0", id, error: { code, message } });

type GasTier = { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type GasPriceResponse = { result?: Record<"slow" | "standard" | "fast", GasTier>; error?: { message: string } };

// Pimlico's gas price oracle fails on Chiado (base fee ~7 wei, tips mostly 0). Fall back to the
// node's estimate, with a floor so the operation still gets bundled.
const MIN_PRIORITY_FEE = 1_000_000_000n;
let warnedGasFallback = false;
async function userOpGasPrice(id: RpcRequest["id"]): Promise<GasPriceResponse> {
  const res = (await forward({ jsonrpc: "2.0", id, method: "pimlico_getUserOperationGasPrice", params: [] })) as GasPriceResponse;
  if (res.result) return res;
  if (!warnedGasFallback) {
    console.warn(`pimlico_getUserOperationGasPrice failed (${res.error?.message}), using node fees`);
    warnedGasFallback = true;
  }
  const fees = await publicClient.estimateFeesPerGas();
  const priority = fees.maxPriorityFeePerGas > MIN_PRIORITY_FEE ? fees.maxPriorityFeePerGas : MIN_PRIORITY_FEE;
  const tier = { maxFeePerGas: toHex(fees.maxFeePerGas + priority), maxPriorityFeePerGas: toHex(priority) };
  return { ...res, result: { slow: tier, standard: tier, fast: tier }, error: undefined };
}

// Pimlico estimates verification gas with a placeholder signature, before Face ID. Checking a
// real passkey through a SafeWebAuthnSignerProxy (a linked or recovered device) costs more than
// that estimate (~420k gas vs ~410k estimated): validation ran out of gas inside the Safe's
// checkSignatures and the module reported "AA24 signature error". Unused verification gas is not
// charged under EntryPoint 0.7, so the headroom costs nothing.
const VERIFICATION_HEADROOM = 250_000n;
function withVerificationHeadroom(res: { result?: { verificationGasLimit?: Hex } }) {
  if (res.result?.verificationGasLimit) {
    res.result.verificationGasLimit = toHex(BigInt(res.result.verificationGasLimit) + VERIFICATION_HEADROOM);
  }
  return res;
}

// Current gas price, to refuse operations that ask the paymaster for inflated fees.
let gasPrice: { at: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
async function currentGasPrice() {
  if (gasPrice && Date.now() - gasPrice.at < 20_000) return gasPrice;
  const res = (await userOpGasPrice(0)) as Required<GasPriceResponse>;
  gasPrice = {
    at: Date.now(),
    maxFeePerGas: BigInt(res.result.fast.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(res.result.fast.maxPriorityFeePerGas),
  };
  return gasPrice;
}

/** Members joined through Invites; the chain answers when the indexer has not caught up yet. */
async function isMemberNow(account: string): Promise<boolean> {
  if (isMember(account)) return true;
  const joined = (await publicClient.readContract({
    address: deployment.invites,
    abi: abis.Invites,
    functionName: "joined",
    args: [account as Address],
  })) as boolean;
  if (joined) {
    state.members[account] ??= { joinedAt: Date.now() };
    saveNow();
  }
  return joined;
}

async function requireClaimable(op: RpcUserOperation, missing = "a valid invite is needed to create an account") {
  const claim = findClaim(op);
  if (!claim) throw new PolicyError(missing);
  const claimable = await publicClient.readContract({
    address: deployment.invites,
    abi: abis.Invites,
    functionName: "claimable",
    args: [claim.key, op.sender, claim.signature],
  });
  if (!claimable) throw new PolicyError("this invite is not valid anymore: expired, used, or not for this account");
}

async function sponsor(req: RpcRequest) {
  const [op, entryPoint] = (req.params ?? []) as [RpcUserOperation, Address];
  if (!op?.sender) throw new PolicyError("missing user operation");
  if (!isAddressEqual(entryPoint, deployment.aa.entryPoint)) throw new PolicyError("unsupported EntryPoint");
  const sender = op.sender.toLowerCase();
  const final = req.method === "pm_getPaymasterData";

  if (op.factory) {
    checkDeployment(op);
    // The new account's first batch claims an invite. The claim runs in the transaction that
    // creates the Safe, so the invite is spent only if the account really gets created.
    await requireClaimable(op);
  } else if (!(await isMemberNow(sender))) {
    // A Safe can exist without membership if its claim reverted after deployment (the invite
    // expired or ran out of uses in between). Let it retry with a claim that works now.
    await requireClaimable(op, "only community members are sponsored");
  }

  checkCalls(op);
  if (final) {
    checkGas(op, await currentGasPrice());
    if (!consume(sender, "ops", config.maxOpsPerDay)) throw new PolicyError("daily limit reached, try tomorrow");
  }

  const upstreamContext = config.sponsorshipPolicyId ? { sponsorshipPolicyId: config.sponsorshipPolicyId } : {};
  return forward({ ...req, params: [op, entryPoint, req.params?.[2], upstreamContext] });
}

app.post("/rpc", async (c) => {
  const body = (await c.req.json()) as RpcRequest | RpcRequest[];
  const handle = async (req: RpcRequest) => {
    try {
      if (PAYMASTER_METHODS.has(req.method)) return await sponsor(req);
      if (req.method === "pimlico_getUserOperationGasPrice") return await userOpGasPrice(req.id);
      if (req.method === "eth_estimateUserOperationGas") {
        return withVerificationHeadroom((await forward(req)) as { result?: { verificationGasLimit?: Hex } });
      }
      if (req.method === "eth_sendUserOperation") {
        const [op, entryPoint] = (req.params ?? []) as [RpcUserOperation, Address];
        return { jsonrpc: "2.0", id: req.id, result: await sendUserOperation(op, entryPoint) };
      }
      if (req.method === "eth_getUserOperationReceipt") {
        const [hash] = (req.params ?? []) as [Hex];
        return { jsonrpc: "2.0", id: req.id, result: await getUserOperationReceipt(hash) };
      }
      if (BUNDLER_METHODS.has(req.method)) return await forward(req);
      return rpcError(req.id, `method ${req.method} not supported`, -32601);
    } catch (err) {
      const message = err instanceof PolicyError ? err.message : "internal error";
      if (!(err instanceof PolicyError)) console.error(err);
      return rpcError(req.id, message);
    }
  };
  return c.json(Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body));
});

// ------------------------------------------------------------------ public reads
app.get("/config", (c) =>
  c.json({ chainId: config.chainId, vapidPublicKey: config.vapid?.publicKey ?? null, relayer: relayerAddress }),
);

app.get("/directory", (c) => {
  const members = Object.keys(state.members).map((address) => ({
    address: getAddress(address),
    name: state.index.names[address] ?? null,
    wallets: walletsOf(address),
  }));
  members.sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~"));
  return c.json(members);
});

app.get("/credential/:hash", (c) => {
  const hash = c.req.param("hash").toLowerCase();
  return c.json(state.index.credentials.filter((x) => x.credentialHash === hash));
});

// Coins locked into or returned from an invite move through the Invites contract, and members'
// backup wallets show as "name (carteira)".
const names = () => ({ ...walletNames(), ...state.index.names, [deployment.invites.toLowerCase()]: "Convites" });

/** The member account a backup wallet belongs to (the app re-checks ownership on-chain). */
app.get("/wallet/:address", (c) => {
  const safe = safeOfWallet(c.req.param("address"));
  return c.json(safe ? { safe: getAddress(safe), name: state.index.names[safe] ?? null } : null);
});

app.get("/activity/:address", (c) => {
  const a = c.req.param("address").toLowerCase();
  const items = state.index.activity.filter((x) => x.from === a || x.to === a).slice(-100).reverse();
  return c.json({ names: names(), items, indexedBlock: state.index.lastBlock });
});

app.get("/invite/:key", (c) => {
  const invite = state.index.invites[c.req.param("key").toLowerCase()] ?? null;
  const creatorName = invite ? (invite.minting ? "Banco central" : (state.index.names[invite.creator] ?? null)) : null;
  return c.json({ invite, creatorName });
});

app.get("/invites/by/:creator", (c) => {
  const creator = c.req.param("creator").toLowerCase();
  return c.json(Object.values(state.index.invites).filter((x) => x.creator === creator).sort((x, y) => y.block - x.block));
});

app.get("/recoveries/:safe", (c) => {
  const safe = c.req.param("safe").toLowerCase();
  return c.json(state.index.recoveries.filter((r) => r.safe === safe));
});

app.get("/recovered-by/:owner", (c) => {
  const owner = c.req.param("owner").toLowerCase();
  return c.json(state.index.recoveries.filter((r) => r.kind === "executed" && r.newOwner === owner));
});

/** Every member, and anything else holding coins, with its balance as indexed from the chain. */
function balances() {
  const total = new Map<string, bigint>(Object.keys(state.members).map((m) => [m, 0n]));
  const add = (a: string, v: bigint) => total.set(a, (total.get(a) ?? 0n) + v);
  for (const x of state.index.activity) {
    const v = BigInt(x.value);
    if (x.kind !== "mint") add(x.from, -v);
    if (x.kind !== "confiscation") add(x.to, v);
  }
  total.delete(zeroAddress);
  return [...total]
    .filter(([a, v]) => v > 0n || state.members[a])
    .sort(([, x], [, y]) => (y > x ? 1 : y < x ? -1 : 0))
    .map(([address, v]) => ({ address, balance: v.toString(), wallets: walletsOf(address) }));
}

app.get("/transparency", (c) =>
  c.json({
    accounts: balances(),
    names: names(),
    mints: state.index.activity.filter((x) => x.kind === "mint").slice(-200).reverse(),
    enforcement: state.index.activity.filter((x) => x.kind === "confiscation" || x.kind === "forced").slice(-200).reverse(),
    recoveries: [...state.index.recoveries].reverse(),
    indexedBlock: state.index.lastBlock,
  }),
);

// ------------------------------------------------------------------ writes
app.post("/push/subscribe", async (c) => {
  const { safe, subscription } = await c.req.json();
  if (!isAddress(safe, { strict: false }) || !subscription?.endpoint) return c.json({ error: "bad request" }, 400);
  if (!isMember(safe)) return c.json({ error: "not a member" }, 403);
  subscribe(safe, subscription);
  return c.json({ ok: true });
});

app.post("/relay/transfer", async (c) => {
  try {
    const hash = await relayTransfer((await c.req.json()) as RelayRequest);
    return c.json({ hash });
  } catch (err) {
    const message = err instanceof RelayError ? err.message : (err as Error).message.split("\n")[0];
    return c.json({ error: message }, 400);
  }
});

// ------------------------------------------------------------------ admin (central bank operator)
app.use("/admin/*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${config.adminToken}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

/** Register an external wallet as a member (EIP-3009 relays). Safes join through Invites. */
app.post("/admin/members", async (c) => {
  const { address } = await c.req.json();
  if (!isAddress(address, { strict: false })) return c.json({ error: "bad address" }, 400);
  state.members[address.toLowerCase()] ??= { joinedAt: Date.now() };
  saveNow();
  return c.json({ ok: true });
});

app.delete("/admin/members/:address", (c) => {
  delete state.members[c.req.param("address").toLowerCase()];
  saveNow();
  return c.json({ ok: true });
});

app.post("/admin/reindex", async (c) => {
  await poll();
  return c.json({ lastBlock: state.index.lastBlock });
});

startIndexer();
setInterval(() => void executeDueRecoveries(), 60_000);
setInterval(() => void refundExpiredInvites(), 60_000);
void refreshWallets().catch((err) => console.warn("wallets:", (err as Error).message));
setInterval(() => void refreshWallets().catch((err) => console.warn("wallets:", (err as Error).message)), 60_000);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Community coin server on :${info.port} (chain ${config.chainId}, relayer ${relayerAddress})`);
});
