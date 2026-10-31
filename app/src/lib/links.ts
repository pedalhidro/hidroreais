import { isAddress, type Address, type Hex } from "viem";

export const base = () => `${location.origin}${location.pathname}`;

export function paymentLink(to: Address, amount?: string) {
  const q = new URLSearchParams({ to });
  if (amount) q.set("amount", amount);
  return `${base()}#/pay?${q}`;
}

/** Payload a new device shares so an existing device (or the central bank) can add it. */
export type DevicePayload = { id: string; pk: Hex };

const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export const encodeDevice = (p: DevicePayload) => b64(JSON.stringify(p));
export function decodeDevice(s: string): DevicePayload | null {
  try {
    const p = JSON.parse(unb64(s));
    if (typeof p.id === "string" && typeof p.pk === "string" && /^0x[0-9a-fA-F]{128}$/.test(p.pk)) return p;
  } catch {
    // fallthrough
  }
  return null;
}

export const linkDeviceLink = (p: DevicePayload) => `${base()}#/link?k=${encodeDevice(p)}`;
export const recoveryRequestLink = (p: DevicePayload) => `${base()}#/bank?recover=${encodeDevice(p)}`;

/** Turns whatever a QR code holds into an in-app route, if it is one of ours. */
export function routeFromScan(text: string): string | null {
  if (isAddress(text, { strict: false })) return `/pay?to=${text}`;
  const i = text.indexOf("#/");
  if (i >= 0) return text.slice(i + 1);
  return null;
}
