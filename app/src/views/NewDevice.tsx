import { useEffect, useState } from "preact/hooks";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { CopyButton, Notice, QR, Screen, ShareButton } from "../components/ui";
import { deployment, directoryAbi } from "../config";
import { sendCalls } from "../lib/account";
import { api, lookupCredential, publicClient, safeAbi, signerFor } from "../lib/chain";
import { friendlyError } from "../lib/format";
import { getPendingDevice, setIdentity, setPendingDevice, type PendingDevice } from "../lib/identity";
import { linkDeviceLink, recoveryRequestLink } from "../lib/links";
import { createPasskey, credentialHash, fromPublicKey, passkeysSupported } from "../lib/passkey";
import { go } from "../lib/router";

/**
 * New device side of linking. This device creates its own passkey and shows it as a QR code.
 * Either an existing device of the member scans it (instant), or the member sends the
 * recovery link to the central bank, which adds the passkey through the RecoveryModule.
 */
export function NewDevice() {
  const [pending, setPending] = useState<PendingDevice | null>(getPendingDevice);
  const [busy, setBusy] = useState(false);
  const [recoveredSafe, setRecoveredSafe] = useState<Address | null>(null);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const passkey = await createPasskey("Moeda da comunidade");
      const signer = await signerFor(passkey.x, passkey.y);
      const p = { credentialId: passkey.id, publicKey: passkey.publicKey, signer };
      setPendingDevice(p);
      setPending(p);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  // Wait until another device (or the central bank) adds this passkey to an account.
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const own = fromPublicKey(pending.credentialId, pending.publicKey);
    const isMine = (x: bigint, y: bigint) => x === own.x && y === own.y;
    const tick = async () => {
      try {
        const identity = await lookupCredential(pending.credentialId, isMine);
        if (identity && !stop) {
          setPendingDevice(null);
          setIdentity(identity);
          go("/");
          return;
        }
        const recovered = (await api.recoveredBy(pending.signer)).at(-1);
        if (recovered && !stop) {
          const safe = getAddress(recovered.safe);
          // Only trust the event if this passkey's signer really is an owner now.
          const owner = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [pending.signer] });
          if (owner) setRecoveredSafe(safe);
        }
      } catch {
        // keep polling
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pending?.credentialId]);

  /** After a recovery, this device announces its passkey so other browsers can find it. */
  async function finishRecovery() {
    if (!pending || !recoveredSafe) return;
    setBusy(true);
    setError("");
    try {
      const pk = fromPublicKey(pending.credentialId, pending.publicKey);
      const identity = { ...pending, safe: recoveredSafe };
      await sendCalls(identity, [
        {
          to: deployment.directory,
          data: encodeFunctionData({
            abi: directoryAbi,
            functionName: "linkCredential",
            args: [credentialHash(pk.id), pending.signer, pk.x, pk.y],
          }),
        },
      ]);
      setPendingDevice(null);
      setIdentity(identity);
      go("/");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!passkeysSupported()) {
    return (
      <Screen title="Adicionar aparelho" back="/">
        <Notice tone="error">Este navegador não suporta passkeys. Use o Safari (iPhone) ou o Chrome (Android).</Notice>
      </Screen>
    );
  }

  if (!pending) {
    return (
      <Screen title="Adicionar este aparelho" back="/">
        <p>
          Este aparelho vai criar a própria passkey. Depois, você confirma no aparelho que já usa a moeda, ou pede ao
          banco central para adicioná-la se perdeu os outros.
        </p>
        <button class="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? "Criando passkey…" : "Criar passkey neste aparelho"}
        </button>
        {error && <Notice tone="error">{error}</Notice>}
      </Screen>
    );
  }

  const payload = { id: pending.credentialId, pk: pending.publicKey };
  const link = linkDeviceLink(payload);
  const recovery = recoveryRequestLink(payload);

  if (recoveredSafe) {
    return (
      <Screen title="Conta recuperada">
        <p>O banco central adicionou este aparelho à sua conta. Falta um passo: confirme com sua passkey.</p>
        <button class="btn btn-primary" onClick={finishRecovery} disabled={busy}>
          {busy ? "Confirmando…" : "Concluir"}
        </button>
        {error && <Notice tone="error">{error}</Notice>}
      </Screen>
    );
  }

  return (
    <Screen title="Adicionar este aparelho" back="/">
      <h2>Com outro aparelho seu</h2>
      <p>Abra a moeda no aparelho que você já usa, vá em “Aparelhos” e escaneie este código.</p>
      <QR value={link} label="Código para adicionar este aparelho" />
      <div class="row">
        <CopyButton text={link} />
      </div>
      <p class="fine waiting">Esperando a confirmação…</p>

      <h2>Perdeu todos os aparelhos?</h2>
      <p>Mande este link para o banco central. Eles confirmam que é você e adicionam este aparelho à sua conta.</p>
      <div class="row">
        <ShareButton text={recovery} title="Pedido de recuperação de conta" />
        <CopyButton text={recovery} label="Copiar pedido" />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <button
        class="btn btn-link"
        onClick={() => {
          setPendingDevice(null);
          setPending(null);
        }}
      >
        Começar de novo
      </button>
    </Screen>
  );
}
