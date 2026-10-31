# CLAUDE.md

Community currency on Gnosis Chain, for a ~200-person hobby community. Members pay each
other from a phone PWA with a passkey. They never hold xDAI, see gas, or write down a seed
phrase. A central bank (a Safe multisig) mints the token and is every member's recovery
guardian. Design rationale lives in the "Community Currency: Architecture" doc. README.md
covers setup.

## Layout

```
contracts/    Hardhat 3, Solidity 0.8.28. Token, RecoveryModule, MemberDirectory, Invites, AllowanceMinter
server/       Node + Hono. Sponsorship policy, paymaster proxy, minimal bundler, EIP-3009 relayer,
              invites, log indexer, Web Push, recovery keeper
app/          Vite + Preact PWA. UI copy is Brazilian Portuguese
deployments/  <chainId>.json (addresses) + abis.json, written by contracts/scripts/deploy.ts
              and read by both app and server. Never hand-edit; redeploy instead.
```

## Commands

```bash
cd contracts && npm test                      # Solidity tests (forge-std style, run by Hardhat)
cd contracts && BANK_ADDRESS=0x… npm run deploy:chiado   # also regenerates deployments/abis.json
cd server && npm test && npm run typecheck    # policy tests (node:test via tsx)
cd server && npm start                        # needs .env (see .env.example)
cd app && npm run dev                         # passkeys need https or localhost
cd app && npm run build                       # tsc + vite build
cd app && npx wrangler pages deploy dist --project-name hidroreais   # app → dimdim.pedalhidrografi.co
```

After any contract ABI change, rerun the deploy script (or at least a local run without
`--network`) so `deployments/abis.json` stays in sync. Delete `deployments/31337.json`
afterwards; it is only a local dry run.

## Invariants (keep these true when changing things)

- **Sponsorship is an allow-list.** `server/src/policy.ts` decides what the central bank pays
  gas for: `checkCalls` (targets and functions), `checkDeployment` (exact Safe setup) and
  `checkGas` (fee and limit caps). Any new call the app sends from a member Safe must be
  added to `allowed` in `policy.ts`, with a test in `server/test/policy.test.ts`. Otherwise
  the paymaster refuses it. Never allow `value > 0`, delegatecall outside
  MultiSendCallOnly, `enableModule`, or `setFallbackHandler`.
- **New Safes have one exact shape.** Safe 1.4.1, one owner (`SafeWebAuthnSharedSigner`),
  threshold 1, fallback handler = Safe4337Module, modules = [Safe4337Module,
  RecoveryModule], no payment. The app builds this in `app/src/lib/account.ts`
  (`safeAccount`) and the server enforces it in `checkDeployment`. Change them together.
  Changing `safeModules` or the salt changes every member's counterfactual address.
- **Devices are owners.** The first device signs through the shared signer. Later devices
  get a `SafeWebAuthnSignerProxy` (via `SafeWebAuthnSignerFactory.createSigner`) added as an
  extra owner, threshold stays 1. The app passes the device's signer as permissionless's
  `safeWebAuthnSharedSignerAddress`; that name is misleading, any WebAuthn signer works.
- **Credential lookup is untrusted input.** `MemberDirectory.CredentialLinked` events are
  self-asserted. `lookupCredential` (app/src/lib/chain.ts) must only accept a row whose key
  is proven: a fresh WebAuthn signature on login (`pickPasskey().provenBy`), or the key this
  device created (NewDevice). It then checks on-chain that the signer is a Safe owner and
  matches the key. Don't weaken either step.
- **Invites are spent on deployment, not on request.** A new Safe's first batch calls
  `Invites.claim`, so the invite is used up only in the transaction that creates the
  account. The server sponsors a deployment only if `findClaim` finds that claim and
  `Invites.claimable(key, sender, sig)` passes. Membership is `Invites.joined` (indexed,
  with an on-chain fallback in `isMemberNow`). An unfinished signup's passkey
  (`coin.signup-passkey`) is kept for one retry: if its Safe already exists the app just
  finishes, otherwise it tries once more and then forgets it (it may have been deleted).
- **An invite is a throwaway key.** Its private key lives only in the link fragment
  (`#/welcome?i=…`) and in the creator's localStorage (`coin.invite-keys`). The claim
  signs (chainId, Invites, account), so a copied transaction can't redirect it. Member
  invites lock coins (0 is fine, `approve` is sponsored only towards Invites) and are
  capped per member; bank invites mint per claim and can be multi-use. Expired member
  invites are refunded by the server keeper (`refundExpiredInvites`).
- **Backup wallets are plain owners.** A member can add a wallet (MetaMask, Rabby…) as an
  extra Safe owner from Aparelhos (`BackupWallet`); only a connected wallet, never a typed
  address. It rescues funds without devices or the bank at `#/backup`: the wallet calls
  `execTransaction` itself with a v=1 "approved by sender" signature and pays its own xDAI.
  The server learns which wallet belongs to whom by multicalling `getOwners` (wallets.ts);
  owners with code are passkey signers. Treat `/wallet/:address` as a hint and re-check
  `isOwner` on-chain.
