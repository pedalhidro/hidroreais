import { useEffect, useState } from "preact/hooks";
import { encodeFunctionData, type Hex } from "viem";
import { Notice, Screen } from "../components/ui";
import { currency, deployment, invitesAbi } from "../config";
import { sendCalls } from "../lib/account";
import { api, publicClient, type InviteRecord } from "../lib/chain";
import { coins, friendlyError } from "../lib/format";
import type { Identity } from "../lib/identity";
import { claimSignature, inviteKeyOf } from "../lib/invites";

/**
 * A member who already has an account opens a bank link (#/welcome?i=…). Links open to members
 * pay out once per account; new-only links are for someone else.
 */
export function ClaimLink({ identity, pk }: { identity: Identity; pk: Hex }) {
  const key = inviteKeyOf(pk);
  const [info, setInfo] = useState<{ invite: InviteRecord | null; creatorName: string | null } | null>(null);
  const [signature, setSignature] = useState<Hex | null>(null);
  const [claimable, setClaimable] = useState<boolean | null>(null);
  // From the contract, for a link the server hasn't indexed yet (it lags a few seconds).
  const [onChainAmount, setOnChainAmount] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.invite(key).then(setInfo).catch(() => setInfo({ invite: null, creatorName: null }));
    (async () => {
      const sig = await claimSignature(pk, identity.safe);
      setSignature(sig);
      const [ok, stored] = await Promise.all([
        publicClient.readContract({ address: deployment.invites, abi: invitesAbi, functionName: "claimable", args: [key, identity.safe, sig] }),
        publicClient.readContract({ address: deployment.invites, abi: invitesAbi, functionName: "invites", args: [key] }),
      ]);
      setOnChainAmount((stored as readonly unknown[])[6] as bigint);
      setClaimable(ok as boolean);
    })().catch(() => setClaimable(false));
  }, [pk]);

  async function claim() {
    if (!signature) return;
    setBusy(true);
    setError("");
    try {
      await sendCalls(identity, [
        { to: deployment.invites, data: encodeFunctionData({ abi: invitesAbi, functionName: "claim", args: [key, signature] }) },
      ]);
      setDone(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const inv = info?.invite;
  const raw = inv ? BigInt(inv.amount) : onChainAmount;
  const amount = raw !== null ? `${coins(raw)} ${currency}` : "";

  if (done) {
    return (
      <Screen>
        <section class="done">
          <div class="done-mark" aria-hidden="true">
            ✓
          </div>
          <h1>Recebido</h1>
          <p>{amount} entraram na sua conta.</p>
          <a class="btn btn-primary" href="#/">
            Voltar ao início
          </a>
        </section>
      </Screen>
    );
  }

  return (
    <Screen title="Link do banco" back="/">
      {info === null || claimable === null ? (
        <p class="fine">Conferindo o link…</p>
      ) : claimable ? (
        <>
          <section class="invite-card">
            <p>
              <strong>{info?.creatorName ?? "O banco central"}</strong> está distribuindo <strong>{amount}</strong> para cada
              conta.
            </p>
          </section>
          <button class="btn btn-primary" onClick={claim} disabled={busy}>
            {busy ? "Recebendo…" : `Receber ${amount}`}
          </button>
        </>
      ) : inv && !inv.openToMembers && !inv.closed ? (
        <Notice>Este convite é para quem ainda não tem conta. Você já tem: mande o link para alguém que queira entrar.</Notice>
      ) : (
        <Notice tone="error">Este link não vale mais para você: já foi usado nesta conta, acabou ou expirou.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
