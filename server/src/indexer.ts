/**
 * Polls the chain for the community's events and keeps a small index in the store:
 * names, passkey credentials, transfers and mints, recoveries. The PWA reads this index
 * instead of scanning logs itself, and verifies anything security-relevant on-chain.
 */
import { createPublicClient, getAbiItem, http, zeroAddress, type AbiEvent, type Log } from "viem";
import { abis, config, deployment } from "./config.js";
import { notify } from "./push.js";
import { save, state } from "./store.js";

export const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });

const ev = (abi: keyof typeof abis, name: string) => getAbiItem({ abi: abis[abi], name }) as AbiEvent;
const transfer = ev("CommunityToken", "Transfer");
const nameSet = ev("MemberDirectory", "NameSet");
const credentialLinked = ev("MemberDirectory", "CredentialLinked");
const recInitiated = ev("RecoveryModule", "RecoveryInitiated");
const recExecuted = ev("RecoveryModule", "RecoveryExecuted");
const recCancelled = ev("RecoveryModule", "RecoveryCancelled");

type DecodedLog = Log<bigint, number, false, AbiEvent, true> & { args: Record<string, unknown>; eventName: string };

const symbol = deployment.token.symbol;
const fmt = (wei: bigint) => {
  const s = (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${s} ${symbol}`;
};
const nameOf = (a: string) => state.index.names[a.toLowerCase()] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;

// Only push notifications for fresh events, not while catching up on history.
let live = false;
const push = (to: string, title: string, body: string) => {
  if (live) notify(to, title, body);
};

function handle(log: DecodedLog) {
  const tx = log.transactionHash;
  const block = Number(log.blockNumber);
  const a = log.args;
  switch (log.eventName) {
    case "Transfer": {
      const from = String(a.from).toLowerCase();
      const to = String(a.to).toLowerCase();
      const value = a.value as bigint;
      state.index.activity.push({ kind: from === zeroAddress ? "mint" : "transfer", from, to, value: value.toString(), tx, block });
      if (from === zeroAddress) push(to, "New coins", `The central bank sent you ${fmt(value)}`);
      else push(to, "Payment received", `${nameOf(from)} sent you ${fmt(value)}`);
      break;
    }
    case "NameSet":
      state.index.names[String(a.safe).toLowerCase()] = String(a.name);
      break;
    case "CredentialLinked":
      state.index.credentials.push({
        credentialHash: String(a.credentialHash).toLowerCase(),
        safe: String(a.safe).toLowerCase(),
        signer: String(a.signer).toLowerCase(),
        x: (a.x as bigint).toString(),
        y: (a.y as bigint).toString(),
        block,
      });
      break;
    case "RecoveryInitiated": {
      const safe = String(a.safe).toLowerCase();
      const executeAfter = Number(a.executeAfter);
      state.index.recoveries.push({
        kind: "initiated", safe, newOwner: String(a.newOwner).toLowerCase(), removeOthers: Boolean(a.removeOthers), executeAfter, tx, block,
      });
      push(safe, "Account recovery requested", `The central bank started a recovery of your account. If you did not ask for this, open the app and cancel it before ${new Date(executeAfter * 1000).toLocaleString()}.`);
      break;
    }
    case "RecoveryExecuted": {
      const safe = String(a.safe).toLowerCase();
      state.index.recoveries.push({ kind: "executed", safe, newOwner: String(a.newOwner).toLowerCase(), removeOthers: Boolean(a.removeOthers), tx, block });
      push(safe, "Account recovered", "A new passkey was added to your account by the central bank.");
      break;
    }
    case "RecoveryCancelled":
      state.index.recoveries.push({ kind: "cancelled", safe: String(a.safe).toLowerCase(), tx, block });
      break;
  }
}

async function fetchRange(fromBlock: bigint, toBlock: bigint) {
  const [token, directory, recovery] = await Promise.all([
    publicClient.getLogs({ address: deployment.token.address, events: [transfer], fromBlock, toBlock, strict: true }),
    publicClient.getLogs({ address: deployment.directory, events: [nameSet, credentialLinked], fromBlock, toBlock, strict: true }),
    publicClient.getLogs({ address: deployment.recoveryModule, events: [recInitiated, recExecuted, recCancelled], fromBlock, toBlock, strict: true }),
  ]);
  const all = [...token, ...directory, ...recovery] as unknown as DecodedLog[];
  all.sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex);
  return all;
}

let running = false;
export async function poll() {
  if (running) return;
  running = true;
  try {
    const latest = await publicClient.getBlockNumber();
    let from = BigInt(Math.max(state.index.lastBlock + 1, deployment.startBlock));
    while (from <= latest) {
      const to = from + config.logChunk - 1n < latest ? from + config.logChunk - 1n : latest;
      live = latest - to < 200n;
      for (const log of await fetchRange(from, to)) handle(log);
      state.index.lastBlock = Number(to);
      save();
      from = to + 1n;
    }
  } catch (err) {
    console.error("indexer:", (err as Error).message);
  } finally {
    running = false;
  }
}

export function startIndexer() {
  void poll();
  setInterval(() => void poll(), config.pollMs);
}
