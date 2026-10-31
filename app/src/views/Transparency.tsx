import { useEffect, useState } from "preact/hooks";
import { Notice, Screen } from "../components/ui";
import { deployment, explorerUrl, symbol } from "../config";
import { api, recoveryDelay, type ActivityItem, type RecoveryItem } from "../lib/chain";
import { coins, friendlyError, nameOr, short } from "../lib/format";

export function Transparency() {
  const [data, setData] = useState<{ names: Record<string, string>; mints: ActivityItem[]; recoveries: RecoveryItem[] } | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.transparency().then(setData).catch((err) => setError(friendlyError(err)));
    recoveryDelay().then(setDelay).catch(() => {});
  }, []);

  const total = data?.mints.reduce((s, m) => s + BigInt(m.value), 0n) ?? 0n;

  return (
    <Screen title="Transparência" back="/">
      <p>
        Tudo o que o banco central faz fica registrado na rede e aparece aqui: cada emissão de moeda e cada recuperação de
        conta.
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
            {coins(total)} {symbol}
          </dd>
        </div>
        <div>
          <dt>Prazo de recuperação</dt>
          <dd>{delay === null ? "…" : delay === 0 ? "imediato (fase de testes)" : `${delay / 3600} h`}</dd>
        </div>
      </dl>
      {error && <Notice tone="error">{error}</Notice>}

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

      <h2>Recuperações de conta</h2>
      <ul class="ledger">
        {data?.recoveries.map((r) => (
          <li key={r.tx + r.kind}>
            <a href={`${explorerUrl}/tx/${r.tx}`} target="_blank" rel="noreferrer">
              <span>{nameOr(data.names, r.safe)}</span>
              <span>{r.kind === "initiated" ? "iniciada" : r.kind === "executed" ? "concluída" : "cancelada"}</span>
            </a>
          </li>
        ))}
        {data && data.recoveries.length === 0 && <li class="empty">Nenhuma recuperação até agora.</li>}
      </ul>
    </Screen>
  );
}
