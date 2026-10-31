import type { Address } from "viem";
import { serverUrl } from "../config";
import { api } from "./chain";

export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks permission and registers this device for "payment received" and recovery alerts. */
export async function enablePush(safe: Address): Promise<void> {
  const { vapidPublicKey } = await api.config();
  if (!vapidPublicKey) throw new Error("Notificações ainda não estão configuradas no servidor.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("As notificações foram bloqueadas neste aparelho.");
  const reg = await navigator.serviceWorker.ready;
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  const res = await fetch(`${serverUrl}/push/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ safe, subscription }),
  });
  if (!res.ok) throw new Error("Não foi possível registrar as notificações.");
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}
