import { useState } from "preact/hooks";
import { ExpiryPicker, InviteShare } from "../components/invites";
import { Notice, Screen } from "../components/ui";
import { currency } from "../config";
import { coins, friendlyError, parseAmount } from "../lib/format";
import type { Identity } from "../lib/identity";
import { PAY_LINK_DEFAULT_EXPIRY, PAY_LINK_PRESETS, createMemberInvite } from "../lib/invites";

/**
 * Pay by link or QR: the coins are locked in a link, and whoever opens it first gets them. A
 * newcomer creates their account with it; a member who is signed in just receives. Unclaimed,
 * the coins come back when the link expires (or on cancel, in Convidar → Seus convites).
 */
export function PayLink({ identity }: { identity: Identity }) {
  const [amount, setAmount] = useState("");
  const [seconds, setSeconds] = useState<number>(PAY_LINK_DEFAULT_EXPIRY);
  const [created, setCreated] = useState<{ pk: `0x${string}`; value: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = parseAmount(amount);

  async function create(e: Event) {
    e.preventDefault();
    if (!value) return setError("Digite um valor maior que zero.");
    setBusy(true);
    setError("");
    try {
      setCreated({ pk: await createMemberInvite(identity, value, seconds, true), value });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Screen title="Pagar com link" back="/pay">
        <Notice tone="ok">
          Link de {coins(created.value)} {currency} criado. Quem abrir primeiro recebe: mande só para a pessoa certa.
        </Notice>
        <InviteShare pk={created.pk} />
        <p class="fine">Se ninguém usar, o valor volta para você quando o link expirar. Para cancelar antes, vá em Convidar.</p>
        <a class="btn btn-quiet" href="#/">
          Voltar ao início
        </a>
      </Screen>
    );
  }

  return (
    <Screen title="Pagar com link" back="/pay">
      <p>
        O valor fica guardado num link (ou QR). Quem abrir recebe: se ainda não tem conta, cria uma na hora. Funciona como
        dinheiro: mande só para quem deve receber.
      </p>
      <form class="stack" onSubmit={create}>
        <label class="field field-amount">
          <span>Valor em {currency}</span>
          <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
        </label>
        <ExpiryPicker value={seconds} onChange={setSeconds} presets={PAY_LINK_PRESETS} />
        <button class="btn btn-primary" disabled={busy || !value}>
          {busy ? "Criando o link…" : value ? `Criar link de ${coins(value)} ${currency}` : "Criar link"}
        </button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
