# The Vizualyse platform

Code that more than one tool or app needs, kept once as **modules**, each
**versioned on its own**. A component pins a version of each module it
uses, so it can take `common/qrcode` 1.0.0 and `native/touch` 1.0.1: a fix
to one module lands where its pins move, and everything else keeps exactly
what it had.

**Making a new app?** Read [BUILDING-APPS.md](BUILDING-APPS.md): the tool
and the iDrive app file by file, the head unit's rules, testing off the car
and releasing.

```
platform/
  platform.js                 sync, check, list, new, use
  tool/                       tool side (Node 8, mgu-python)
    pcm_play/
      CHANGELOG.md            one "## x.y.z" entry per version
      1.0.0/                  one folder per version; only the newest may change
        pcm_play.py
        test/pcm_play_test.py the module's own tests
  app/                        iDrive app side (OAP modules)
  common/                     both sides
  native/                     C, compiled into a tool
  test/platform_test.js
```

## Pinning modules

A tool pins in `native/<id>/component.json`, an app in
`apps/<id>/release.json`; neither key is shipped to the unit. One entry per
module:

```json
"platform": {
  "native/frame_out": { "version": "1.0.0", "files": { "core/frame_out.c": "frame_out.c", "core/frame_out.h": "frame_out.h" } },
  "native/touch": { "version": "1.0.1", "files": { "core/touch.c": "touch.c", "core/touch.h": "touch.h" } },
  "tool/pcm_play": { "version": "1.0.0", "files": { "src/pcm_play.py": "pcm_play.py" } }
}
```

Each file is *where the copy goes in the component* and *which file of the
module version it copies*. The copy goes where the component's code and
build already look, so `require('./pcm_play.py')`, `-Icore` and the kit's
`files[]` don't change. Two modules may not write the same copy. Copies are
never committed: `sync` keeps a block in the `.gitignore` beside them that
lists them (commit that `.gitignore`).

| Who | Syncs before it runs |
|---|---|
| `release/tool_artifact.js` (every tool kit, so every release) | yes |
| `apps/<id>/tools/build.js`, `test_page.js`, `make_icon.js` | yes |
| `native/<id>/build.sh` and the tools' test runners | yes |
| anything else (an editor, `node test/x.js` by hand) | run `node platform/platform.js sync` once after a checkout or a pin change |

## Shipping a fix

```sh
node platform/platform.js new native/touch 1.0.1   # platform/native/touch/1.0.1/, copied from 1.0.0
# fix platform/native/touch/1.0.1/touch.c, describe it in platform/native/touch/CHANGELOG.md
node platform/platform.js use native/touch 1.0.1   # every component using it: pin 1.0.1, bump, sync
node platform/platform.js check
# run the tests, commit, publish with the Release workflow
```

`use <module> <version> <id>...` moves only those components. `use` bumps
the patch version of every tool it moves (a tool's kit is dated by what it
ships, so a new pin always changes its bytes) and of every app whose copied
files changed; `--no-bump` leaves versions to you. It never adds a module
to a component: that is an edit to its pin.

## A new module

```sh
node platform/platform.js new tool/control 1.0.0   # platform/tool/control/1.0.0/, empty, and its CHANGELOG.md
```

Put the files in, describe them in the changelog, then pin the module in
each component that uses it and delete the component's own copy. Module
names are lower case letters, digits, `_` and `-`, under one of the four
sides.

## Rules

- **A module version is frozen once a newer version of that module exists.**
  `check --base <ref>` (CI runs it against the pull request's base) refuses
  a change to a frozen version. The newest is open while you work on it;
  once a component pinned to it is published, make the next fix a new
  version.
- **A version nobody pins can be deleted** (`list` says which). Git keeps it.
- **Originals only.** `check` refuses a copy that is committed or that
  differs from its original; edit `platform/<side>/<module>/<version>/`,
  then `sync`.
- **Nothing else in platform/.** `check` refuses a folder that is not a
  side, a module that holds anything but its `CHANGELOG.md` and version
  folders, and a version its changelog doesn't mention.
- **Node 8 and mgu-python.** Everything under `tool/`, `app/` and `common/`
  runs on the unit (CI's Node 8 syntax check covers the copies).
- **Licences stay per file.** `tool/cluster_render_client` is MPL-2.0,
  `common/qrcode` MIT, `native/wayland_drm` Mesa's notice; the rest
  GPL-3.0-or-later.

## Tests

```sh
node platform/test/platform_test.js                          # sync, pins, the packer, this repo's pins
python3 platform/tool/pcm_play/1.0.0/test/pcm_play_test.py   # the audio player (as root for the lock checks)
node platform/platform.js check --base origin/main
```

## What is in it

`node platform/platform.js list` shows every module version and who pins
it; each module's `CHANGELOG.md` says where its files came from. Until
2026-11-07 the platform was versioned as a whole (`platform/1.0.0/`); every
module's 1.0.0 holds that version's files, byte for byte (but for the path in
pcm_play's test). What could move in next is in [`TODO.md`](../TODO.md).
