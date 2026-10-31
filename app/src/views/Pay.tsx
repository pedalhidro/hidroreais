import { useEffect, useMemo, useState } from "preact/hooks";
import { encodeFunctionData, getAddress, isAddress, type Address } from "viem";
import { Notice, Scanner, Screen } from "../components/ui";
import { deployment, currency, tokenAbi } from "../config";
import { sendCalls } from "../lib/account";
import { api, balanceOf, type Member } from "../lib/chain";
import { coins, friendlyError, parseAmount, sameAddress, short } from "../lib/format";
import type { Identity } from "../lib/identity";
import { routeFromScan } from "../lib/links";
import { go, type Route } from "../lib/router";

export function Pay({ identity, route }: { identity: Identity; route: Route }) {
  const toParam = route.query.get("to");
  const to = toParam && isAddress(toParam, { strict: false }) ? getAddress(toParam) : null;
  // null until the directory has loaded, so the not-a-member warning doesn't flash.
  const [members, setMembers] = useState<Member[] | null>(null);
  useEffect(() => {
    api.directory().then(setMembers).catch(() => setMembers([]));
  }, []);

  if (!to) return <PickRecipient identity={identity} members={members ?? []} />;
  const member = members?.find((m) => sameAddress(m.address, to));
  return (
    <Confirm
      identity={identity}
      to={to}
      name={member?.name ?? null}
      outsider={members !== null && !member}
      initialAmount={route.query.get("amount") ?? ""}
    />
  );
}

function PickRecipient({ identity, members }: { identity: Identity; members: Member[] }) {
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => !sameAddress(m.address, identity.safe))
      .filter((m) => !q || (m.name ?? "").toLowerCase().includes(q) || m.address.toLowerCase().includes(q));
  }, [members, query]);
  // A pasted address that isn't a member: offer to pay it directly (the confirm screen warns).
  const pasted = query.trim();
  const outsider = isAddress(pasted, { strict: false }) && list.length === 0 ? getAddress(pasted) : null;

  if (scanning) {
    return (
      <Screen title="Escanear código" back="/pay">
        <Scanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            const r = routeFromScan(text);
            setScanning(false);
            if (r) go(r);
            else setError("Esse código não é de pagamento do Hidroreais.");
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen title="Pagar" back="/">
      <button class="btn btn-primary" onClick={() => setScanning(true)}>
        Escanear código
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      <label class="field">
        <span>Ou escolha quem vai receber</span>
        <input
          type="search"
          value={query}
          placeholder="Buscar pelo nome ou colar um endereço 0x…"
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      <ul class="people">
        {list.map((m) => (
          <li key={m.address}>
            <a href={`#/pay?to=${m.address}`}>
              <span class="avatar" aria-hidden="true">
                {(m.name ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span>{m.name ?? short(m.address)}</span>
            </a>
          </li>
        ))}
        {outsider && (
          <li>
            <a href={`#/pay?to=${outsider}`}>
              <span class="avatar" aria-hidden="true">
                0x
              </span>
              <span>Pagar para o endereço {short(outsider)}</span>
            </a>
          </li>
        )}
        {list.length === 0 && !outsider && <li class="empty">Ninguém encontrado com esse nome.</li>}
      </ul>
    </Screen>
  );
}

function Confirm(props: { identity: Identity; to: Address; name: string | null; outsider: boolean; initialAmount: string }) {
  const [amount, setAmount] = useState(props.initialAmount);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    balanceOf(props.identity.safe).then(setBalance).catch(() => {});
  }, []);

  const value = parseAmount(amount);
  const who = props.name ?? short(props.to);
  const self = sameAddress(props.to, props.identity.safe);

  async function pay(e: Event) {
    e.preventDefault();
    if (!value) return setError("Digite um valor maior que zero.");
    if (balance !== null && value > balance) return setError("Saldo insuficiente.");
    setBusy(true);
    setError("");
    try {
      const tx = await sendCalls(props.identity, [
        {
          to: deployment.token.address,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [props.to, value] }),
        },
      ]);
      setDone(tx);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done && value) {
    return (
      <Screen>
        <section class="done">
          <div class="done-mark" aria-hidden="true">
            ✓
          </div>
          <h1>Pago</h1>
          <p>
            {who} recebeu {coins(value)} {currency}.
          </p>
          <a class="btn btn-primary" href="#/">
            Voltar ao início
          </a>
        </section>
      </Screen>
    );
  }

  return (
    <Screen title={`Pagar ${who}`} back="/pay">
      <form class="stack" onSubmit={pay}>
        <label class="field field-amount">
          <span>Valor em {currency}</span>
          <input
            inputMode="decimal"
            autoFocus
            value={amount}
            placeholder="0"
            onInput={(e) => setAmount(e.currentTarget.value)}
          />
        </label>
        {balance !== null && <p class="fine">Seu saldo: {coins(balance)} {currency}</p>}
        {self && <Notice>Este é o seu próprio código.</Notice>}
        {props.outsider && !self && (
          <Notice tone="error">
            Este endereço não é de um membro do Hidroreais. Confira com quem vai receber: moedas enviadas para o endereço
            errado não voltam.
          </Notice>
        )}
        <button class="btn btn-primary" disabled={busy || !value || self}>
          {busy ? "Confirmando…" : value ? `Pagar ${coins(value)} ${currency}` : "Pagar"}
        </button>
        <p class="fine">Você confirma com Face ID, digital ou bloqueio de tela. Não há taxa.</p>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
