# The Vizualyse platform

Code that more than one tool or app needs, kept once and **versioned**. Each
component pins the version it is built with, so a fix lands everywhere by
moving the pins, and a component that isn't moved keeps exactly what it had.

```
platform/
  platform.js          sync, check, list, new, use
  1.0.0/               one folder per version; only the newest may change
    CHANGELOG.md
    tool/              tool side (Node 8, mgu-python)
    app/               iDrive app side (OAP modules)
    common/            both sides
    native/            C, compiled into a tool
    test/              the platform's own tests
  test/platform_test.js
```

## Pinning a version

A tool pins in `native/<id>/component.json`, an app in
`apps/<id>/release.json`; neither key is shipped to the unit.

```json
"platform": {
  "version": "1.0.0",
  "files": {
    "src/pcm_play.py": "tool/pcm_play.py",
    "core/frame_out.c": "native/frame_out.c"
  }
}
```

Each entry is *where the copy goes in the component* and *which file of the
version it copies*. The copy goes where the component's code and build
already look, so `require('./pcm_play.py')`, `-Icore` and the kit's
`files[]` don't change. Copies are never committed: `sync` keeps a block in
the `.gitignore` beside them that lists them (commit that `.gitignore`).

| Who | Syncs before it runs |
|---|---|
| `release/tool_artifact.js` (every tool kit, so every release) | yes |
| `apps/<id>/tools/build.js`, `test_page.js`, `make_icon.js` | yes |
| `native/<id>/build.sh` and the tools' test runners | yes |
| anything else (an editor, `node test/x.js` by hand) | run `node platform/platform.js sync` once after a checkout or a pin change |

## Shipping a fix to everyone

```sh
node platform/platform.js new 1.0.1      # platform/1.0.1/, copied from 1.0.0
# fix platform/1.0.1/tool/pcm_play.py, add a line to platform/1.0.1/CHANGELOG.md
node platform/platform.js use 1.0.1      # every component: pin 1.0.1, bump, sync
node platform/platform.js check
# run the tests, commit, publish with the Release workflow
```

`use <version> <id>...` moves only those components. `use` bumps the patch
version of every tool it moves (a tool's kit is dated by what it ships, so a
new pin always changes its bytes) and of every app whose copied files
changed; `--no-bump` leaves versions to you.

## Rules

- **A version is frozen once a newer one exists.** `check --base <ref>`
  (CI runs it against the pull request's base) refuses a change to a frozen
  version. The newest is open while you work on it; once a component pinned
  to it is published, make the next fix a new version.
- **A version nobody pins can be deleted** (`list` says which). Git keeps it.
- **Originals only.** `check` refuses a copy that is committed or that
  differs from its original; edit `platform/<version>/`, then `sync`.
- **Node 8 and mgu-python.** Everything under `tool/`, `app/` and `common/`
  runs on the unit (CI's Node 8 syntax check covers the copies).
- **Licences stay per file.** `tool/cluster_render_client.js` is MPL-2.0,
  `common/qrcode.js` MIT, `native/wayland-drm.xml` Mesa's notice; the rest
  GPL-3.0-or-later.

## Tests

```sh
node platform/test/platform_test.js                          # sync, pins, the packer, this repo's pins
python3 platform/1.0.0/test/pcm_play_test.py                 # the audio player (as root for the lock checks)
node platform/platform.js check --base origin/main
```

## What is in it

[`1.0.0/CHANGELOG.md`](1.0.0/CHANGELOG.md) lists each file and where it came
from. What could move in next (the control socket, the firewall rule, the
phone page's server, the mgu-render layer client) is in [`TODO.md`](../TODO.md).
