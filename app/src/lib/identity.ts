import { useEffect, useState } from "preact/hooks";
import type { Address, Hex } from "viem";

/** What this device needs to act for the member: its passkey, its signer and the Safe. */
export type Identity = {
  credentialId: string;
  publicKey: Hex;
  /** The Safe owner for this passkey: the shared signer (first device) or a signer proxy. */
  signer: Address;
  safe: Address;
  name?: string;
};

/** A passkey created on a new device that is waiting to be linked to an account. */
export type PendingDevice = { credentialId: string; publicKey: Hex; signer: Address };

const KEY = "coin.identity";
const PENDING = "coin.pending-device";
const EVENT = "coin:identity";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage blocked: the app still works for this session.
  }
  window.dispatchEvent(new Event(EVENT));
}

export const getIdentity = () => read<Identity>(KEY);
export const setIdentity = (i: Identity | null) => write(KEY, i);
export const getPendingDevice = () => read<PendingDevice>(PENDING);
export const setPendingDevice = (p: PendingDevice | null) => write(PENDING, p);

export function useIdentity(): Identity | null {
  const [identity, set] = useState(getIdentity);
  useEffect(() => {
    const on = () => set(getIdentity());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return identity;
}