- **Passkeys get a random WebAuthn user handle.** Synced keychains replace passkeys sharing
  rpId + user handle. Don't go back to deriving it from the name.
- **Recovery delay is a setting.** `RecoveryModule.recoveryDelay` is 0 while testing
  (instant recovery). Production is 24 to 48 h, set from the bank console, with no
  redeploy. With a delay, the server keeper (`executeDueRecoveries`) executes due
  recoveries, and any current owner can cancel.
- **The bank console never holds keys.** `#/bank` prepares calls, then exports a Safe
  Transaction Builder batch or sends from a connected EOA, but only if that EOA is the bank.
- **Passkeys are bound to the app's domain.** Moving the PWA to a new domain means every
  member re-links through guardian recovery. Pick the domain once.

## Conventions

- **Language.** UI strings are pt-BR, plain and in sentence case. Code, comments and
  server errors are English. `friendlyError` (app/src/lib/format.ts) maps server and
  wallet errors to Portuguese; extend it when adding a new server error message.
- **Amounts.** The token has 18 decimals. Parse user input with `parseAmount` (it accepts
  a comma decimal separator) and display with `coins`.
- **Addresses.** Store and compare them lowercase on the server. Use `isAddressEqual` or
  `sameAddress`, never `===` on mixed case.
- **State.** The server keeps state in one JSON file (`server/data/store.json`, via
  `store.ts`). Use `saveNow()` after anything that must survive a crash (invites,
  members); use `save()` for the index.
- **Styles.** One stylesheet, `app/src/styles.css`, with an azulejo palette. The cobalt
  balance tile is the single bold element; keep everything else quiet.
- **Dependencies.** Pinned versions that matter: viem 2.57, permissionless 0.5.2, Safe
  1.4.1, Safe 4337 module 0.3.0, safe-passkey 0.2.x, EntryPoint 0.7.

## Gotchas

- Hardhat compiles with `node_modules/solc/soljson.js` (see `hardhat.config.ts`), so it
  works without downloading a compiler. If you bump solc, bump the npm `solc` package too.
- Chiado has no official Safe 1.4.1 (only 1.3.0), passkey or 4337 module deployments.
  `deploy.ts` deploys copies where the canonical address is empty, and the addresses in
  `deployments/10200.json` are the ones to use.
- On Chiado, Pimlico's `pimlico_getUserOperationGasPrice` and `eth_sendUserOperation` return
  "Internal error from bundler" (its paymaster and gas estimation work). So the server
  computes fees from the node when the gas price call fails (`userOpGasPrice`) and submits
  operations itself (`bundler.ts`). Every upstream error is logged as `upstream <method>`.
- Pimlico's gas estimate is too low for passkeys behind a `SafeWebAuthnSignerProxy` (linked
  or recovered devices): validation ran out of gas and surfaced as "AA24 signature error"
  even though the signature was valid. The server adds `VERIFICATION_HEADROOM` to
  `verificationGasLimit` in `eth_estimateUserOperationGas` responses. If AA24 comes back,
  replay the logged operation's signature before blaming the passkey.
- The P-256 verifier config is the verifier address only (`p256Verifiers` in
  app/src/config.ts), with no RIP-7212 precompile flag. Keep the app and the server's
  `checkDeployment` in agreement.
- On iPhone, Web Push only works from the home-screen PWA. Links tapped in WhatsApp open
  in Safari, so `#/pay?to=…` must work in a plain browser tab.
- `index.html` has a CSP. Builds narrow `connect-src` to `VITE_SERVER_URL` and the RPC
  (vite.config.ts `build-csp`); dev relaxes it (`dev-csp`). The pilot runs on
  dimdim.pedalhidrografi.co (app) and dimdim-api.pedalhidrografi.co (server); see README.

## Status

- Built: roadmap steps 1 to 3 (contracts, PWA MVP, devices and recovery).
- Tests: 35 Solidity tests pass, and the server policy tests pass.
- Live pilot on Chiado: app at dimdim.pedalhidrografi.co (Cloudflare Pages), server on a
  workstation through a Cloudflare Tunnel (dimdim-api), temporary until it moves to a VPS.
- Exercised on Chiado: deploy, passkey signup in Chrome, a bank invite (mint on claim) and
  a member invite with a gift, all through the server's own bundler. Linking a second
  device worked, but a payment from that device failed with AA24 (signature); not yet
  explained (rejected operations are now logged by bundler.ts). Not yet exercised:
  payments between members, recovery, the bank's enforcement actions.
- The central bank can mint, confiscate (burn), force transfers and take control of an
  account at once (no delay, no cancel). Each coercive action needs a reason, which the
  transparency page shows.
- Not built: the WhatsApp bot, a self-hosted paymaster, and a guardian "force
  recovery" path (today a stolen device can cancel a pending recovery).
