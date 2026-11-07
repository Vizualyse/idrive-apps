# native/pads

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use native/pads <version>`.

## 1.0.0

The gamepad mapping, for vizualyse-steam 0.1.6's controllers
(vizualyse-moonlight keeps its own copy until it moves): `pads.{c,h}`,
vizualyse-moonlight's `core/pads.{c,h}` with `<Limelight.h>` replaced by
`pad_flags.h`, moonlight-common-c's button flags (XInput's bits), defined
only where not already; `test/pads_test.c`, vizualyse-moonlight's
`core/pads_test.c`. Added to platform 1.0.0 in 23496ac and moved here
unchanged.
