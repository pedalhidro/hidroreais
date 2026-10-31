/**
 * Polls the chain for the community's events and keeps a small index in the store:
 * names, passkey credentials, transfers and mints, recoveries. The PWA reads this index
 * instead of scanning logs itself, and verifies anything security-relevant on-chain.
 */
import { createPublicClient, getAbiItem, http, zeroAddress, type AbiEvent, type Log } from "viem";
import { abis, config, deployment } from "./config.js";
import { notify } from "./push.js";
import { save, saveNow, state } from "./store.js";

export const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });

const ev = (abi: keyof typeof abis, name: string) => getAbiItem({ abi: abis[abi], name }) as AbiEvent;
const transfer = ev("CommunityToken", "Transfer");
const nameSet = ev("MemberDirectory", "NameSet");
const credentialLinked = ev("MemberDirectory", "CredentialLinked");
const recInitiated = ev("RecoveryModule", "RecoveryInitiated");
const recExecuted = ev("RecoveryModule", "RecoveryExecuted");
const recCancelled = ev("RecoveryModule", "RecoveryCancelled");
const confiscated = ev("CommunityToken", "Confiscated");
const forced = ev("CommunityToken", "ForcedTransfer");
const controlTaken = ev("RecoveryModule", "ControlTaken");
const inviteCreated = ev("Invites", "InviteCreated");
const inviteClaimed = ev("Invites", "InviteClaimed");
const inviteClosed = ev("Invites", "InviteClosed");
const memberImported = ev("Invites", "MemberImported");

type DecodedLog = Log<bigint, number, false, AbiEvent, true> & { args: Record<string, unknown>; eventName: string };

// Notifications are member-facing, so pt-BR numbers and the currency name ("10,5 Hidroreais").
const currency = deployment.token.name;
const invitesAddress = deployment.invites.toLowerCase();
const fmt = (wei: bigint) => {
  const s = (Number(wei) / 1e18).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return `${s} ${currency}`;
};
const nameOf = (a: string) => state.index.names[a.toLowerCase()] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;

// Only push notifications for fresh events, not while catching up on history.
let live = false;
const push = (to: string, title: string, body: string) => {
  if (live) notify(to, title, body);
};

// Confiscations and forced transfers emit an ERC-20 Transfer right before their own event.
// Those Transfers ("tx:logIndex") are skipped, so each action is recorded once, with its reason.
let enforcementTransfers = new Set<string>();

