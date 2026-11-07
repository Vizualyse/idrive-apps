# native/winston_out

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use native/winston_out <version>`.

## 1.0.0

New: our pictures on the centre screen as a native client of Winston
(`winston_out.c` / `.h`), with the protocols it speaks: `ivi-application.xml`
and `ivi-controller.xml` (as checked against the unit's libraries by
mgu-store's mgu-render) and `linux-dmabuf-unstable-v1.xml` (wayland-protocols
1.17). The layer handling follows mgu-render's layer mode (mgu-store,
GPL-3.0). Shared memory pools and dmabufs (one or more planes) passed on as
they are, our own buffers (`wo_ring`), camera surfaces watched (their
`content` removed counts as gone), `wo_socket_gid` for a process that drops
its privileges. Tested against the unit's own Winston off the car:
`tools/winston-bench`. Used by vizualyse-chromium (chromium-wl) and
vizualyse-steam (wl-sink).
Also (still 1.0.0, before its first release): `wo_present_at` (a picture
placed as part of a bigger one: Wine's GL area where wl-sink's composed
picture would have it), the black backdrop (`backdrop` 1: under that
picture; 2: under the whole place, black bars), `wo_overlay` (a hint over
the picture), `wo_poll` (for a decoder's thread, no event loop), multi-plane
dmabufs (NV12). vizualyse-moonlight (moonlight-core) uses it too.
