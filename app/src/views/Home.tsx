import { useEffect, useState } from "preact/hooks";
import { encodeFunctionData } from "viem";
import { Notice, Screen } from "../components/ui";
import { deployment, explorerUrl, recoveryAbi, currency } from "../config";
import { sendCalls } from "../lib/account";
import { api, balanceOf, pendingRecovery, type ActivityItem, type PendingRecovery } from "../lib/chain";
import { coins, friendlyError, nameOr, sameAddress } from "../lib/format";
import type { Identity } from "../lib/identity";
import { enablePush, isIOS, isStandalone, pushEnabled, pushSupported } from "../lib/push";

export function Home({ identity }: { identity: Identity }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [recovery, setRecovery] = useState<PendingRecovery>(null);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const [b, act, rec] = await Promise.all([
        balanceOf(identity.safe),
        api.activity(identity.safe).catch(() => ({ names: {}, items: [] })),
        pendingRecovery(identity.safe),
      ]);
      setBalance(b);
      setItems(act.items);
      setNames(act.names);
      setRecovery(rec);
      setError("");
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [identity.safe]);

  const myName = names[identity.safe.toLowerCase()] ?? identity.name;

  return (
    <Screen>
      <section class="tile" aria-label="Saldo">
        <p class="tile-who">{myName ? `Olá, ${myName}` : "Seu saldo"}</p>
        <p class="tile-balance">
          <span class="tile-amount">{balance === null ? "—" : coins(balance)}</span>
          <span class="tile-symbol">{currency}</span>
        </p>
      </section>

      <nav class="actions">
        <a class="btn btn-primary" href="#/pay">
          Pagar
        </a>
        <a class="btn btn-secondary" href="#/receive">
          Receber
        </a>
      </nav>

      {recovery && <RecoveryBanner identity={identity} recovery={recovery} onDone={refresh} />}
      <PushPrompt identity={identity} />
      {error && <Notice tone="error">{error}</Notice>}

      <section class="activity">
        <h2>Movimentações</h2>
        {items.length === 0 ? (
          <p class="empty">Nada por aqui ainda. Peça para alguém escanear seu código em “Receber”.</p>
        ) : (
          <ul>
            {items.map((it) => {
              const incoming = sameAddress(it.to, identity.safe);
              const other = nameOr(names, incoming ? it.from : it.to);
              const who =
                it.kind === "mint"
                  ? "Banco central"
                  : it.kind === "confiscation"
                    ? "Confiscado pelo banco central"
                    : it.kind === "forced"
                      ? `${incoming ? `De ${other}` : `Para ${other}`}, pelo banco central`
                      : incoming
                        ? other
                        : `Para ${other}`;
              return (
                <li key={`${it.tx}-${it.from}-${it.to}`} class={incoming ? "in" : "out"}>
                  <a href={`${explorerUrl}/tx/${it.tx}`} target="_blank" rel="noreferrer">
                    <span class="who">
                      {who}
                      {it.reason && <span class="reason">Motivo: {it.reason}</span>}
                    </span>
                    <span class="amount">
                      {incoming ? "+" : "−"}
                      {coins(it.value)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer class="links">
        <a href="#/invite">Convidar alguém</a>
        <a href="#/devices">Aparelhos e recuperação</a>
        <a href="#/transparency">Transparência do banco central</a>
        <a href="#/external">Usar outra carteira</a>
      </footer>
    </Screen>
  );
}

function RecoveryBanner(props: { identity: Identity; recovery: NonNullable<PendingRecovery>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const when = new Date(props.recovery.executeAfter * 1000).toLocaleString("pt-BR");
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await sendCalls(props.identity, [
        { to: deployment.recoveryModule, data: encodeFunctionData({ abi: recoveryAbi, functionName: "cancelRecovery" }) },
      ]);
      props.onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="alert" role="alert">
      <h2>O banco central iniciou a recuperação da sua conta</h2>
      <p>
        Ela entra em vigor em {when}
        {props.recovery.removeOthers ? " e remove todos os seus aparelhos atuais" : ""}. Se você não pediu isso,
        cancele agora.
      </p>
      <button class="btn btn-danger" onClick={cancel} disabled={busy}>
        {busy ? "Cancelando…" : "Cancelar recuperação"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function PushPrompt({ identity }: { identity: Identity }) {
  const [state, setState] = useState<"hidden" | "offer" | "install" | "busy">("hidden");
  const [error, setError] = useState("");
  useEffect(() => {
    if (isIOS() && !isStandalone()) return setState("install");
    if (!pushSupported()) return;
    pushEnabled().then((on) => setState(on ? "hidden" : "offer"));
  }, []);
  if (state === "hidden") return null;
  if (state === "install") {
    return (
      <Notice>
        Para receber avisos de pagamento no iPhone, toque em Compartilhar e depois em “Adicionar à Tela de Início”, e
        abra o Hidroreais por lá.
      </Notice>
    );
  }
  return (
    <div class="inline-offer">
      <p>Quer um aviso quando alguém te pagar?</p>
      <button
        class="btn btn-quiet"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            await enablePush(identity.safe);
            setState("hidden");
          } catch (err) {
            setError(friendlyError(err));
            setState("offer");
          }
        }}
      >
        Ativar avisos
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
