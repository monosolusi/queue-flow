# Licensing product — contract

QMS is the **checker**. It never issues anything. Keys and the licences they
redeem into come from a separate product that lives outside this repo and is
meant to serve every product you ship.

This document is that product's specification, written from the side that has to
consume it. It lives here because the checker depends on it, so it should be
versioned next to the code that breaks if it changes. It is also complete enough
to hand to whoever — or whatever — builds the other side.

---

## 1. The two halves

The licensing product is **two components**, and conflating them causes trouble
later:

| | **Generator** (backoffice) | **Activation server** (runtime) |
|---|---|---|
| Who calls it | you | the customer's mini PC, once |
| When | when you sell something | at installation |
| Network | offline is fine | must be reachable from the public internet |
| Produces | an activation **key** + the terms attached to it | a **signed licence token** |
| Holds the signing key | no | **yes** |

The generator mints a key and records what it entitles the holder to. It signs
nothing. The activation server looks the key up, decides whether this machine may
have it, and only then signs.

## 2. Why the reply is signed

The obvious design is for the activation server to answer `{"valid": true}`. Do
not do that. Two things break:

1. **Anyone can be the server.** Point the customer's DNS at a laptop and every
   installation is free. A signature the customer's build already knows how to
   check is what makes the answer worth anything.
2. **It has to survive offline.** The token is stored and re-evaluated at every
   boot, forever, with no network. A boolean cannot be re-verified; a signed
   document can.

QMS verifies the returned token against `TRUSTED_SIGNING_KEYS`, a table compiled
into its build. A token signed by anything else is refused —
`licensing.acceptance.spec.ts` pins exactly that.

## 3. Signing key

Ed25519. Generate once, ever; it covers every product this licensing product
serves.

- Publish the **public** half as `"<keyId> <base64SpkiDer>"`, where `keyId` is
  the first 16 hex characters of `sha256(base64SpkiDer)`. Paste it into
  `services/core-api/src/infrastructure/licensing/trusted-keys.ts`.
- **Back the private half up offline.** Lose it and no existing installation can
  ever be re-licensed — every customer needs re-issuing under a new key, and
  there is no network to push that over.
- `TRUSTED_SIGNING_KEYS` is an array so a key can be rotated: add the new one,
  keep the old until every customer is re-issued, then drop it. The token's
  `kid` header selects the entry.

`QMS_RELEASE=1 npm run verify` fails while that table is empty, and core-api logs
an error at boot in a production image. A build with no key activates nothing —
that is the correct default, because a placeholder key is a key an attacker has
too.

## 4. Activation key format

What the customer types. 20 symbols, shown in groups of five:

```
XXXXX-XXXXX-XXXXX-XXXXX
```

