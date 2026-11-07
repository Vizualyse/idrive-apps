# native/usbip_pad

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use native/usbip_pad <version>`.

## 1.0.0

`usbip_pad.c`, vizualyse-moonlight's `test/usbip_pad.c`: a virtual XInput
USB pad through the kernel's vhci_hcd, for the off-car controller tests
(vizualyse-steam's unit test). Added to platform 1.0.0 in 23496ac and moved
here unchanged.
