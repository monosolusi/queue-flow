# Install runbook

Three audiences, three sections. Find yours and stop there.

Licences are issued by a separate licensing product, not by anything in this
repo. Its contract is in [`LICENSE-SERVER-CONTRACT.md`](LICENSE-SERVER-CONTRACT.md).

---

## Vendor — once, ever

Paste the **public** half of your licensing product's Ed25519 signing key into
`services/core-api/src/infrastructure/licensing/trusted-keys.ts`, in the
`{ keyId, publicKeyDerB64 }` form it prints.

That table ships empty, so until this is done every build refuses every key.
`QMS_RELEASE=1 npm run verify` fails while it is empty, `npm run release`
refuses outright, and core-api logs an error at boot in a production image.

One key covers every product that licensing product serves. **Back the private
half up offline** — lose it and no existing installation can ever be
re-licensed.

## Vendor — per release

```sh
cp .env.example .env      # set QMS_REGISTRY, pin QMS_VERSION
npm run release           # build, tag, push
```

## Technician — per store

The mini PC needs Docker, the shop network, and internet **during install
only**.

```sh
./install.sh
```

That pulls the published images, enables host-identity binding on Linux, and
starts everything. Re-running it is safe, and is also how a store is upgraded.

Then open `http://antrian.local/` (or the machine's IP) on any device on the
shop network. The activation page opens by itself.

## Whoever is standing at the screen — activate

Type the **Activation Key** the vendor sent — 20 characters, shown as
`XXXXX-XXXXX-XXXXX-XXXXX` — and press **Aktifkan**.

Upper/lower case, hyphens and stray spaces do not matter. A mistyped key is
caught before anything is sent.

**Activation needs the internet, once.** If this machine has no connection,
plug in a LAN cable with internet or share a phone hotspot first. After
activation the system runs entirely offline and never calls out again.

The store then moves on to the setup wizard. Licence first, setup second.

---

## When something goes wrong

| What the screen says | What it means | What to do |
|---|---|---|
| No internet connection | This machine cannot reach the licensing server | Tether a phone or plug in an internet LAN cable, then press Aktifkan again. Only needed this once. |
| Server did not answer in time | There *is* a connection, just a slow one | Wait a moment and press Aktifkan again. |
| Key looks mistyped | Failed its own checksum; never left the machine | Re-read the key. `0`/`O` and `1`/`I` are interchangeable, so those are not the problem. |
| Key already used on another device | It is bound to a different installation | Call the vendor to release the seat, then activate again with the same key. |
| Key not recognised / disabled / past its date | The vendor's records disagree | Call the vendor. Quote the **ID Perangkat** shown at the bottom of the page. |
| Licence not issued by this provider | The reply was not signed by a key this build trusts | Stop and call the vendor. Do not retry — something is wrong with the build or the network path. |

### Replacing the motherboard

The board identity changes, so the licence drops to a host mismatch. The store
keeps running at full function for **30 days** with a banner. Inside that
window, have the vendor release the seat and activate again with the same key.

Reinstalling the OS on the *same* board changes nothing — that case needs no
action.

### Moving to a new mini PC

Restoring the `pgdata` volume carries the installation identity with it, so the
licence is still "for" this installation — but the board identity will not
match, and after the grace window the kiosk stops issuing new tickets while the
existing queue drains. Have the vendor release the seat and activate again.

### The board reports a placeholder identity

`install.sh` says so if it does — some mini PCs report a model rather than a
machine. Tell the vendor: that unit needs its licence issued without host
binding. Nothing else changes.

### Running fully offline afterwards

Once activated, nothing in the stack contacts the internet. To upgrade a store
with no connection at all, copy the images across yourself and run
`./install.sh --no-pull`.
