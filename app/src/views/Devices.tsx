import { useEffect, useState } from "preact/hooks";
import { encodeFunctionData, getAddress, isAddressEqual, type Address } from "viem";
import { Notice, Scanner, Screen } from "../components/ui";
import { deployment, directoryAbi, p256Verifiers } from "../config";
import { sendCalls } from "../lib/account";
import { api, getOwners, publicClient, recoveryDelay, safeAbi, signerFactoryAbi, signerFor, type RecoveryItem } from "../lib/chain";
import { friendlyError, short } from "../lib/format";
import { setIdentity, type Identity } from "../lib/identity";
import { decodeDevice, routeFromScan } from "../lib/links";
import { credentialHash, fromPublicKey } from "../lib/passkey";
import { go, type Route } from "../lib/router";
import { connectWallet, injectedWallet } from "../lib/wallet";

const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;

type Owner = { address: Address; kind: "this" | "passkey" | "wallet" };

export function Devices({ identity }: { identity: Identity }) {
  const [owners, setOwners] = useState<Owner[]>([]);
  const [delay, setDelay] = useState<number | null>(null);
  const [history, setHistory] = useState<RecoveryItem[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<Address | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const list = await getOwners(identity.safe);
    const typed = await Promise.all(
      list.map(async (address): Promise<Owner> => {
        if (isAddressEqual(address, identity.signer)) return { address, kind: "this" };
        const code = await publicClient.getCode({ address });
        return { address, kind: code && code !== "0x" ? "passkey" : "wallet" };
      }),
    );
    setOwners(typed);
    setDelay(await recoveryDelay());
    setHistory(await api.recoveries(identity.safe).catch(() => []));
  }
  useEffect(() => {
    load().catch((err) => setError(friendlyError(err)));
  }, []);

  async function remove(owner: Address) {
    const list = owners.map((o) => o.address);
    const i = list.findIndex((a) => isAddressEqual(a, owner));
    const prev = i === 0 ? SENTINEL : list[i - 1];
    setBusy(owner);
    setError("");
    try {
      await sendCalls(identity, [
        { to: identity.safe, data: encodeFunctionData({ abi: safeAbi, functionName: "removeOwner", args: [prev, owner, 1n] }) },
      ]);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  if (scanning) {
    return (
      <Screen title="Escanear o novo aparelho" back="/devices">
        <Scanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            const r = routeFromScan(text);
            if (r?.startsWith("/link")) go(r);
            else setError("Esse código não é de um aparelho novo. No aparelho novo, abra “Adicionar este aparelho”.");
          }}
        />
      </Screen>
    );
  }

  const label = (o: Owner) =>
    o.kind === "this" ? "Este aparelho" : o.kind === "passkey" ? `Passkey ${short(o.address)}` : `Carteira de reserva ${short(o.address)}`;

  return (
    <Screen title="Aparelhos e recuperação" back="/">
      <p>Cada aparelho tem a própria passkey, e qualquer um deles controla a conta.</p>
      <ul class="devices">
        {owners.map((o) => (
          <li key={o.address}>
            <span>{label(o)}</span>
            {o.kind !== "this" && owners.length > 1 && (
              <button class="btn btn-link" onClick={() => remove(o.address)} disabled={!!busy}>
                {busy === o.address ? "Removendo…" : "Remover"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button class="btn btn-primary" onClick={() => setScanning(true)}>
        Adicionar um aparelho
      </button>
      <p class="fine">
        No aparelho novo, abra o Hidroreais e escolha “Adicionar este aparelho a uma conta”. Depois escaneie o código que
        aparecer lá.
      </p>
      {error && <Notice tone="error">{error}</Notice>}

      <BackupWallet identity={identity} owners={owners} onAdded={() => load().catch(() => {})} />

      <h2>Se você perder todos os aparelhos</h2>
      <p>
        O banco central é o guardião da sua conta: depois de confirmar que é você, ele adiciona a passkey de um aparelho
        novo.{" "}
        {delay === 0
          ? "Durante os testes isso acontece na hora."
          : delay
            ? `A recuperação só vale ${Math.round(delay / 3600)} h depois do pedido, e você pode cancelar nesse meio-tempo.`
            : ""}
      </p>
      {history.length > 0 && (
        <ul class="history">
          {history.map((h) => (
            <li key={h.tx + h.kind}>
              {h.kind === "initiated" ? "Recuperação iniciada" : h.kind === "executed" ? "Recuperação concluída" : "Recuperação cancelada"}{" "}
              <span class="fine">bloco {h.block}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        class="btn btn-link"
        onClick={() => {
          setIdentity(null);
          go("/");
        }}
      >
        Sair deste aparelho
      </button>
    </Screen>
  );
}

/**
 * A wallet the member controls (MetaMask, Rabby, …) as an extra owner: with it they can move their
 * coins without any device and without the bank (#/backup). Only a connected wallet can be added,
 * never a typed address, so a typo can't hand the account to a stranger.
 */
function BackupWallet(props: { identity: Identity; owners: Owner[]; onAdded: () => void }) {
  const [wallet, setWallet] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const already = props.owners.some((o) => o.kind === "wallet");

  async function connect() {
    setError("");
    try {
      setWallet((await connectWallet()).account);
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function add() {
    if (!wallet) return;
    setBusy(true);
    setError("");
    try {
      await sendCalls(props.identity, [
        { to: props.identity.safe, data: encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [wallet, 1n] }) },
      ]);
      setDone(true);
      props.onAdded();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="stack">
      <h2>Carteira de reserva</h2>
      <p>
        Uma carteira sua (MetaMask, Rabby…) pode ser a chave reserva da conta. Com ela você move suas moedas mesmo sem
        nenhum aparelho e sem o banco. Quem tiver essa carteira controla a conta, então guarde a frase secreta dela com
        cuidado.
      </p>
      {already && !done && <p class="fine">Sua conta já tem uma carteira de reserva (veja a lista acima).</p>}
      {done ? (
        <Notice tone="ok">Carteira de reserva adicionada. Se um dia precisar, use “Usar carteira de reserva” na tela inicial.</Notice>
      ) : !injectedWallet() ? (
        <p class="fine">Abra esta página num navegador com carteira (por exemplo no computador, com a MetaMask).</p>
      ) : wallet ? (
        <>
          <p>
            Carteira conectada: <strong>{short(wallet)}</strong>
          </p>
          <button class="btn btn-primary" onClick={add} disabled={busy}>
            {busy ? "Adicionando…" : "Adicionar como carteira de reserva"}
          </button>
        </>
      ) : (
        <button class="btn btn-secondary" onClick={connect}>
          Conectar carteira
        </button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

/** Existing device side: confirm adding the new device's passkey as an owner. */
export function LinkDevice({ identity, route }: { identity: Identity; route: Route }) {
  const payload = decodeDevice(route.query.get("k") ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!payload) {
    return (
      <Screen title="Adicionar aparelho" back="/devices">
        <Notice tone="error">Este link de aparelho está incompleto. Gere um novo no aparelho novo.</Notice>
      </Screen>
    );
  }

  async function confirm() {
    if (!payload) return;
    setBusy(true);
    setError("");
    try {
      const pk = fromPublicKey(payload.id, payload.pk);
      const signer = getAddress(await signerFor(pk.x, pk.y));
      const already = await publicClient.readContract({ address: identity.safe, abi: safeAbi, functionName: "isOwner", args: [signer] });
      await sendCalls(identity, [
        {
          to: deployment.aa.webAuthnSignerFactory,
          data: encodeFunctionData({ abi: signerFactoryAbi, functionName: "createSigner", args: [pk.x, pk.y, p256Verifiers] }),
        },
        ...(already
          ? []
          : [{ to: identity.safe, data: encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [signer, 1n] }) }]),
        {
          to: deployment.directory,
          data: encodeFunctionData({
            abi: directoryAbi,
            functionName: "linkCredential",
            args: [credentialHash(pk.id), signer, pk.x, pk.y],
          }),
        },
      ]);
      setDone(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <section class="done">
          <div class="done-mark" aria-hidden="true">
            ✓
          </div>
          <h1>Aparelho adicionado</h1>
          <p>O aparelho novo entra na sua conta em alguns segundos.</p>
          <a class="btn btn-primary" href="#/devices">
            Ver aparelhos
          </a>
        </section>
      </Screen>
    );
  }

  return (
    <Screen title="Adicionar aparelho" back="/devices">
      <p>
        O aparelho que mostrou este código vai poder pagar e receber pela sua conta. Só confirme se ele for seu e estiver
        na sua mão agora.
      </p>
      <button class="btn btn-primary" onClick={confirm} disabled={busy}>
        {busy ? "Adicionando…" : "Confirmar e adicionar"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
