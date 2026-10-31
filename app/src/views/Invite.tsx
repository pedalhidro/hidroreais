import { useEffect, useState } from "preact/hooks";
import { ExpiryPicker, InviteList, InviteShare } from "../components/invites";
import { Notice, Screen } from "../components/ui";
import { currency } from "../config";
import { api, type InviteRecord } from "../lib/chain";
import { friendlyError, parseAmount } from "../lib/format";
import type { Identity } from "../lib/identity";
import { DEFAULT_EXPIRY, EXPIRY_PRESETS, cancelInvite, createMemberInvite } from "../lib/invites";

export function Invite({ identity }: { identity: Identity }) {
  const [amount, setAmount] = useState("");
  const [seconds, setSeconds] = useState<number>(DEFAULT_EXPIRY);
  const [created, setCreated] = useState<`0x${string}` | null>(null);
  const [mine, setMine] = useState<InviteRecord[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = () => api.invitesBy(identity.safe).then(setMine).catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);

  // Empty means no gift; anything typed must be a valid amount.
  const gift = amount.trim() === "" ? 0n : parseAmount(amount);

  async function create(e: Event) {
    e.preventDefault();
    if (gift === null) return setError("Valor inválido.");
    setBusy("create");
    setError("");
    try {
      setCreated(await createMemberInvite(identity, gift, seconds));
      setAmount("");
      setTimeout(refresh, 6000); // the server indexes the new invite within a few seconds
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  }

  async function cancel(key: string) {
    setBusy(key);
    setError("");
    try {
      await cancelInvite(identity, key);
      setTimeout(refresh, 6000);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <Screen title="Convidar" back="/">
      <p>
        Mande o link para quem você quer trazer. Quem abrir cria a conta na hora e recebe o presente que você deixar no
        convite. Se ninguém usar, o presente volta para você quando o convite expirar.
      </p>
      {created ? (
        <>
          <Notice tone="ok">Convite criado. Mande o link pelo WhatsApp ou mostre o código.</Notice>
          <InviteShare pk={created} />
          <button class="btn btn-quiet" onClick={() => setCreated(null)}>
            Criar outro convite
          </button>
        </>
      ) : (
        <form class="stack" onSubmit={create}>
          <label class="field">
            <span>Presente em {currency} (opcional)</span>
            <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
          </label>
          <ExpiryPicker value={seconds} onChange={setSeconds} presets={EXPIRY_PRESETS} />
          <button class="btn btn-primary" disabled={!!busy || gift === null}>
            {busy === "create" ? "Criando o convite…" : "Criar convite"}
          </button>
        </form>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <h2>Seus convites</h2>
      <InviteList invites={mine} onCancel={cancel} busy={busy} />
    </Screen>
  );
}
