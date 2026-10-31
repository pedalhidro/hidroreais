import { useState } from "preact/hooks";
import { CopyButton, QR, Screen, ShareButton } from "../components/ui";
import { currency } from "../config";
import { parseAmount } from "../lib/format";
import type { Identity } from "../lib/identity";
import { paymentLink } from "../lib/links";

export function Receive({ identity }: { identity: Identity }) {
  const [amount, setAmount] = useState("");
  const valid = parseAmount(amount) !== null;
  const link = paymentLink(identity.safe, valid ? amount.replace(",", ".") : undefined);
  return (
    <Screen title="Receber" back="/">
      <QR value={link} label="Código para te pagar" />
      <p class="center">Quem for pagar escaneia este código no Hidroreais ou abre o link.</p>
      <label class="field">
        <span>Valor (opcional)</span>
        <input inputMode="decimal" value={amount} placeholder={`0 ${currency}`} onInput={(e) => setAmount(e.currentTarget.value)} />
      </label>
      <div class="row">
        <ShareButton text={link} title="Me pague em Hidroreais" />
        <CopyButton text={link} />
      </div>
    </Screen>
  );
}
