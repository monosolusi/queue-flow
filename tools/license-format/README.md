# `@qms/license-format` — the licence wire format, and its golden fixture

**This is not a tool.** Nothing here issues a licence. Activation keys and the
tokens they redeem into are produced by the separate licensing product, which
lives outside this repo and serves every product we ship. Its contract is
documented in [`docs/LICENSE-SERVER-CONTRACT.md`](../../docs/LICENSE-SERVER-CONTRACT.md).

What survives here is the format itself, kept for one reason: core-api's
`Ed25519LicenseTokenVerifier` needs an **independent twin** to be checked
against. The signer and the verifier must agree byte-for-byte on the token
encoding, and a disagreement surfaces as "signature invalid" at a customer site
with no network to push a fix over. So:

- `src/token.mjs` — armor, encode, sign, verify.
- `src/payload.mjs` — the payload shape and its type↔date-window rules.
- `test/fixtures/golden.lic` — a licence with every input pinned. **Both** this
  suite and core-api's verifier spec check these exact bytes. An encoding change
  on either side fails a test instead of failing a store.
- `test/fixtures/test-signing-key.pem` — signs nothing real. The only private
  key `npm run verify`'s leak gate permits in the tree.

It is also what `scripts/verify-topology.mjs` uses to mint a real licence for
its tier-2 smoke test, and what `services/core-api/test/acceptance/_helpers.ts`
uses to stand up a fake activation server.

```sh
npm test          # from this directory
```

## Changing the format

Don't, unless the licensing product changes with it. If it does:

```sh
node test/fixtures/make-golden.mjs
```

Every input is pinned, so a regeneration that changes nothing produces no diff.
If only one side of the format changed, the other side's test fails — which is
the point.
