import { PublicKey, WebAuthnP256 } from "ox";
import { createWebAuthnCredential } from "viem/account-abstraction";
import { bytesToHex, keccak256, numberToHex, toHex, type Hex } from "viem";

export type Passkey = {
  /** WebAuthn credential id, base64url. */
  id: string;
  /** Uncompressed P-256 public key without the 0x04 prefix (64 bytes). */
  publicKey: Hex;
  x: bigint;
  y: bigint;
};

export function fromPublicKey(id: string, publicKey: Hex): Passkey {
  // Accept 64 bytes (x || y) or 65 bytes with the 0x04 uncompressed prefix.
  const hex = publicKey.slice(2);
  const body = hex.length === 130 ? hex.slice(2) : hex;
  if (body.length !== 128) throw new Error("Chave pública da passkey em formato inesperado.");
  const x = BigInt(`0x${body.slice(0, 64)}`);
  const y = BigInt(`0x${body.slice(64)}`);
  return { id, publicKey: `0x${body}`, x, y };
}

export function toPublicKey(x: bigint, y: bigint): Hex {
  return `0x${numberToHex(x, { size: 32 }).slice(2)}${numberToHex(y, { size: 32 }).slice(2)}`;
}

/** Creates a new passkey on this device (Face ID, fingerprint or screen lock prompt). */
export async function createPasskey(userName: string): Promise<Passkey> {
  const credential = await createWebAuthnCredential({
    name: userName,
    rp: { id: location.hostname, name: "Moeda da Comunidade" },
    // A random user handle per passkey. The default derives it from the name, and synced
    // keychains replace an existing passkey that has the same site + user handle.
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: userName, displayName: userName },
  });
  return fromPublicKey(credential.id, credential.publicKey);
}

/**
 * Asks the browser to let the person pick one of their existing passkeys for this site.
 * Works with synced passkeys (iCloud Keychain, Google Password Manager) and with a phone
 * nearby via QR. Returns only the credential id: WebAuthn does not reveal the public key
 * on login, which is why the directory keeps it.
 */
export type PickedPasskey = {
  id: string;
  /** True if this assertion was signed by the passkey with public key (x, y). */
  provenBy: (x: bigint, y: bigint) => boolean;
};

export async function pickPasskey(): Promise<PickedPasskey> {
  const challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const { metadata, signature, raw } = await WebAuthnP256.sign({ challenge, rpId: location.hostname });
  return {
    id: raw.id,
    // Directory entries are public and self-asserted. Proving the key with this fresh
    // signature stops anyone from pointing our credential at their own account.
    provenBy: (x, y) => {
      try {
        const publicKey = PublicKey.fromHex(`0x04${toPublicKey(x, y).slice(2)}`);
        return WebAuthnP256.verify({ challenge, metadata, signature, publicKey, rpId: location.hostname });
      } catch {
        return false;
      }
    },
  };
}

export const credentialHash = (id: string): Hex => keccak256(toHex(id));

export const passkeysSupported = () =>
  typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
