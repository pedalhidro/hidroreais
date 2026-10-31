import { useEffect, useMemo, useState } from "preact/hooks";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { Notice, Screen } from "../components/ui";
import { chain, deployment, p256Verifiers, recoveryAbi, currency, tokenAbi } from "../config";
import { api, recoveryDelay, signerFactoryAbi, signerFor, type Member } from "../lib/chain";
import { friendlyError, parseAmount, short } from "../lib/format";
import { decodeDevice } from "../lib/links";
import { fromPublicKey } from "../lib/passkey";
import type { Route } from "../lib/router";

type Call = { to: Address; data: Hex; label: string };

/**
 * Central bank console. It never holds keys: it prepares the calls and either
 *  - downloads them as a batch for the Safe Transaction Builder (bank is a Safe), or
 *  - sends them from a connected wallet (bank is a test EOA during testing).
 */
export function Bank({ route }: { route: Route }) {
  const recoverParam = route.query.get("recover");
  const [tab, setTab] = useState<"mint" | "enforce" | "recover" | "settings">(recoverParam ? "recover" : "mint");
  const [members, setMembers] = useState<Member[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  useEffect(() => {
    api.directory().then(setMembers).catch(() => {});
  }, []);

  return (
    <Screen title="Banco central" back="/">
      <p class="fine">
        Banco central: {short(deployment.bank)}. Esta página só prepara as operações; quem assina são os membros do
        banco.
      </p>
      <div class="tabs" role="tablist">
        {(
          [
            ["mint", "Emitir"],
            ["enforce", "Fiscalizar"],
            ["recover", "Recuperar"],
            ["settings", "Ajustes"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            class={tab === key ? "tab tab-on" : "tab"}
            onClick={() => {
              setTab(key);
              setCalls([]);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "mint" && <MintForm members={members} onCalls={setCalls} />}
      {tab === "enforce" && <EnforceForm members={members} onCalls={setCalls} />}
      {tab === "recover" && <RecoverForm members={members} param={recoverParam} onCalls={setCalls} />}
      {tab === "settings" && <SettingsForm onCalls={setCalls} />}
      {calls.length > 0 && <Execute calls={calls} />}
    </Screen>
  );
}

function MemberPicker(props: { members: Member[]; value: string; onChange: (a: string) => void; label: string }) {
  const [q, setQ] = useState("");
  const list = useMemo(
    () => props.members.filter((m) => !q || (m.name ?? "").toLowerCase().includes(q.toLowerCase())).slice(0, 8),
    [props.members, q],
  );
  const selected = props.members.find((m) => m.address.toLowerCase() === props.value.toLowerCase());
  return (
    <div class="field">
      <span>{props.label}</span>
      <input type="search" placeholder="Buscar membro pelo nome" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <ul class="people people-compact">
        {list.map((m) => (
          <li key={m.address}>
            <button type="button" class={m.address === selected?.address ? "picked" : ""} onClick={() => props.onChange(m.address)}>
              {m.name ?? short(m.address)}
            </button>
          </li>
        ))}
      </ul>
      <input
        placeholder="ou cole um endereço 0x…"
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value.trim())}
      />
    </div>
  );
}

function MintForm({ members, onCalls }: { members: Member[]; onCalls: (c: Call[]) => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const value = parseAmount(amount);
  const ok = isAddress(to, { strict: false }) && value;
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || !value) return;
        onCalls([
          {
            to: deployment.token.address,
            data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [getAddress(to), value] }),
            label: `Emitir ${amount} ${currency} para ${short(to)}`,
          },
        ]);
      }}
    >
      <MemberPicker members={members} value={to} onChange={setTo} label="Para quem" />
      <label class="field">
        <span>Quantidade em {currency}</span>
        <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
      </label>
      <button class="btn btn-primary" disabled={!ok}>
        Preparar emissão
      </button>
    </form>
  );
}

const enforceActions = {
  confiscate: "Confiscar",
  transfer: "Transferir à força",
  takeover: "Tomar a conta",
} as const;

