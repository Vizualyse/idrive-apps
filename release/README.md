# Releases

`release.js` builds the repository's components from HEAD and publishes
them with the catalog the [mgu Store](https://github.com/robertnisipeanu/mgu-store)
reads (its `docs/PUBLISHING.md`, "2. Catalog"): each tool with a
`native/<id>/component.json` as a tool kit, each app with an
`apps/<id>/release.json` (a source package the head unit builds).

```sh
node release/release.js list                          # versions and publish state
node release/release.js build [<id>...]               # artifacts and catalog.json into release/out/
node release/release.js check [<id>...]               # build twice, compare byte for byte
node release/release.js bump <id> <x.y.z>             # set a component's version
node release/release.js publish [<id>...] [--dry-run] # (GitHub Actions) new versions, then the catalog
node release/release.js publish --from=<dir> [<id>...] # the same, with the artifacts `build` left in <dir>
MGU_PUBLISH=dir:<folder> node release/release.js publish   # a local catalog (emulator, USB stick)
node release/test/release_test.js
```

**Versions.** One version has exactly one artifact. Builds run on
`git archive HEAD` with `SOURCE_DATE_EPOCH` from the last commit that
touched what the component ships. A change to that needs a new version
(`bump`); `publish` skips a version already published with other bytes.
A tool kit holds what mgu-store's `deploy/hu artifact` packs, byte for byte.

**The platform.** A component's `"platform"` pin (a tool's
component.json, an app's release.json) names a version of each
[`platform/`](../platform/README.md) module it uses and the files it copies.
The packer and each app's `build.js` write those copies before building, and
the copied platform files count as shipped: moving a tool to another module
version changes its kit, so it needs a bump. `node platform/platform.js use
<module> <x.y.z>` moves the pins and bumps for you.

**Catalog.** The release `catalog` holds `catalog.json` (schema 2); each
version is the release `<id>@<version>`, its artifact the one asset. An
entry's `artifact.url` is the asset's release download
(`https://github.com/<owner>/<repo>/releases/download/<tag>/<name>`) while
this repository is public, which a car without a GitHub sign-in downloads
without GitHub's API and its rate limit, and the asset's API URL while it
is private. `publish` lists the entries it carries over the same way, and
publishes the catalog when only that changed.

| Entry | Fields |
|---|---|
| `vizualyse-cast` (tool) | `requires: {"mgu-deploy": "0.7.0", "cluster-render": …, "mgu-python": …, "mgu-uplink": …}`, `internet` with uid 12999, `uninstallable`, `mguHmi: ["ID7"]` (`native/vizualyse-cast/component.json`) |
| `vizualyse-moonlight` (tool) | `requires: {"mgu-deploy": "0.7.0", "mgu-python": …, "mgu-render": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`native/vizualyse-moonlight/component.json`) |
| `vizualyse_moonlight` (app) | `build: "unit"`, `requires: {"vizualyse-moonlight": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/vizualyse_moonlight/release.json`) |
| `vizualyse-chromium` (tool) | `requires: {"mgu-deploy": "0.7.0", "mgu-render": …}`, `uninstallable`, `mguHmi: ["ID7"]`, `internet` + uid 12997; ships a ~250 MB `chromium.tgz` (`native/vizualyse-chromium/component.json`) |
| `vizualyse_chromium` (app) | `build: "unit"`, `requires: {"vizualyse-chromium": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/vizualyse_chromium/release.json`) |
| `vizualyse_cast` (app) | `build: "unit"`, `requires: {"vizualyse-cast": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/vizualyse_cast/release.json`) |
| `vizualyse-steam` (tool) | `requires: {"mgu-deploy": "0.7.0", "mgu-python": …, "mgu-render": …}`, `uninstallable`, `mguHmi: ["ID7"]`, `internet` + uid 12996; ships `runtime.tgz`, `proton.tgz`, `prefix.tgz` (~410 MB) (`native/vizualyse-steam/component.json`) |
| `vizualyse_steam` (app) | `build: "unit"`, `requires: {"vizualyse-steam": …}`, `uninstallable`, `mguHmi: ["ID7"]` (`apps/vizualyse_steam/release.json`) |

New app ids start with `vizualyse_` (`APP_ID_PREFIX` in release.js).

The catalog is not signed: the Store fetches it over HTTPS and checks each
artifact's size and sha256 against it.

**Publishing.** `.github/workflows/release.yml` runs `publish` on a `v*` tag,
or by hand (Actions, Release, with the component ids or none for all), from
`main`, with the workflow's `GITHUB_TOKEN` (`contents: write`). It publishes
whether this repository is private or public
(`MGU_PUBLISH_VISIBILITY=any`). Each component builds in a job of its own,
all at once (`build <id>`), and one job then publishes what they built
(`publish --from`); a component that does not build is left out and fails
the run. `.github/workflows/test.yml` runs the tests and a Node 8 syntax
check in one job and, per component in parallel, its slow test and `check
<id>`, on each push to main and pull request. Only Steam's job restores and
saves the build cache.

**Build cache.** A runner starts empty, so a tool build that skips work only
when its last outputs are still in `build/` redid it on every run (Steam:
two Mesa builds, Wine's ntdll and the Proton bundle, ~12 min). Both
workflows set `BUILD_CACHE=/tmp/build-cache` and keep that folder with
`actions/cache` (restored from the newest save, saved again only when a part
was built). [`tools/build_cache.sh`](../tools/build_cache.sh) keeps each
part there under a key made from its inputs only, and a build restores it
instead of building, also inside the release's `git archive` exports. A
release takes main's caches only. Without `BUILD_CACHE` (by hand) nothing
changes.

## License

GPL-3.0-or-later (`LICENSE` at the repository root). The release tooling is
Robert Nisipeanu's, from [idrive-apps](https://github.com/robertnisipeanu/idrive-apps).
