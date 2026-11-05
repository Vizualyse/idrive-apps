# The Store

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- Tools need a **Releases catalog**: a repo tree only takes tools committed
  prebuilt. The **Branch** channel reads `mgu-repo.json`; **Tags** reads the
  highest tag (a fork's inherited tags point at the upstream's commit).
- An app's `package.json` `files` must all exist in the package, or the
  build on the unit refuses it ("files[] names CHANGELOG.md, which is
  missing").
- Publishing runs only in GitHub Actions (`release.js` refuses elsewhere).
  Builds are reproducible: two clean builds give the same bytes.
- Store sources: the head unit fetches only while the uplink is online; with
  no network the updater answers from what it already has.

From the reference repos (mgu-store `deploy/README.md:183-205, 823-985`):

- `component.json` fields: `files`, `units`, `enable`, `recmgr` (into both
  `[Whitelist]` and `[WhitelistExitSuccess]`, read only at boot),
  **`crashNames`** (crashhandler's whitelist), `restart`, `dropins` (e.g. for
  `mgu-render.service`, read at its next start), `internet` + `uids`,
  `mguHmi`, `mguProvides`, `keepRunning`, `postInstall`, `check` (a failure
  rolls back), `activate` / `deactivate` (root hooks; last stdout line
  `{"reboot":"why"}` marks a restart pending), `requires`, `optional`,
  `uninstallable`, `removeWhenUnused`.
- **`preload`**: a library LD_PRELOADed into a firmware process from the next
  boot behind a strike guard (`{library, unit, process, strikes,
  checkAfterSeconds, healthySeconds}`; idrive7-apps `mgu-repo.json:28-43`).
  A tested mechanism for hook111.
- App ids need a prefix: a provisioning id such as `store` hides the tile.
  `"mguAppStartType": "autostart"` starts the app with the platform and never
  stops it for inactivity. An internet-allowed app gets its lease at
  `oap_<uid>/data/uplink.json`.
- Catalog texts per language: upstream `release/README.md:34-49`.
- **mgu-uplink's firewall:** the guarded Wi-Fi interface gets `table inet
  mgu_uplink` input rules ending in `counter drop`, and a drop in any base
  chain is final: new inbound connections (our phone page on 8490) may be
  dropped despite our `ip filter` accepts. Moonlight's phone page works on
  the car, so check `nft list table inet mgu_uplink` there before relying on
  it (mgu-store `native/mgu-uplink/firewall.go:49-55`).
