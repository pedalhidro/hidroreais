import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, isAddressEqual, toHex, type Address, type Hex } from "viem";
import { getUserOperationReceipt, sendUserOperation } from "./bundler.js";
import { config, deployment } from "./config.js";
import { poll, publicClient, startIndexer } from "./indexer.js";
import { PolicyError, checkCalls, checkDeployment, checkGas, type RpcUserOperation } from "./policy.js";
import { subscribe } from "./push.js";
import { RelayError, executeDueRecoveries, relayTransfer, relayerAddress, type RelayRequest } from "./relay.js";
import { consume, isMember, save, saveNow, state } from "./store.js";

const app = new Hono();
app.use("*", cors({ origin: config.allowedOrigin }));

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

const isDeployed = async (a: string) => ((await publicClient.getCode({ address: a as Address })) ?? "0x") !== "0x";

/** Turns an invite's pending signup into a member once the Safe exists on-chain. */
async function settleInvite(code: string): Promise<void> {
  const invite = state.invites[code];
  if (!invite?.pending || invite.usedBy) return;
  if (await isDeployed(invite.pending)) {
    invite.usedBy = invite.pending;
    state.members[invite.pending] ??= { joinedAt: Date.now(), invite: code };
    delete invite.pending;
    saveNow();
  }
}

async function settleAllInvites() {
  for (const code of Object.keys(state.invites)) await settleInvite(code).catch(() => {});
}

async function sponsor(req: RpcRequest) {
  const [op, entryPoint, , context] = (req.params ?? []) as [RpcUserOperation, Address, string, { invite?: string } | null];
  if (!op?.sender) throw new PolicyError("missing user operation");
  if (!isAddressEqual(entryPoint, deployment.aa.entryPoint)) throw new PolicyError("unsupported EntryPoint");
  const sender = op.sender.toLowerCase();
  const final = req.method === "pm_getPaymasterData";

  if (op.factory) {
    checkDeployment(op);
    const code = context?.invite?.trim();
    if (!code || !state.invites[code]) throw new PolicyError("a valid invite is needed to create an account");
    await settleInvite(code);
    const invite = state.invites[code]!;
    if (invite.usedBy) throw new PolicyError("this invite was already used");
    // The invite is only spent once the Safe is actually deployed, so a cancelled
    // passkey prompt or a failed first attempt does not burn it.
    if (final) {
      invite.pending = sender;
      saveNow();
    }
  } else if (!isMember(sender)) {
    const code = Object.keys(state.invites).find((c) => state.invites[c]!.pending === sender);
    if (code) await settleInvite(code);
    if (!isMember(sender)) throw new PolicyError("only community members are sponsored");
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
  }));
  members.sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~"));
  return c.json(members);
});

app.get("/credential/:hash", (c) => {
  const hash = c.req.param("hash").toLowerCase();
  return c.json(state.index.credentials.filter((x) => x.credentialHash === hash));
});

app.get("/activity/:address", (c) => {
  const a = c.req.param("address").toLowerCase();
  const items = state.index.activity.filter((x) => x.from === a || x.to === a).slice(-100).reverse();
  return c.json({ names: state.index.names, items, indexedBlock: state.index.lastBlock });
});

app.get("/recoveries/:safe", (c) => {
  const safe = c.req.param("safe").toLowerCase();
  return c.json(state.index.recoveries.filter((r) => r.safe === safe));
});

app.get("/recovered-by/:owner", (c) => {
  const owner = c.req.param("owner").toLowerCase();
  return c.json(state.index.recoveries.filter((r) => r.kind === "executed" && r.newOwner === owner));
});

app.get("/transparency", (c) =>
  c.json({
    names: state.index.names,
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

app.post("/admin/invites", async (c) => {
  const { count = 1, note } = (await c.req.json().catch(() => ({}))) as { count?: number; note?: string };
  // Hex, not base64url: WhatsApp and Markdown linkifiers drop a trailing "_" or "-" from the link.
  const codes = Array.from({ length: Math.min(Number(count), 200) }, () => randomBytes(8).toString("hex"));
  for (const code of codes) state.invites[code] = { createdAt: Date.now(), note };
  saveNow();
  return c.json({ codes });
});

app.get("/admin/invites", (c) => c.json(state.invites));

/** Register an existing Safe or an external wallet as a sponsored member. */
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
setInterval(() => void settleAllInvites(), 15_000);
setInterval(() => void executeDueRecoveries(), 60_000);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Community coin server on :${info.port} (chain ${config.chainId}, relayer ${relayerAddress})`);
});
