import { useState } from "preact/hooks";
import { Notice, Screen } from "../components/ui";
import { symbol } from "../config";
import { createAccount } from "../lib/account";
import { lookupCredential } from "../lib/chain";
import { friendlyError } from "../lib/format";
import { setIdentity } from "../lib/identity";
import { createPasskey, fromPublicKey, passkeysSupported, pickPasskey, type Passkey } from "../lib/passkey";
import { go, type Route } from "../lib/router";

// If signup fails after the passkey was created (prompt cancelled, network), reuse that
// passkey on retry so the same account address and invite are used.
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
  const invite = route.query.get("invite") ?? "";
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
      if (!passkey) {
        passkey = await createPasskey(trimmed);
        localStorage.setItem(SIGNUP, JSON.stringify({ id: passkey.id, publicKey: passkey.publicKey }));
      }
      const identity = await createAccount(passkey, trimmed, invite);
      localStorage.removeItem(SIGNUP);
      setIdentity(identity);
      go("/");
    } catch (err) {
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
      {invite ? (
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
        <Notice>Para criar uma conta você precisa do link de convite de alguém da comunidade.</Notice>
      )}

      <div class="stack stack-tight">
        <button class="btn btn-quiet" onClick={login} disabled={!!busy}>
          {busy === "login" ? "Procurando sua conta…" : "Já tenho conta: entrar com passkey"}
        </button>
        <a class="btn btn-quiet" href="#/new-device">
          Adicionar este aparelho a uma conta
        </a>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}

function Hero() {
  return (
    <section class="welcome-hero">
      <div class="coin-mark" aria-hidden="true">
        {symbol}
      </div>
      <h1>Moeda da comunidade</h1>
      <p>Pague e receba dos amigos pelo celular. Sem taxas, sem banco, sem frase secreta.</p>
    </section>
  );
}
