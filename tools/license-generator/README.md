# qms-license — vendor licence generator

Issues and inspects QMS licence files. **This tool never ships to a customer.**

Zero dependencies (`node:` builtins only) — no `npm install`, runs anywhere Node does.

```sh
node tools/license-generator/bin/qms-license.mjs --help
```

## Why it lives in this repo

The tool's *source* is harmless in the open: Ed25519 rests entirely on the signing key,
not on the secrecy of the code, so a separate private repo would buy no security. What it
*would* buy is a bug — the signer and core-api's verifier must agree byte-for-byte on the
token encoding, and keeping them in one repo lets `npm run verify` catch a drift that
would otherwise surface as "signature invalid" at a customer site with no network to push
a fix over.

`tools/` sits outside every Docker build context (`context: ./services/<svc>` for all six
services), so it cannot be copied into a shipped image even by accident.

## The secret is the key, not the tool

| Artefact | Where it lives | If it leaks |
|---|---|---|
| `signing-key.pem` | `~/.qms-license/` (mode 0600), **never the repo** | Anyone can mint licences for every installation ever shipped. **Unrecoverable** — you cannot revoke a key from machines that have no network. |
| `issued.jsonl` | beside the key | Customer data exposed |
| public key | committed in core-api's trusted-key table | Harmless |

`npm run verify` fails if any private key appears in the repo tree. The only permitted
exception is `test/fixtures/test-signing-key.pem`, which signs nothing real.

**Back the signing key up offline.** Lose it and you can never issue a licence for an
existing installation again — every customer would need a re-issue under a new key.

## Issuing a licence

1. The customer opens the activation page in admin and sends you the **activation
   request** — one `QMSREQ1-…` string (~340 chars) carrying their Installation ID and
   their hashed host claims. One blob rather than two copy-pastes: both halves have to
   survive WhatsApp intact.

2. Issue:

   ```sh
   node tools/license-generator/bin/qms-license.mjs issue \
     --request 'QMSREQ1-…' \
     --customer "Toko Maju Jaya" --ref INV-2026-0142 \
     --type perpetual --support-until 2027-08-18 \
     --max-counters 8 \
     --out toko-maju.lic
   ```

3. Send `toko-maju.lic` back. They upload it on the same page.

Pass `--request @file.txt` to read the blob from a file instead of the command line.

### Types

| Type | `--expires` | `--support-until` | Behaviour |
|---|---|---|---|
| `perpetual` | forbidden | **required** | Never expires. Past `--support-until` the software keeps running at full function; only the right to upgrade to the next major version lapses. |
| `trial` | **required** | forbidden | Full function until the date, then grace, then restricted. |
| `free` | forbidden | forbidden | No end date, but must cap something (`--max-counters` / `--max-categories`). |

Dates are `YYYY-MM-DD` and resolve to the **last instant of that day** in UTC — 07:00 the
next morning WIB, erring toward the customer. Impossible dates are rejected rather than
rolled over, so a mistyped `2026-02-29` fails here instead of quietly becoming March 1.

### Host binding

By default the licence is bound to the host claims in the activation request. Use
`--no-bind-host` when a customer's machine reports no usable claims — a VM, missing
fingerprint mounts, or firmware that only reports placeholder identifiers. The
Installation ID binding always applies.

`--grace-mismatch-days` (default 30) is the window before a host mismatch restricts the
store. It is deliberately longer than `--grace-expiry-days` (14): with no subscription
tier, a mismatch is the only thing that can restrict a paying perpetual customer, so a
false positive bills straight to support.

## Inspecting

```sh
node tools/license-generator/bin/qms-license.mjs inspect toko-maju.lic
```

Prints the contents and exits **1** if the signature does not verify. Contents are shown
either way — when a customer reports a problem, what the file *claims* is the first useful
thing to see.

Text outside the `-----BEGIN/END QMS LICENSE-----` markers is ignored, so a `.lic` that
arrives with a chat signature stapled on still reads correctly. Nothing outside the markers
can influence the verdict.

## The ledger

Every `issue` appends to `~/.qms-license/issued.jsonl`. There is no licence server, so
this is the **only** record of what you handed out — the alternative source during a
dispute is the customer's own copy.

```sh
node tools/license-generator/bin/qms-license.mjs list
```

## Changing the token format

`test/fixtures/golden.lic` is committed and verified by both this suite and core-api's
verifier spec. A deliberate format change means regenerating it:

```sh
node tools/license-generator/test/fixtures/make-golden.mjs
```

Every input is pinned, so a regeneration that changes nothing produces no diff. If only
one side of the format changed, the other side's test fails — which is the point.