/** Coercive actions. Each one is public on the transparency page, with the reason given here. */
function EnforceForm({ members, onCalls }: { members: Member[]; onCalls: (c: Call[]) => void }) {
  const [action, setAction] = useState<keyof typeof enforceActions>("confiscate");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [newOwner, setNewOwner] = useState<string>(deployment.bank);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const value = parseAmount(amount);
  const why = reason.trim();
  const ok =
    isAddress(from, { strict: false }) &&
    why.length > 0 &&
    (action === "confiscate"
      ? !!value
      : action === "transfer"
        ? !!value && isAddress(to, { strict: false })
        : isAddress(newOwner, { strict: false }));

  function prepare() {
    if (!ok) return;
    const target = getAddress(from);
    if (action === "confiscate") {
      return onCalls([
        {
          to: deployment.token.address,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "confiscate", args: [target, value!, why] }),
          label: `Confiscar ${amount} ${currency} de ${short(from)}. Motivo: ${why}`,
        },
      ]);
    }
    if (action === "transfer") {
      return onCalls([
        {
          to: deployment.token.address,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "forceTransfer", args: [target, getAddress(to), value!, why] }),
          label: `Transferir ${amount} ${currency} de ${short(from)} para ${short(to)}. Motivo: ${why}`,
        },
      ]);
    }
    onCalls([
      {
        to: deployment.recoveryModule,
        data: encodeFunctionData({ abi: recoveryAbi, functionName: "takeControl", args: [target, getAddress(newOwner), why] }),
        label: `Tomar a conta ${short(from)}, deixando ${short(newOwner)} como único dono. Motivo: ${why}`,
      },
    ]);
  }

  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        prepare();
      }}
    >
      <Notice>Tudo o que for feito aqui aparece na página de transparência, com o motivo, e o membro recebe um aviso.</Notice>
      <div class="stack" role="radiogroup" aria-label="Ação">
        {(Object.keys(enforceActions) as (keyof typeof enforceActions)[]).map((key) => (
          <label class="check" key={key}>
            <input type="radio" name="action" checked={action === key} onChange={() => setAction(key)} />
            {enforceActions[key]}
          </label>
        ))}
      </div>
      <MemberPicker members={members} value={from} onChange={setFrom} label={action === "takeover" ? "Conta" : "De quem"} />
      {action === "transfer" && <MemberPicker members={members} value={to} onChange={setTo} label="Para quem" />}
      {action === "takeover" ? (
        <>
          <label class="field">
            <span>Novo único dono da conta</span>
            <input value={newOwner} onInput={(e) => setNewOwner(e.currentTarget.value.trim())} />
          </label>
          <p class="fine">
            Por padrão, o próprio banco. Todos os aparelhos do membro são removidos na hora; o membro não pode cancelar.
            Para devolver a conta depois, use “Recuperar” com a passkey nova do membro.
          </p>
        </>
      ) : (
        <label class="field">
          <span>Quantidade em {currency}</span>
          <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
        </label>
      )}
      {action === "confiscate" && <p class="fine">As moedas confiscadas são destruídas: o total em circulação diminui.</p>}
      <label class="field">
        <span>Motivo (público)</span>
        <textarea rows={2} maxLength={200} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
      </label>
      <button class="btn btn-primary" disabled={!ok}>
        Preparar: {enforceActions[action].toLowerCase()}
      </button>
    </form>
  );
}

function RecoverForm(props: { members: Member[]; param: string | null; onCalls: (c: Call[]) => void }) {
  const [request, setRequest] = useState(props.param ?? "");
  const [safe, setSafe] = useState("");
  const [removeOthers, setRemoveOthers] = useState(true);
  const [error, setError] = useState("");
  const payload = decodeDevice(request.includes("recover=") ? request.split("recover=")[1] : request);

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        if (!payload) return setError("Cole o pedido de recuperação que o membro enviou.");
        if (!isAddress(safe, { strict: false })) return setError("Escolha a conta do membro.");
        try {
          const pk = fromPublicKey(payload.id, payload.pk);
          const signer = await signerFor(pk.x, pk.y);
          props.onCalls([
            {
              to: deployment.aa.webAuthnSignerFactory,
              data: encodeFunctionData({ abi: signerFactoryAbi, functionName: "createSigner", args: [pk.x, pk.y, p256Verifiers] }),
              label: "Criar o assinante da passkey nova",
            },
            {
              to: deployment.recoveryModule,
              data: encodeFunctionData({
                abi: recoveryAbi,
                functionName: "initiateRecovery",
                args: [getAddress(safe), signer, removeOthers],
              }),
              label: `Recuperar ${short(safe)}${removeOthers ? ", removendo os aparelhos antigos" : ""}`,
            },
          ]);
        } catch (err) {
          setError(friendlyError(err));
        }
      }}
    >
      <Notice>Antes de continuar, confirme pessoalmente ou por chamada que o pedido é mesmo do membro.</Notice>
      <label class="field">
        <span>Pedido de recuperação</span>
        <textarea rows={3} value={request} onInput={(e) => setRequest(e.currentTarget.value.trim())} />
      </label>
      {request && !payload && <Notice tone="error">Esse pedido está incompleto.</Notice>}
      <MemberPicker members={props.members} value={safe} onChange={setSafe} label="Conta do membro" />
      <label class="check">
        <input type="checkbox" checked={removeOthers} onChange={(e) => setRemoveOthers(e.currentTarget.checked)} />
        Remover todos os aparelhos antigos (use se o celular foi perdido ou roubado)
      </label>
      <button class="btn btn-primary">Preparar recuperação</button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