- **Alphabet**: Crockford base32 — `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. No `I`,
  `L`, `O` (misread as `1`/`0` when a key is read aloud) and no `U`.
- **Normalisation**: upper-case; `I`/`L` → `1`; `O` → `0`; discard everything
  that is not then a symbol. So hyphens, spaces and line wraps are all ignored.
- **Check symbol**: the 20th, over the first 19:
  `ALPHABET[ (Σ value(sᵢ) · (2i+1)) mod 32 ]`, `i` from 0.
  The weights are **odd** deliberately — odd numbers are invertible mod 32, so
  every single-symbol substitution is caught. Adjacent transpositions of symbols
  differing by exactly 16 are not; that gap is known and accepted.
- **Canonical form**: the grouped, hyphenated, upper-case string. That is what
  travels on the wire, so a support ticket quoting a key is unambiguous.
- **No product prefix.** The product is identified by the token that comes back.

The checker validates this before any request leaves the building, so a typo
never reaches you as a failed redemption. Reference implementations, kept in
lock-step by shared test vectors:
`services/core-api/src/domain/licensing/value-objects/license-key.ts` and
`services/admin-service/src/lib/license-key.ts`.

Pinned vectors both sides assert — your generator must agree:

| Key | Valid |
|---|---|
| `7K3M9-QRSTV-WXYZ0-123A9` | yes |
| `00000-00000-00000-00000` | yes |
| `ZZZZZ-ZZZZZ-ZZZZZ-ZZZZQ` | yes |
| `7K3M9-QRSTV-WXYZ0-123AH` | no |
| `ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ` | no |

## 5. Redemption endpoint

### Request

```
POST /v1/activations
Content-Type: application/json
```

```json
{
  "key": "XXXXX-XXXXX-XXXXX-XXXXX",
  "installationId": "11111111-2222-4333-8444-555555555555",
  "claims": { "boardUuid": "<64 hex>" },
  "product": { "id": "qms", "majorVersion": 1 }
}
```

- `installationId` — UUID **v4**, minted by the customer's database on first
  boot and stable across restores. This is the hard binding.
- `claims` — host identity, **already SHA-256 hashed** as
  `sha256("<name>:<trimmed raw value>")`. Raw hardware identifiers never leave
  the shop. May be `{}` — a VM, or a machine whose firmware reports only
  placeholders. That is legitimate and must yield a licence with host binding
  off, not an error.
- Timeout: the client aborts after 15 s.
- **The client never retries.** Redeeming may consume a seat, so a second
  attempt is a decision for the person at the screen. Make redemption
  idempotent for the same `(key, installationId)` pair anyway — a reply lost in
  transit must not burn the seat.

### Success

```
200 OK
{ "token": "-----BEGIN QMS LICENSE-----\n…\n-----END QMS LICENSE-----" }
```

A `200` with no token, a blank token, or a body that is not JSON is treated as
`SERVER_ERROR`, never as a bad key.

### Failure

Any non-2xx with a `code`. Unknown codes fall back to `SERVER_ERROR`, which is
honest, rather than being guessed into a key problem.

| `code` | Suggested status | What the customer is told |
|---|---|---|
| `KEY_UNKNOWN` | 404 | "This key is not recognised." |
| `KEY_ALREADY_USED` | 409 | "This key is already in use on another device." |
| `KEY_REVOKED` | 403 | "This key has been disabled. Ask for a replacement." |
| `KEY_EXPIRED` | 410 | "This key is past its redemption window." |
| `PRODUCT_MISMATCH` | 409 | "This key is for a different product." |

These are not decoration. `OFFLINE`, `KEY_ALREADY_USED` and a mistyped key are
the three likely outcomes in the field and they send a technician to three
different places. Collapsing them into one message costs a return visit.

## 6. Token format

Byte-exact. A mismatch here surfaces as "signature invalid" at a shop with no
network to push a fix over.

```
-----BEGIN QMS LICENSE-----
<base64url(headerJson)>.<base64url(payloadJson)>.<base64url(signature)>
-----END QMS LICENSE-----
```

- Header: `{"alg":"Ed25519","kid":"<keyId>","v":1}`
- **The signature covers the ASCII bytes of `headerB64 + "." + payloadB64`** —
  never a re-serialised payload. Verify the bytes, *then* parse them. This is
  what removes the entire canonical-JSON class of bug.
- Text outside the markers is ignored, so a licence that arrives with a chat
  signature stapled on still reads. Nothing outside the markers can change the
  verdict.
- Lines wrapped at 64 columns; whitespace between the markers is stripped before
  decoding, so CRLF and re-wrapping survive.

### Payload

```json
{
  "licenseId": "<uuid v4>",
  "issuedAt": "<ISO 8601>",
  "customer": { "name": "Toko Maju Jaya", "ref": "INV-2026-0142" },
  "product": { "id": "qms", "majorVersion": 1 },
  "type": "perpetual",
  "installationId": "<uuid v4, echoed from the request>",
  "expiresAt": null,
  "supportUntil": "2027-08-18T23:59:59.999Z",
  "host": {
    "bind": true,
    "claims": { "boardUuid": "<64 hex, echoed from the request>" },
    "weights": { "boardUuid": 2 }
  },
  "entitlements": { "maxCounters": 8, "maxCategories": 10, "features": [] },
  "grace": { "expiryDays": 14, "mismatchDays": 30 }
}
```

Rules the checker enforces, so the generator must too — `License.fromPayload`
rejects a payload that breaks them, which means a mis-issued trial cannot
silently become a perpetual:

| `type` | `expiresAt` | `supportUntil` | Behaviour |
|---|---|---|---|
| `perpetual` | must be `null` | **required** | Never expires. Past `supportUntil` the software keeps running at full function; only the right to upgrade to the next major version lapses. |
| `trial` | **required** | must be `null` | Full function until the date, then grace, then restricted. |
| `free` | must be `null` | must be `null` | No end date, but must cap something. |

- All UUIDs are **v4** specifically.
- Dates resolve to the **last instant** of the day, UTC — `23:59:59.999Z`,
  erring toward the customer. Reject impossible dates rather than rolling them
  over: `2026-02-29` must fail at issue, not quietly become 1 March.
- `host.bind: true` with no claims is an error at issue time. If the request
  carried no claims, issue with `bind: false`.
- Claims that are not 64-character lowercase hex are dropped, never carried as
  placeholders.
- `grace.mismatchDays` is deliberately longer than `grace.expiryDays`. With no
  subscription tier, a host mismatch is the only thing that can restrict a
  paying perpetual customer, so a false positive bills straight to support.

### Entitlements are opaque to you

The generator does **not** need to know what `maxCounters` means. Store a
per-product entitlements template with the key and copy it into the payload
verbatim. That is what keeps the licensing product universal, and it is also why
adding a QMS entitlement later needs no change on your side.

## 7. Seats, deactivation and re-activation

QMS ships **no deactivation button**. Releasing a seat is entirely yours, from
the backoffice. The customer then simply redeems the same key again, and the
checker replaces its licence in one transaction — proven by
`re-activates cleanly, which is what makes vendor-side seat release work` in the
acceptance suite.

What the checker guarantees you can rely on:

- Redeeming again over an existing licence leaves **exactly one** active licence
  and writes an audit entry naming the admin who did it.
- A refused re-activation leaves the working licence untouched. A customer
  cannot lose a good licence by trying.
- Re-activation is admin-authenticated once a store is licensed; it is open
  only while the store is `RESTRICTED`, which is the fresh-install case where no
  account exists yet.

Decisions that are yours, and that this repo takes no position on:

- How many activations one key allows.
- What happens when a `pgdata` volume is restored onto new hardware: the
  `installationId` travels with it, the host claims do not.
- How many times a key may be redeemed after a clean reinstall (new
  `installationId`, same customer).
- Who may reset a seat, and what is recorded when they do.

## 8. What revocation actually reaches

Say this plainly to customers and to yourself: **an activated machine never
checks in again.** Revoking a key blocks *new* activations only. An installation
that already holds a signed token runs until that token's own date passes.

This is a deliberate trade for a product sold as an offline queue system, not an
oversight. If you ever want revocation to reach live installations, it needs a
periodic re-check with a long offline grace — a change to this contract and to
NFR-REL-01, not a configuration setting.

## 9. Format drift

`tools/license-format/test/fixtures/golden.lic` is committed here and verified by
both this repo's suites. It is the drift gate.

If the token format ever changes on your side, regenerate it here
(`node tools/license-format/test/fixtures/make-golden.mjs`) in the same change.
If only one side moves, the other side's test fails — which is the point.
