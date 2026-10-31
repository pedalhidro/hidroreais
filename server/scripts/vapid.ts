// Prints a VAPID key pair for Web Push. Put them in .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
import webpush from "web-push";
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
