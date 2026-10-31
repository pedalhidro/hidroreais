import { useEffect, useState } from "preact/hooks";
import { Notice, Screen } from "../components/ui";
import { currency, deployment, symbol } from "../config";
import { createAccount, predictSafe } from "../lib/account";
import { api, lookupCredential, publicClient, type InviteRecord } from "../lib/chain";
import { coins, friendlyError } from "../lib/format";
import { setIdentity } from "../lib/identity";
import { inviteKeyOf, parseInvitePk } from "../lib/invites";
import { createPasskey, fromPublicKey, passkeysSupported, pickPasskey, type Passkey } from "../lib/passkey";
import { go, type Route } from "../lib/router";

// The passkey of a signup in progress. If an earlier attempt did create the account (say the app
// closed before it saw the receipt), the retry just finishes it. Otherwise the passkey is tried
// once more and then forgotten, since it may have been deleted from the device.
const SIGNUP = "coin.signup-passkey";
function savedSignupPasskey(): Passkey | null {
  try {
    const raw = localStorage.getItem(SIGNUP);
    if (!raw) return null;
    const { id, publicKey } = JSON.parse(raw);
    return fromPublicKey(id, publicKey);
  } catch {
    return null;
  }
}

export function Welcome({ route }: { route: Route }) {
  const invitePk = parseInvitePk(route.query.get("i"));
  const oldStyleInvite = !invitePk && route.query.has("invite");
  // undefined while loading; null if the server has not seen it (yet): the claim is checked anyway.
  const [invite, setInvite] = useState<{ invite: InviteRecord | null; creatorName: string | null } | undefined>();
  useEffect(() => {
    if (invitePk) api.invite(inviteKeyOf(invitePk)).then(setInvite).catch(() => setInvite({ invite: null, creatorName: null }));
  }, [invitePk]);
  const closed =
    !!invite?.invite && (invite.invite.closed || invite.invite.expiresAt * 1000 <= Date.now());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"" | "create" | "login">("");
  const [error, setError] = useState("");

  if (!passkeysSupported()) {
    return (
      <Screen>
        <Hero />
        <Notice tone="error">
          Este navegador não suporta passkeys. Abra o link no Safari (iPhone) ou no Chrome (Android) atualizados.
        </Notice>
      </Screen>
    );
  }

  async function create(e: Event) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Escreva como a comunidade conhece você.");
    setBusy("create");
    setError("");
    try {
      let passkey = savedSignupPasskey();
      if (passkey) {
        const safe = await predictSafe(passkey);
        if (await publicClient.getCode({ address: safe })) {
          localStorage.removeItem(SIGNUP);
          const signer = deployment.aa.webAuthnSharedSigner;
          setIdentity({ credentialId: passkey.id, publicKey: passkey.publicKey, signer, safe, name: trimmed });
          return go("/");
        }
      } else {
        passkey = await createPasskey(trimmed);
        localStorage.setItem(SIGNUP, JSON.stringify({ id: passkey.id, publicKey: passkey.publicKey }));
      }
      const identity = await createAccount(passkey, trimmed, invitePk!);
      localStorage.removeItem(SIGNUP);
      setIdentity(identity);
      go("/");
    } catch (err) {
      // Start fresh next time. If this attempt still lands (a receipt timeout), the passkey is on the
      // device and "Já tenho conta" finds the account through its CredentialLinked event.
      localStorage.removeItem(SIGNUP);
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  }

  async function login() {
    setBusy("login");
    setError("");
    try {
      const picked = await pickPasskey();
      const identity = await lookupCredential(picked.id, picked.provenBy);
      if (!identity) {
        setError("Esta passkey ainda não está ligada a uma conta. Se este é um aparelho novo, use “Adicionar este aparelho”.");
        return;
      }
      setIdentity(identity);
      go("/");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <Screen>
      <Hero />
      {invitePk && invite && <InviteCard {...invite} />}
      {invitePk && closed && (
        <Notice tone="error">Este convite não vale mais: expirou ou já foi usado. Peça um novo a quem te convidou.</Notice>
      )}
      {invitePk && !closed ? (
        <form class="stack" onSubmit={create}>
          <label class="field">
            <span>Seu nome na comunidade</span>
            <input
              value={name}
              maxLength={32}
              autoComplete="nickname"
              placeholder="Ex.: Joana do pedal"
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <button class="btn btn-primary" disabled={!!busy}>
            {busy === "create" ? "Criando sua conta…" : "Criar minha conta"}
          </button>
          <p class="fine">
            O celular vai pedir Face ID, digital ou o bloqueio de tela. Isso cria uma passkey: é ela que protege seu
            dinheiro, sem senha e sem frase secreta.
          </p>
        </form>
      ) : (
        !invitePk && (
          <Notice>
            {oldStyleInvite
              ? "Este link de convite é do formato antigo e não vale mais. Peça um novo."
              : "Para criar uma conta, peça um link de convite a alguém da comunidade."}
          </Notice>
        )
      )}

      <div class="stack stack-tight">
        <button class="btn btn-quiet" onClick={login} disabled={!!busy}>
          {busy === "login" ? "Procurando sua conta…" : "Já tenho conta: entrar com passkey"}
        </button>
        <a class="btn btn-quiet" href="#/new-device">
          Adicionar este aparelho a uma conta
        </a>
        <a class="btn btn-link" href="#/backup">
          Perdi os aparelhos: usar carteira de reserva
        </a>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}

function InviteCard({ invite, creatorName }: { invite: InviteRecord | null; creatorName: string | null }) {
  if (!invite) return null;
  const gift = BigInt(invite.amount);
  return (
    <section class="invite-card">
      <p>
        <strong>{creatorName ?? "Alguém da comunidade"}</strong> te convidou
        {gift > 0n && (
          <>
            {" "}
            e te dá{" "}
            <strong>
              {coins(gift)} {currency}
            </strong>
          </>
        )}
        .
      </p>
      <p class="fine">Vale até {new Date(invite.expiresAt * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.</p>
    </section>
  );
}

function Hero() {
  return (
    <section class="welcome-hero">
      <div class="coin-mark" aria-hidden="true">
        {symbol}
      </div>
      <h1>Hidroreais</h1>
      <p>Pague e receba dos amigos pelo celular. Sem taxas, sem banco, sem frase secreta.</p>
    </section>
  );
}
