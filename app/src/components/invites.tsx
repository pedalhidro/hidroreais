import { useState } from "preact/hooks";
import { currency } from "../config";
import type { InviteRecord } from "../lib/chain";
import { coins } from "../lib/format";
import { inviteLink, savedInvitePk } from "../lib/invites";
import { CopyButton, QR, ShareButton } from "./ui";

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function inviteStatus(inv: InviteRecord): { open: boolean; text: string } {
  const expired = inv.expiresAt * 1000 <= Date.now();
  if (inv.closed && inv.uses >= inv.maxUses && inv.refunded === undefined) {
    return { open: false, text: inv.maxUses > 1 ? `usado por ${inv.uses} pessoas` : "aceito" };
  }
  if (inv.closed) return { open: false, text: expired ? "expirou" : "cancelado" };
  if (expired) return { open: false, text: "expirou" };
  const uses = inv.maxUses > 1 ? ` · ${inv.uses} de ${inv.maxUses} usados` : "";
  return { open: true, text: `aberto até ${when(inv.expiresAt)}${uses}` };
}

/** The link for an invite created on this device, with QR, share and copy. */
export function InviteShare({ pk, expiresAt }: { pk: `0x${string}`; expiresAt?: number }) {
  const link = inviteLink(pk);
  return (
    <section class="stack">
      <QR value={link} label="Código do convite" />
      <div class="row">
        <ShareButton text={link} title="Convite para o Hidroreais" />
        <CopyButton text={link} label="Copiar convite" />
      </div>
      {expiresAt && <p class="fine center">Vale até {when(expiresAt)}. Quem abrir o link cria a conta na hora.</p>}
    </section>
  );
}

/** A creator's invites: status, the link again (if this device made it) and cancel for open ones. */
export function InviteList(props: { invites: InviteRecord[]; onCancel: (key: string) => void; busy?: string }) {
  const [shown, setShown] = useState("");
  if (props.invites.length === 0) return <p class="empty">Nenhum convite ainda.</p>;
  return (
    <ul class="invite-list">
      {props.invites.map((inv) => {
        const status = inviteStatus(inv);
        const pk = savedInvitePk(inv.key);
        const amount = BigInt(inv.amount);
        return (
          <li key={inv.key}>
            <span>
              {amount > 0n ? `${coins(amount)} ${currency}${inv.minting ? " por pessoa" : ""}` : "Sem presente"}
              <span class="status reason">{status.text}</span>
            </span>
            {status.open && (
              <div class="row">
                {pk && (
                  <button class="btn btn-quiet" onClick={() => setShown(shown === inv.key ? "" : inv.key)}>
                    {shown === inv.key ? "Esconder link" : "Mostrar link"}
                  </button>
                )}
                <button class="btn btn-quiet" disabled={props.busy === inv.key} onClick={() => props.onCancel(inv.key)}>
                  {props.busy === inv.key ? "Cancelando…" : "Cancelar"}
                </button>
              </div>
            )}
            {status.open && pk && shown === inv.key && <InviteShare pk={pk} expiresAt={inv.expiresAt} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Expiry presets as a segmented control. */
export function ExpiryPicker(props: { value: number; onChange: (s: number) => void; presets: readonly { label: string; seconds: number }[] }) {
  return (
    <div class="field">
      <span>Validade</span>
      <div class="tabs" role="radiogroup" aria-label="Validade">
        {props.presets.map((p) => (
          <button
            type="button"
            key={p.seconds}
            role="radio"
            aria-checked={props.value === p.seconds}
            class={props.value === p.seconds ? "tab tab-on" : "tab"}
            onClick={() => props.onChange(p.seconds)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
