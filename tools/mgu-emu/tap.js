// tap.js X Y [dev]: a tap at screen pixel X,Y of the 1920x720 centre screen, injected
// into QEMU's tablet from inside the VM (tap2touch turns it into touch):
//   ssh -p 2222 -i build/emu_key root@127.0.0.1 node /usr/lib/mgu-emu/tap.js 960 360
// SPDX-License-Identifier: GPL-3.0-or-later
var fs = require('fs');
var dev = process.argv[4] || '/dev/input/' + fs.readdirSync('/sys/class/input').filter(function (e) {
  return /^event/.test(e) && fs.readFileSync('/sys/class/input/' + e + '/device/name', 'utf8').trim() === 'QEMU Virtio Tablet';
})[0];
var x = Math.round(+process.argv[2] * 32767 / 1919), y = Math.round(+process.argv[3] * 32767 / 719);
var fd = fs.openSync(dev, 'w');
function ev(type, code, value) {
  var b = Buffer.alloc(24); // struct input_event on x86-64: timeval(16) type code value
  b.writeUInt16LE(type, 16); b.writeUInt16LE(code, 18); b.writeInt32LE(value, 20);
  fs.writeSync(fd, b);
}
ev(3, 0, x); ev(3, 1, y); ev(0, 0, 0);
ev(1, 0x110, 1); ev(0, 0, 0);
setTimeout(function () { ev(1, 0x110, 0); ev(0, 0, 0); fs.closeSync(fd); }, 120);
