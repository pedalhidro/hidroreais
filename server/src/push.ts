import webpush, { type PushSubscription } from "web-push";
import { config } from "./config.js";
import { save, state } from "./store.js";

if (config.vapid) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

export function subscribe(safe: string, sub: PushSubscription) {
  const key = safe.toLowerCase();
  const list = (state.subscriptions[key] ??= []);
  if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
  save();
}

export function notify(safe: string, title: string, body: string) {
  if (!config.vapid) return;
  const key = safe.toLowerCase();
  const list = state.subscriptions[key];
  if (!list?.length) return;
  const payload = JSON.stringify({ title, body, url: "/#/" });
  for (const sub of [...list]) {
    webpush.sendNotification(sub, payload).catch((err: { statusCode?: number }) => {
      // 404/410: the browser dropped the subscription; forget it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        state.subscriptions[key] = (state.subscriptions[key] ?? []).filter((s) => s.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}
