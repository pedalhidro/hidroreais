import { useEffect, useState } from "preact/hooks";
import { concat, encodeFunctionData, getAddress, isAddress, pad, parseAbi, type Address, type Hex } from "viem";
import { Notice, Screen } from "../components/ui";
import { chain, currency, deployment, explorerUrl, tokenAbi } from "../config";
import { api, balanceOf, publicClient, safeAbi, type Member } from "../lib/chain";
import { coins, friendlyError, parseAmount, short } from "../lib/format";
import { connectWallet, injectedWallet } from "../lib/wallet";

const execAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

/**
 * Rescue with a backup wallet: no device, no bank. The wallet is an owner of the account (threshold
 * 1), and a Safe accepts its owner calling execTransaction as the signature (v = 1, "approved by
 * sender"). The wallet pays a little xDAI for that one transaction.
 */
export function Backup() {
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof connectWallet>> | null>(null);
  const [safe, setSafe] = useState<{ address: Address; name: string | null } | null>(null);
  const [typedSafe, setTypedSafe] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.directory().then(setMembers).catch(() => {});
  }, []);

  async function connect() {
    setError("");
    try {
      const w = await connectWallet();
      setWallet(w);
      setGas(await publicClient.getBalance({ address: w.account }));
      const found = await api.walletAccount(w.account).catch(() => null);
      if (found) await useAccount(found.safe, found.name, w.account);
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  // The server's answer is only a hint; ownership is checked on-chain.
  async function useAccount(address: Address, name: string | null, owner: Address) {
    const isOwner = await publicClient.readContract({ address, abi: safeAbi, functionName: "isOwner", args: [owner] });
    if (!isOwner) return setError("Esta carteira não é carteira de reserva dessa conta.");
    setSafe({ address, name });
    const b = await balanceOf(address);
    setBalance(b);
    setAmount(coins(b).replace(/\./g, ""));
  }

  async function send(e: Event) {
    e.preventDefault();
    if (!wallet || !safe) return;
    const value = parseAmount(amount);
    if (!value || !isAddress(to, { strict: false })) return setError("Escolha para quem e quanto.");
    setBusy(true);
    setError("");
    try {
      const transfer = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [getAddress(to), value] });
      // r = owner, s = 0, v = 1: valid because the owner itself sends the transaction.
      const signature = concat([pad(wallet.account, { size: 32 }), pad("0x0", { size: 32 }), "0x01"]);
      const zero = "0x0000000000000000000000000000000000000000";
      const hash = await wallet.wallet.writeContract({
        account: wallet.account,
        chain,
        address: safe.address,
        abi: execAbi,
        functionName: "execTransaction",
        args: [deployment.token.address, 0n, transfer, 0, 0n, 0n, 0n, zero, zero, signature],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("A transação foi incluída mas falhou na rede.");
      setTx(hash);
      setBalance(await balanceOf(safe.address));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!injectedWallet()) {
    return (
      <Screen title="Usar carteira de reserva" back="/">
        <Notice>Abra esta página num navegador com a sua carteira (por exemplo no computador, com a MetaMask).</Notice>
      </Screen>
    );
  }

  return (
    <Screen title="Usar carteira de reserva" back="/">
      <p>
        Se você perdeu os aparelhos, a carteira de reserva da sua conta pode mover as moedas sozinha, sem o banco. A
        carteira paga uma taxa pequena em xDAI.
      </p>
      {!wallet ? (
        <button class="btn btn-primary" onClick={connect}>
          Conectar carteira
        </button>
      ) : (
        <p>
          Carteira: <strong>{short(wallet.account)}</strong>
          {gas !== null && gas === 0n && <span class="reason">Ela não tem xDAI para a taxa. Coloque um pouco antes de enviar.</span>}
        </p>
      )}

      {wallet && !safe && (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (isAddress(typedSafe, { strict: false })) void useAccount(getAddress(typedSafe), null, wallet.account).catch((err) => setError(friendlyError(err)));
          }}
        >
          <p class="fine">Não achamos a conta desta carteira. Se você sabe o endereço da conta, cole aqui.</p>
          <label class="field">
            <span>Endereço da conta</span>
            <input placeholder="0x…" value={typedSafe} onInput={(e) => setTypedSafe(e.currentTarget.value.trim())} />
          </label>
          <button class="btn btn-secondary">Usar esta conta</button>
        </form>
      )}

      {safe && !tx && (
        <form class="stack" onSubmit={send}>
          <p>
            Conta <strong>{safe.name ?? short(safe.address)}</strong>: {balance === null ? "…" : `${coins(balance)} ${currency}`}
          </p>
          <label class="field">
            <span>Para quem</span>
            <select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
              <option value="">Escolha um membro…</option>
              {members
                .filter((m) => m.address.toLowerCase() !== safe.address.toLowerCase())
                .map((m) => (
                  <option key={m.address} value={m.address}>
                    {m.name ?? short(m.address)}
                  </option>
                ))}
            </select>
          </label>
          <label class="field">
            <span>ou um endereço</span>
            <input placeholder="0x…" value={to} onInput={(e) => setTo(e.currentTarget.value.trim())} />
          </label>
          <label class="field">
            <span>Quanto, em {currency}</span>
            <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary" disabled={busy}>
            {busy ? "Confirme na carteira…" : "Enviar"}
          </button>
        </form>
      )}

      {tx && (
        <Notice tone="ok">
          Enviado.{" "}
          <a href={`${explorerUrl}/tx/${tx}`} target="_blank" rel="noreferrer">
            Ver na rede
          </a>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Screen>
  );
}