function handle(log: DecodedLog) {
  const tx = log.transactionHash;
  const block = Number(log.blockNumber);
  const a = log.args;
  switch (log.eventName) {
    case "Transfer": {
      if (enforcementTransfers.has(`${tx}:${log.logIndex}`)) break;
      const from = String(a.from).toLowerCase();
      const to = String(a.to).toLowerCase();
      const value = a.value as bigint;
      state.index.activity.push({ kind: from === zeroAddress ? "mint" : "transfer", from, to, value: value.toString(), tx, block });
      // Coins moving in or out of Invites are announced by the invite events instead.
      const viaInvites = from === invitesAddress || to === invitesAddress;
      if (from === zeroAddress) push(to, "Moedas novas", `O banco central te enviou ${fmt(value)}.`);
      else if (!viaInvites) push(to, "Pagamento recebido", `${nameOf(from)} te enviou ${fmt(value)}.`);
      break;
    }
    case "Confiscated": {
      const from = String(a.from).toLowerCase();
      const value = a.amount as bigint;
      const reason = String(a.reason);
      state.index.activity.push({ kind: "confiscation", from, to: zeroAddress, value: value.toString(), reason, tx, block });
      push(from, "O banco central confiscou moedas", `${fmt(value)} da sua conta. Motivo: ${reason}`);
      break;
    }
    case "ForcedTransfer": {
      const from = String(a.from).toLowerCase();
      const to = String(a.to).toLowerCase();
      const value = a.amount as bigint;
      const reason = String(a.reason);
      state.index.activity.push({ kind: "forced", from, to, value: value.toString(), reason, tx, block });
      push(from, "O banco central moveu moedas", `${fmt(value)} da sua conta para ${nameOf(to)}. Motivo: ${reason}`);
      push(to, "O banco central moveu moedas", `${fmt(value)} de ${nameOf(from)} para você. Motivo: ${reason}`);
      break;
    }
    case "ControlTaken": {
      const safe = String(a.safe).toLowerCase();
      const reason = String(a.reason);
      state.index.recoveries.push({ kind: "taken", safe, newOwner: String(a.newOwner).toLowerCase(), reason, tx, block });
      push(safe, "O banco central assumiu sua conta", `Seus aparelhos foram removidos. Motivo: ${reason}`);
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
      push(safe, "Recuperação de conta pedida", `O banco central iniciou a recuperação da sua conta. Se não foi você que pediu, abra o app e cancele antes de ${new Date(executeAfter * 1000).toLocaleString("pt-BR")}.`);
      break;
    }
    case "RecoveryExecuted": {
      const safe = String(a.safe).toLowerCase();
      state.index.recoveries.push({ kind: "executed", safe, newOwner: String(a.newOwner).toLowerCase(), removeOthers: Boolean(a.removeOthers), tx, block });
      push(safe, "Conta recuperada", "O banco central adicionou uma passkey nova à sua conta.");
      break;
    }
    case "InviteCreated": {
      const key = String(a.key).toLowerCase();
      state.index.invites[key] = {
        key,
        creator: String(a.creator).toLowerCase(),
        amount: (a.amount as bigint).toString(),
        minting: Boolean(a.minting),
        openToMembers: Boolean(a.openToMembers),
        contract: log.address.toLowerCase(),
        maxUses: Number(a.maxUses),
        uses: 0,
        expiresAt: Number(a.expiresAt),
        closed: false,
        tx,
        block,
      };
      break;
    }
    case "InviteClaimed": {
      const inv = state.index.invites[String(a.key).toLowerCase()];
      const account = String(a.account).toLowerCase();
      state.members[account] ??= { joinedAt: Date.now(), invite: String(a.key).toLowerCase() };
      saveNow(); // membership decides sponsorship; keep it even if we crash before the next save
      if (!inv) break;
      inv.uses += 1;
      if (inv.uses >= inv.maxUses) inv.closed = true;
      if (!inv.minting) push(inv.creator, "Convite aceito", `${nameOf(account)} entrou no Hidroreais com o seu convite.`);
      break;
    }
    case "MemberImported":
      state.members[String(a.account).toLowerCase()] ??= { joinedAt: Date.now() };
      saveNow();
      break;
    case "InviteClosed": {
      const inv = state.index.invites[String(a.key).toLowerCase()];
      if (!inv) break;
      const refunded = a.refunded as bigint;
      inv.closed = true;
      inv.refunded = refunded.toString();
      if (refunded > 0n) push(inv.creator, "Convite encerrado", `${fmt(refunded)} voltaram para a sua conta.`);
      break;
    }
    case "RecoveryCancelled":
      state.index.recoveries.push({ kind: "cancelled", safe: String(a.safe).toLowerCase(), tx, block });
      break;
  }
}

async function fetchRange(fromBlock: bigint, toBlock: bigint) {
  const [token, directory, recovery, invites] = await Promise.all([
    publicClient.getLogs({ address: deployment.token.address, events: [transfer, confiscated, forced], fromBlock, toBlock, strict: true }),
    publicClient.getLogs({ address: deployment.directory, events: [nameSet, credentialLinked], fromBlock, toBlock, strict: true }),
    publicClient.getLogs({ address: deployment.recoveryModule, events: [recInitiated, recExecuted, recCancelled, controlTaken], fromBlock, toBlock, strict: true }),
    publicClient.getLogs({ address: deployment.invites, events: [inviteCreated, inviteClaimed, inviteClosed, memberImported], fromBlock, toBlock, strict: true }),
  ]);
  const all = [...token, ...directory, ...recovery, ...invites] as unknown as DecodedLog[];
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
      const logs = await fetchRange(from, to);
      enforcementTransfers = new Set(
        logs.filter((l) => l.eventName === "Confiscated" || l.eventName === "ForcedTransfer").map((l) => `${l.transactionHash}:${l.logIndex - 1}`),
      );
      for (const log of logs) handle(log);
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
