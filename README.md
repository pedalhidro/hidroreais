# Moeda da comunidade

A for-fun community currency on Gnosis Chain. Members pay each other from a phone web app
with a passkey (Face ID / fingerprint), never see gas, and never write down a seed phrase.
A central bank (a Safe multisig) mints the token and is every member's recovery guardian.

```
contracts/    Solidity: token, recovery module, member directory, allowance minter (+ tests)
server/       Sponsorship policy, paymaster proxy, minimal bundler, EIP-3009 relayer, indexer, Web Push
app/          The PWA members use (pt-BR)
deployments/  Addresses + ABIs written by the deploy script, read by app and server
```

## What is built (roadmap steps 1–3)

| Step | Built |
| --- | --- |
| 1. Contracts | `CommunityToken` (ERC-20, `MINTER_ROLE`, `ENFORCER_ROLE` for confiscation and forced transfers, EIP-2612, EIP-3009), `RecoveryModule` (central bank as guardian; delay 0 = instant while testing; `takeControl` for immediate takeovers), `MemberDirectory` (names + passkey lookup), `Invites` (member invites that lock a gift, bank invites that mint per newcomer), `AllowanceMinter` (example policy minter). 35 Solidity tests. |
| 2. PWA MVP | Invite → passkey → Safe account, pay by name / QR / link, receive QR + link, activity, gas sponsored for everything, external-wallet sends via EIP-3009 relayer. |
| 3. Devices + recovery | Link a new device by QR (WhatsApp Web style), remove devices, central bank recovery console (Safe Transaction Builder export or direct send), cancel-during-delay banner, transparency page, Web Push for payments and recoveries. |

Not built yet: the WhatsApp bot, a self-hosted paymaster.

## How the pieces fit

- **Accounts.** Each member is a Safe 1.4.1 with the Safe 4337 module. The first device's passkey
  signs through Safe's `SafeWebAuthnSharedSigner`; every later device gets its own
  `SafeWebAuthnSignerProxy` and becomes an extra owner (1-of-N).
