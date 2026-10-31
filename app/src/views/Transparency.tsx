import { useEffect, useState } from "preact/hooks";
import { Notice, Screen } from "../components/ui";
import { currency, deployment, explorerUrl } from "../config";
import { api, recoveryDelay, type ActivityItem, type RecoveryItem } from "../lib/chain";
import { coins, friendlyError, nameOr, short } from "../lib/format";

type Data = {
  names: Record<string, string>;
  accounts: { address: string; balance: string }[];
  mints: ActivityItem[];
  enforcement: ActivityItem[];
  recoveries: RecoveryItem[];
};

const recoveryLabel: Record<RecoveryItem["kind"], string> = {
  initiated: "recuperação iniciada",
  executed: "recuperação concluída",
  cancelled: "recuperação cancelada",
  taken: "tomada pelo banco",
};

export function Transparency() {
  const [data, setData] = useState<Data | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.transparency().then(setData).catch((err) => setError(friendlyError(err)));
    recoveryDelay().then(setDelay).catch(() => {});
  }, []);

  const sum = (items: ActivityItem[]) => items.reduce((s, m) => s + BigInt(m.value), 0n);
  const minted = sum(data?.mints ?? []);
  const confiscated = sum(data?.enforcement.filter((x) => x.kind === "confiscation") ?? []);

  return (
    <Screen title="Transparência" back="/">
      <p>
        Tudo o que o banco central faz fica registrado na rede e aparece aqui: cada emissão, cada confisco, cada
        transferência forçada e cada recuperação ou tomada de conta, com o motivo que o banco deu.
      </p>
      <dl class="facts">
        <div>
          <dt>Banco central</dt>
          <dd>
            <a href={`${explorerUrl}/address/${deployment.bank}`} target="_blank" rel="noreferrer">
              {short(deployment.bank)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Total emitido</dt>
          <dd>
            {coins(minted)} {currency}
          </dd>
        </div>
        <div>
          <dt>Total confiscado</dt>
          <dd>
            {coins(confiscated)} {currency}
          </dd>
        </div>
        <div>
          <dt>Em circulação</dt>
          <dd>
            {coins(minted - confiscated)} {currency}
          </dd>
        </div>
        <div>
          <dt>Prazo de recuperação</dt>
          <dd>{delay === null ? "…" : delay === 0 ? "imediato (fase de testes)" : `${delay / 3600} h`}</dd>
        </div>
      </dl>
      {error && <Notice tone="error">{error}</Notice>}

      <h2>Contas</h2>
      <p class="fine">Quanto cada conta tem, segundo o registro da rede. “Convites” guarda os presentes de convites ainda abertos.</p>
      <ul class="ledger">
        {data?.accounts.map((a) => (
          <li key={a.address}>
            <a href={`${explorerUrl}/address/${a.address}`} target="_blank" rel="noreferrer">
              <span>{nameOr(data.names, a.address)}</span>
              <span class="amount">{coins(a.balance)}</span>
            </a>
          </li>
        ))}
        {data && data.accounts.length === 0 && <li class="empty">Nenhuma conta ainda.</li>}
      </ul>

      <h2>Emissões</h2>
      <ul class="ledger">
        {data?.mints.map((m) => (
          <li key={m.tx + m.to}>
            <a href={`${explorerUrl}/tx/${m.tx}`} target="_blank" rel="noreferrer">
              <span>{nameOr(data.names, m.to)}</span>
              <span class="amount">+{coins(m.value)}</span>
            </a>
          </li>
        ))}
        {data && data.mints.length === 0 && <li class="empty">Nenhuma emissão ainda.</li>}
      </ul>

      <h2>Confiscos e transferências forçadas</h2>
      <ul class="ledger">
        {data?.enforcement.map((x) => (
          <li key={x.tx + x.from + x.to}>
            <a href={`${explorerUrl}/tx/${x.tx}`} target="_blank" rel="noreferrer">
              <span>
                {x.kind === "confiscation"
                  ? `Confisco de ${nameOr(data.names, x.from)}`
                  : `De ${nameOr(data.names, x.from)} para ${nameOr(data.names, x.to)}`}
                <span class="reason">Motivo: {x.reason}</span>
              </span>
              <span class="amount">
                {x.kind === "confiscation" ? "−" : ""}
                {coins(x.value)}
              </span>
            </a>
          </li>
        ))}
        {data && data.enforcement.length === 0 && <li class="empty">Nenhum confisco ou transferência forçada.</li>}
      </ul>

      <h2>Recuperações e tomadas de conta</h2>
      <ul class="ledger">
        {data?.recoveries.map((r) => (
          <li key={r.tx + r.kind}>
            <a href={`${explorerUrl}/tx/${r.tx}`} target="_blank" rel="noreferrer">
              <span>
                {nameOr(data.names, r.safe)}
                {r.reason && <span class="reason">Motivo: {r.reason}</span>}
              </span>
              <span>{recoveryLabel[r.kind]}</span>
            </a>
          </li>
        ))}
        {data && data.recoveries.length === 0 && <li class="empty">Nenhuma recuperação até agora.</li>}
      </ul>
    </Screen>
  );
}