function SettingsForm({ onCalls }: { onCalls: (c: Call[]) => void }) {
  const [current, setCurrent] = useState<number | null>(null);
  const [hours, setHours] = useState("0");
  useEffect(() => {
    recoveryDelay().then((s) => {
      setCurrent(s);
      setHours(String(s / 3600));
    });
  }, []);
  const minterRole = keccak256(toHex("MINTER_ROLE"));
  return (
    <div class="stack">
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const seconds = BigInt(Math.round(Number(hours.replace(",", ".")) * 3600));
          onCalls([
            {
              to: deployment.recoveryModule,
              data: encodeFunctionData({ abi: recoveryAbi, functionName: "setRecoveryDelay", args: [seconds] }),
              label: `Prazo de recuperação: ${hours} h`,
            },
          ]);
        }}
      >
        <label class="field">
          <span>Prazo de recuperação, em horas (agora: {current === null ? "…" : current / 3600} h)</span>
          <input inputMode="decimal" value={hours} onInput={(e) => setHours(e.currentTarget.value)} />
        </label>
        <p class="fine">0 h durante os testes: a recuperação acontece na hora. Em produção, use 24 a 48 h.</p>
        <button class="btn btn-secondary">Preparar mudança de prazo</button>
      </form>
      {deployment.allowanceMinter && (
        <button
          class="btn btn-secondary"
          onClick={() =>
            onCalls([
              {
                to: deployment.token.address,
                data: encodeFunctionData({
                  abi: tokenAbi,
                  functionName: "grantRole",
                  args: [minterRole, deployment.allowanceMinter!],
                }),
                label: "Autorizar a mesada automática a emitir",
              },
            ])
          }
        >
          Preparar ativação da mesada automática
        </button>
      )}
    </div>
  );
}

function Execute({ calls }: { calls: Call[] }) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  function download() {
    const batch = {
      version: "1.0",
      chainId: String(chain.id),
      createdAt: Date.now(),
      meta: {
        name: calls.map((c) => c.label).join("; "),
        description: "Hidroreais",
        txBuilderVersion: "1.16.5",
        createdFromSafeAddress: deployment.bank,
      },
      transactions: calls.map((c) => ({ to: c.to, value: "0", data: c.data })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "banco-central.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function sendFromWallet() {
    setError("");
    const eth = (window as { ethereum?: EIP1193Provider }).ethereum;
    if (!eth) return setError("Nenhuma carteira encontrada neste navegador.");
    try {
      const wallet = createWalletClient({ chain, transport: custom(eth) });
      const [account] = await wallet.requestAddresses();
      if (!isAddressEqual(account, deployment.bank)) {
        return setError("A carteira conectada não é o banco central. Use o Transaction Builder do Safe.");
      }
      await wallet.switchChain({ id: chain.id }).catch(() => {});
      for (const [i, c] of calls.entries()) {
        setStatus(`Enviando ${i + 1} de ${calls.length}…`);
        await wallet.sendTransaction({ account, to: c.to, data: c.data, chain });
      }
      setStatus("Enviado.");
    } catch (err) {
      setStatus("");
      setError(friendlyError(err));
    }
  }

  return (
    <section class="execute">
      <h2>Operações preparadas</h2>
      <ol>
        {calls.map((c) => (
          <li key={c.data}>{c.label}</li>
        ))}
      </ol>
      <div class="row">
        <button class="btn btn-primary" onClick={download}>
          Baixar para o Safe
        </button>
        <button class="btn btn-quiet" onClick={sendFromWallet}>
          Enviar da carteira conectada
        </button>
      </div>
      <p class="fine">
        No Safe: Apps → Transaction Builder → arraste o arquivo, revise e colete as assinaturas do banco.
      </p>
      {status && <Notice tone="ok">{status}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
