// cidtouch.js: touch on the centre display (CID) the way the car brings it to the HMI,
// one UDP datagram per touch frame to HmiMain3D's CTouchDataClient (port 30567). In the VM
// (tap2touch sends the mouse the same way):
//   node /usr/lib/mgu-emu/cidtouch.js tap X Y              a tap at screen pixel X,Y (1920x720)
//   node /usr/lib/mgu-emu/cidtouch.js frame X Y TYPE EVENT [ID] [Z]   one frame, one finger
//   node /usr/lib/mgu-emu/cidtouch.js empty                one frame, no finger
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The datagram (from HmiMain3D's processSocketStream / decodeTouchScreenPduData):
//   16-byte header, big-endian: PDU id 0xB0048002 (u32), length (u32), 8 bytes unused here
//   96-byte payload: 12 words of 8 bytes; the decoder reads only the second half of each,
//   so the data D is bytes 4..7 of each word (48 bytes):
//     D[6], D[8]   proximity (non-zero: hand near the display)
//     D[16..17]    finger count, low 5 bits (max 5)
//     D[18 + 6i]   finger i: X, Y (u16, screen pixels), Z (u8),
//                  then a byte: type (bits 7-6), event (bits 5-4), touch id (bits 3-0)
//   event: 1 down, 2 held / moved, 3 up (CTouchData's own tests). Type 0 works.
// The HMI drops CID touch while its display service thinks the monitor is off: carsim's
// Monitor (README, "Stand-in services").
var dgram = require('dgram');
var PORT = 30567, HOST = '127.0.0.1', PDU_TOUCHSCREEN = 0xB0048002;

function datagram(fingers) {
  var d = Buffer.alloc(48);
  d.writeUInt16BE(fingers.length & 0x1f, 16);
  fingers.forEach(function (f, i) {
    var o = 18 + 6 * i;
    d.writeUInt16BE(f.x, o); d.writeUInt16BE(f.y, o + 2); d[o + 4] = f.z || 0;
    d[o + 5] = ((f.type & 3) << 6) | ((f.event & 3) << 4) | (f.id & 0xf);
  });
  var b = Buffer.alloc(16 + 96);
  b.writeUInt32BE(PDU_TOUCHSCREEN, 0); b.writeUInt32BE(96, 4);
  for (var w = 0; w < 12; w++) d.copy(b, 16 + 8 * w + 4, 4 * w, 4 * w + 4);
  return b;
}

function send(frames, done) {
  var s = dgram.createSocket('udp4'), i = 0;
  (function next() {
    if (i === frames.length) { s.close(); if (done) done(); return; }
    var b = datagram(frames[i++]);
    s.send(b, 0, b.length, PORT, HOST, function (err) { if (err) throw err; setTimeout(next, 16); });
  })();
}

module.exports = { datagram: datagram, send: send };

if (require.main === module) {
  var a = process.argv.slice(2);
  if (a[0] === 'frame') {
    send([[{ x: +a[1], y: +a[2], type: +a[3], event: +a[4], id: +(a[5] || 0), z: +(a[6] || 0) }]]);
  } else if (a[0] === 'tap') {
    var t = +(a[3] || 0), f = function (ev) { return [{ x: +a[1], y: +a[2], type: t, event: ev, id: 0 }]; };
    send([f(1), f(2), f(2), f(2), f(3), []]);
  } else if (a[0] === 'empty') {
    send([[]]);
  } else {
    console.error('usage: cidtouch.js frame X Y TYPE EVENT [ID] [Z] | empty'); process.exit(2);
  }
}
