# Install runbook — mini PC deployment

For the technician setting up a store. Assumes a Linux mini PC with Docker
installed and no internet at the store beyond the initial image build.

---

## 0. Before the very first release (vendor, once ever)

`services/core-api/src/infrastructure/licensing/trusted-keys.ts` ships **empty**,
so a stock build trusts no licence and every store stays on the activation
screen. Generate the signing key and paste in the line it prints:

```sh
node tools/license-generator/bin/qms-license.mjs keygen
```

`npm run verify` warns while this is unset, and **`QMS_RELEASE=1 npm run verify`
fails** — wire that into the release pipeline so an un-keyed image can never
ship. core-api also logs an error at boot if a production build has no key.

**Back that key up offline.** Lose it and you can never issue a licence for an
existing installation again — every customer would need re-issuing under a new
key. It lives at `~/.qms-license/signing-key.pem` (mode 0600), never in the repo;
`npm run verify` fails if a private key appears in the tree.

---

## 1. Prepare the OS

If you image one mini PC and clone the disk to the rest — which is the sane way
to do this at volume — **you must regenerate the machine id on every clone**:

```sh
sudo rm -f /etc/machine-id /var/lib/dbus/machine-id
sudo systemd-machine-id-setup
sudo reboot
```

`/etc/machine-id` is written once at OS install. A cloned disk carries the
source machine's id, so without this step every unit in the fleet reports the
same identity and one of the two licence host claims silently stops
distinguishing anything. `product_uuid` (the motherboard's, weight 2) is immune,
which is why it carries the heavier weight — but do not lean on that alone.

Verify the two claims are readable and distinct per unit:

```sh
cat /etc/machine-id
sudo cat /sys/class/dmi/id/product_uuid
```

If `product_uuid` reads `Default string`, `To be filled by O.E.M.` or
`03000200-0400-0500-0006-000700080009`, the board is reporting a model rather
than a machine. QMS filters those out automatically — the unit simply falls back
to `machine-id` alone, and you may want to issue its licence with
`--no-bind-host`.

---

## 2. Enable host fingerprint mounts

```sh
cd /opt/qms
ln -sf docker-compose.prod.yml docker-compose.override.yml
```

Compose auto-loads `docker-compose.override.yml`, so bring-up stays one command.
Without this the licence still works — host claims read as unavailable, which
never blocks — but host binding is not enforced, and core-api logs a warning
saying so at boot.

---

## 3. Bring the stack up

```sh
docker compose up -d
```

Then open `http://antrian.local/` (or the server IP). A clean browser lands on
the activation page.

---

## 4. Activate

1. On `/admin/aktivasi`, press **Salin Kode** — one `QMSREQ1-…` string.
2. Send it to the vendor (WhatsApp / email).
3. The vendor issues the licence:

   ```sh
   node tools/license-generator/bin/qms-license.mjs issue \
     --request 'QMSREQ1-…' \
     --customer "Toko Maju Jaya" --ref INV-2026-0142 \
     --type perpetual --support-until 2027-08-18 \
     --max-counters 8 --out toko-maju.lic
   ```

4. Send `toko-maju.lic` back. Upload or paste it on the same page.

The store now redirects to the first-run wizard. Licence first, setup second.

---

## 5. Verify

```sh
# Should print SIGNATURE: VALID and the right customer.
node tools/license-generator/bin/qms-license.mjs inspect toko-maju.lic
```

In the admin panel, **Konfigurasi Sistem → Lisensi** should show *Aktif*, and the
Perangkat section should say the licence matches this device. If it says the
device identity cannot be read, step 2 was skipped.

---

## Later: replacing hardware

A replaced motherboard changes `product_uuid`, so the licence drops to a host
mismatch. The store keeps running at full function for **30 days** with a banner;
inside that window, send the new activation request and issue a replacement
licence. Reinstalling the OS on the *same* board changes only `machine-id`, which
on its own is not enough to trigger a mismatch — that case needs no action.

## Later: moving to a new mini PC

Restoring the `pgdata` volume onto new hardware carries the installation id with
it, so the licence is still "for" this installation — but the host claims will
not match, and after the grace window the kiosk stops issuing new tickets while
the existing queue drains. Issue a replacement licence against the new
activation request.
