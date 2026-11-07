# native/usb_pads

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use native/usb_pads <version>`.

## 1.0.0

`usb_pads.{c,h}`, vizualyse-moonlight's usbfs reader (out of
`moonlight_core.c`), its pad table replaced by `struct usb_pad`, for
vizualyse-steam 0.1.6's controllers. `usb_pads.h` includes `pads.h`: pin
`native/pads` beside it. Added to platform 1.0.0 in 23496ac and moved here
unchanged.