- **Recovery.** Every member Safe enables `RecoveryModule` at creation (the server refuses to
  sponsor Safes that don't). The guardian (`BANK_ADDRESS`) can add a new passkey owner and
  optionally remove all others. With `recoveryDelay = 0` it happens at once; set a delay
  later from the bank console (no redeploy) and members can cancel during the delay.
- **Finding your account on a new browser.** WebAuthn only reveals a passkey's public key at
  creation, so accounts publish `CredentialLinked(hash(credentialId), safe, signer, x, y)`.
  The app treats these as hints and verifies each on-chain (signer is an owner, and matches the key).
- **Sponsorship.** The app talks to the server's `/rpc`, never to the provider. The server
  forwards to Pimlico only for allowed calls: token transfers, directory updates, adding or
  removing owners, creating passkey signers, cancelling a recovery, and claiming the allowance.
  New accounts need an invite: a link from any member (who can lock a gift in it) or from the
  bank (which mints a set amount to each newcomer, for one or many people). The claim runs in
  the transaction that creates the Safe, so a cancelled Face ID prompt does not burn it. New Safes must match the app's exact setup
  (one passkey owner, the 4337 module, the RecoveryModule). Gas prices and limits are capped,
  and per-member daily limits apply.
- **Bundling.** The server submits sponsored operations to the EntryPoint itself, from the
  relayer key (`server/src/bundler.ts`). Pimlico only signs the sponsorship and estimates gas.
  The EntryPoint refunds the relayer from the paymaster deposit.
- **External wallets.** EIP-3009 sends are relayed only for addresses registered as members
  (`POST /admin/members`), with per-wallet and global daily caps.
- **Recovery keeper.** When the recovery delay is above zero, the server executes queued
  recoveries once they are due, paying gas from the relayer key.

## Run it on Chiado

You need: Node 22+, a funded Chiado deployer key, a Pimlico API key, and the central bank
address (a Safe on Chiado, or any EOA you control while testing).

```bash
# 1. Contracts
cd contracts && npm install
npx hardhat test solidity
npx hardhat keystore set CHIADO_RPC_URL        # https://rpc.chiadochain.net
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
BANK_ADDRESS=0xYourBank ALLOWANCE=10 npx hardhat run scripts/deploy.ts --network chiado
# → writes ../deployments/10200.json and ../deployments/abis.json
# The script reuses Safe's official 1.4.1, 4337 and passkey contracts where they exist and
# deploys copies where they don't (Chiado has none of them).

# 2. Server
cd ../server && npm install
cp .env.example .env    # fill PIMLICO_API_KEY, RELAYER_PRIVATE_KEY, ADMIN_TOKEN
npm run vapid >> .env   # Web Push keys
npm test && npm start
# Fund the relayer address it prints with a little xDAI (Chiado faucet).

# 3. App
cd ../app && npm install
cp .env.example .env    # VITE_CHAIN_ID, VITE_SERVER_URL
npm run dev             # passkeys need https or localhost

# 4. Invite yourself: open #/bank → Emitir → "Por link de convite", send it from the bank
#    wallet, then open the link it shows.
```

Passkeys require a secure origin and are bound to the domain: test on `localhost`, then deploy
the app to the long-lived domain you will keep (moving domains means re-linking everyone through
guardian recovery).

## Pilot deployment (dimdim.pedalhidrografi.co)

- **App**: static build on Cloudflare Pages at `https://dimdim.pedalhidrografi.co`. Its build
  (`app/.env.production`) points at the server and gets a CSP that only allows the server and
  the chain RPC. This domain is final: passkeys are bound to it.
- **Server**: runs on a machine of ours, published through a Cloudflare Tunnel as
  `https://dimdim-api.pedalhidrografi.co` (one subdomain level, so Cloudflare's free certificate
  covers it). Moving it to a VPS later only means repointing that hostname.

```bash
# App
cd app && npm run build
npx wrangler login                                            # once, opens the browser
npx wrangler pages deploy dist --project-name hidroreais --branch main
# then, once: Cloudflare dashboard → Workers & Pages → hidroreais → Custom domains
#             → add dimdim.pedalhidrografi.co

# Server (systemd user services; linger must be on)
cp deploy/hidroreais-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now hidroreais-server

# Tunnel (cloudflared in ~/.local/bin)
cloudflared tunnel login                                      # once, pick pedalhidrografi.co
cloudflared tunnel create hidroreais                          # prints the tunnel id
cloudflared tunnel route dns hidroreais dimdim-api.pedalhidrografi.co
cp deploy/cloudflared.yml ~/.cloudflared/hidroreais.yml       # fill in the tunnel id
cp deploy/hidroreais-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now hidroreais-tunnel
```

Set `ALLOWED_ORIGIN=https://dimdim.pedalhidrografi.co` in `server/.env` (add
`,http://localhost:5173` to keep local development working). Back up `server/data/store.json`:
most of it can be rebuilt from the chain, but push subscriptions and admin-registered wallets
cannot.

## Central bank operations

Open `#/bank` in the app. It never holds keys; it prepares calls and either downloads a batch
for the Safe Transaction Builder (bank is a Safe) or sends them from a connected wallet (bank is
a test EOA). Mint, recover an account from a member's recovery link, change the recovery delay,
activate the allowance minter.

## Known trade-offs

- Any current owner of a Safe can cancel a pending recovery, including a stolen phone whose
  lock was bypassed. If that matters, add a guardian "force" path after a second, longer delay.
- Directory names are self-chosen; the app only lists registered members, but two members can
  pick the same name.
- The Safe Transaction Builder flags exported batches without a checksum; review the calls in
  the builder before signing.
- The UI was type-checked and built but not exercised in a real browser against Chiado yet.

## Going to production

1. Set the recovery delay to 24–48 h in the bank console.
2. Make the bank a Safe multisig (and consider a separate, higher-threshold Safe as guardian).
3. Tighten `connect-src` in `app/index.html` and `ALLOWED_ORIGIN` on the server to your hosts.
4. Redeploy on Gnosis (`--network gnosis`, `CHAIN_ID=100`, `VITE_CHAIN_ID=100`).
