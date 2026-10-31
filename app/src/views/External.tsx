import { useEffect, useState } from "preact/hooks";
import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  toHex,
  type Address,
  type EIP1193Provider,
} from "viem";
import { Notice, Screen } from "../components/ui";
import { chain, deployment, serverUrl, symbol } from "../config";
import { api, balanceOf, type Member } from "../lib/chain";
import { coins, friendlyError, parseAmount, short } from "../lib/format";
import type { Route } from "../lib/router";

/**
 * For members who prefer MetaMask, Rabby or another wallet. They sign a free EIP-3009 message;
 * the community relayer submits it and pays the gas, so they never need xDAI.
 */
export function External({ route }: { route: Route }) {
  const eth = (window as { ethereum?: EIP1193Provider }).ethereum;
  const [account, setAccount] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [to, setTo] = useState(route.query.get("to") ?? "");
  const [amount, setAmount] = useState(route.query.get("amount") ?? "");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.directory().then(setMembers).catch(() => {});
  }, []);
  useEffect(() => {
    if (account) balanceOf(account).then(setBalance).catch(() => {});
  }, [account, status]);

  if (!eth) {
    return (
      <Screen title="Usar outra carteira" back="/">
        <Notice>
          Abra esta página dentro do navegador da sua carteira (MetaMask, Rabby…) ou num computador com a extensão
          instalada.
        </Notice>
      </Screen>
    );
  }
  const wallet = createWalletClient({ chain, transport: custom(eth) });

  async function connect() {
    setError("");
    try {
      const [a] = await wallet.requestAddresses();
      await wallet.switchChain({ id: chain.id }).catch(() => wallet.addChain({ chain }));
      setAccount(a);
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function addToken() {
    await eth!
      .request({
        method: "wallet_watchAsset",
        params: { type: "ERC20", options: { address: deployment.token.address, symbol, decimals: 18 } },
      } as never)
      .catch(() => {});
  }

  async function send(e: Event) {
    e.preventDefault();
    setError("");
    setStatus("");
    const value = parseAmount(amount);
    if (!account || !value || !isAddress(to, { strict: false })) return setError("Confira o destinatário e o valor.");
    try {
      const now = Math.floor(Date.now() / 1000);
      const message = {
        from: account,
        to: getAddress(to),
        value,
        validAfter: 0n,
        validBefore: BigInt(now + 30 * 60),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
      };
      setStatus("Assine a mensagem na carteira (não custa nada)…");
      const signature = await wallet.signTypedData({
        account,
        domain: { name: deployment.token.name, version: "1", chainId: chain.id, verifyingContract: deployment.token.address },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message,
      });
      setStatus("Enviando…");
      const res = await fetch(`${serverUrl}/relay/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...message,
          value: message.value.toString(),
          validAfter: "0",
          validBefore: message.validBefore.toString(),
          signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Falha ao enviar");
      setStatus("Pagamento enviado.");
      setAmount("");
    } catch (err) {
      setStatus("");
      setError(friendlyError(err));
    }
  }

  return (
    <Screen title="Usar outra carteira" back="/">
      {!account ? (
        <>
          <p>Conecte sua carteira para pagar em {symbol} sem precisar de xDAI para a taxa.</p>
          <button class="btn btn-primary" onClick={connect}>
            Conectar carteira
          </button>
        </>
      ) : (
        <form class="stack" onSubmit={send}>
          <p>
            Conectado: {short(account)} · saldo {balance === null ? "…" : coins(balance)} {symbol}{" "}
            <button type="button" class="btn btn-link" onClick={addToken}>
              Mostrar {symbol} na carteira
            </button>
          </p>
          <label class="field">
            <span>Para</span>
            <select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
              <option value="">Escolha um membro</option>
              {members.map((m) => (
                <option key={m.address} value={m.address}>
                  {m.name ?? short(m.address)}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>Valor em {symbol}</span>
            <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary">Assinar e pagar</button>
        </form>
      )}
      {status && <Notice tone="ok">{status}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
