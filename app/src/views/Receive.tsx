import { useState } from "preact/hooks";
import { CopyButton, QR, Screen, ShareButton } from "../components/ui";
import { symbol } from "../config";
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
      <p class="center">Quem for pagar escaneia este código no app da moeda ou abre o link.</p>
      <label class="field">
        <span>Valor (opcional)</span>
        <input inputMode="decimal" value={amount} placeholder={`0 ${symbol}`} onInput={(e) => setAmount(e.currentTarget.value)} />
      </label>
      <div class="row">
        <ShareButton text={link} title="Me pague na moeda da comunidade" />
        <CopyButton text={link} />
      </div>
    </Screen>
  );
}
