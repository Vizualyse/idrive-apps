# Third-party software in vizualyse-bus

The tool's own files (`src/mosquitto.conf`, `systemd/`, `build.sh`, `image/`,
`patches/`, `test/`) are GPL-3.0-or-later (`LICENSE`).

| File | What | Licence |
|---|---|---|
| `mosquitto` | **Eclipse Mosquitto** 2.0.21's broker (`src/` only), built by `build.sh` for glibc 2.27 without TLS, WebSockets, bridges or persistence; one change: `src/conf.c`'s TLS file check put inside `#ifdef WITH_TLS` (`patches/no-tls-check.awk`), without which it doesn't build without TLS | EPL-2.0 or EDL-1.0, at your choice (`mosquitto-LICENSE.txt`, `mosquitto-epl-v20`, `mosquitto-edl-v10`) |

**Source code:** <https://mosquitto.org/files/source/mosquitto-2.0.21.tar.gz>
(SHA-256 `7ad5e84caeb8d2bb6ed0c04614b2a7042def961af82d87f688ba33db857b899d`,
pinned in `build.sh`); upstream at <https://github.com/eclipse-mosquitto/mosquitto>,
tag `v2.0.21`. `build.sh` and `patches/no-tls-check.awk` rebuild the shipped
binary from it.
