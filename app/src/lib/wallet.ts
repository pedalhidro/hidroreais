import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { chain, explorerUrl } from "../config";

export const injectedWallet = () => (window as { ethereum?: EIP1193Provider }).ethereum;

/** Connects the browser wallet (MetaMask, Rabby, …) on our chain, adding the chain if needed. */
export async function connectWallet(): Promise<{ wallet: WalletClient; account: Address }> {
  const eth = injectedWallet();
  if (!eth) throw new Error("Nenhuma carteira encontrada neste navegador.");
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  const [account] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    // Unknown to the wallet yet. Our explorer, not viem's stale one for Chiado.
    await wallet.addChain({ chain: { ...chain, blockExplorers: { default: { name: "Blockscout", url: explorerUrl } } } });
  }
  return { wallet, account };
}
