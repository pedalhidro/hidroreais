// Creates invite codes and prints signup links.
//   npm run invite -- 5 "pilot group"
const [count = "1", note] = process.argv.slice(2);
const server = process.env.SERVER_URL ?? "http://localhost:8787";
const app = process.env.APP_URL ?? "http://localhost:5173";
const res = await fetch(`${server}/admin/invites`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  body: JSON.stringify({ count: Number(count), note }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const { codes } = (await res.json()) as { codes: string[] };
for (const code of codes) console.log(`${app}/#/welcome?invite=${code}`);
