<#
.SYNOPSIS
  Boots the head unit emulator: the pulled unit in QEMU (WHPX), the centre
  screen in a window, the mouse as its touchscreen.

.EXAMPLE
  powershell -File tools\mgu-emu\run.ps1            # a fresh boot (changes thrown away)
  powershell -File tools\mgu-emu\run.ps1 -Keep      # keep the disk changes of the last run

  Shell:   telnet 127.0.0.1 4552     (the unit's own serial getty, logged in as root)
  SSH:     ssh -p 2222 -i tools\mgu-emu\build\emu_key root@127.0.0.1
  Logs:    <rootfs>\emu\console.log (kernel), journal.log (the whole journal)
#>
param(
    [string]$RootfsDir = (Join-Path $PSScriptRoot '..\..\..\idrive-rootfs\20.40.2'),
    [switch]$Keep,
    [int]$MemoryMB = 6144,
    [int]$Cpus = 4,
    [string]$Display = 'gtk,zoom-to-fit=on'
)
$ErrorActionPreference = 'Stop'
$qemu = 'C:\Program Files\qemu\qemu-system-x86_64.exe'
$img = 'C:\Program Files\qemu\qemu-img.exe'
$emu = Join-Path (Resolve-Path $RootfsDir) 'emu'
$kernel = Join-Path $PSScriptRoot 'build\bzImage'
# Two disks: mgu (the root) and opt (/var/opt, with quotas). build-image.sh
# leaves <disk>.qcow2.new when a running VM held the old one.
$disks = @{ mgu = 'run.qcow2'; opt = 'run-opt.qcow2' }
foreach ($d in $disks.Keys) {
    $new = Join-Path $emu "$d.qcow2.new"
    if (Test-Path $new) { Move-Item -Force $new (Join-Path $emu "$d.qcow2"); $Keep = $false }
}
foreach ($f in $qemu, $kernel, (Join-Path $emu 'mgu.qcow2'), (Join-Path $emu 'opt.qcow2')) {
    if (-not (Test-Path $f)) { throw "missing: $f (README)" }
}

# Each boot runs on throwaway overlays of the built disks, unless -Keep.
foreach ($d in $disks.Keys) {
    $ov = Join-Path $emu $disks[$d]
    if (-not $Keep -or -not (Test-Path $ov)) {
        Remove-Item $ov -ErrorAction SilentlyContinue
        & $img create -q -f qcow2 -b "$d.qcow2" -F qcow2 $ov
        if ($LASTEXITCODE) { throw 'qemu-img create failed' }
    }
}
$run = Join-Path $emu $disks['mgu']
$runOpt = Join-Path $emu $disks['opt']

# The unit's own kernel line, minus its hardware: services read bootmode /
# hwtype / hwvariant from /proc/cmdline. Four loopback sound cards stand in
# for the AVB devices SmartXbar plays to the amplifier (90-emu-avb.conf).
$append = 'root=/dev/vda rw rootfstype=ext4 console=ttyS0,115200 loglevel=4 panic=-1 ' +
          'video=Virtual-1:1920x720@60 ipv6.disable_ipv6=1 bootmode=APP1 hwtype=MGU hwrevision=D1 hwvariant=HIGH config_version=MGU_A19455A_S9 ' +
          'snd_aloop.enable=1,1,1,1'

$console = Join-Path $emu 'console.log'
$journal = Join-Path $emu 'journal.log'
$qargs = @(
    '-name', 'iDrive (MGU I_21w12.2-1-4)',
    '-accel', 'whpx,kernel-irqchip=off', '-machine', 'q35', '-cpu', 'max',
    '-smp', "$Cpus", '-m', "$MemoryMB",
    '-kernel', $kernel, '-append', $append,
    '-drive', "file=$run,if=virtio,format=qcow2,cache=writeback,discard=unmap",
    '-drive', "file=$runOpt,if=virtio,format=qcow2,cache=writeback,discard=unmap",
    '-vga', 'none', '-device', 'virtio-vga,xres=1920,yres=720,max_outputs=1',
    '-display', $Display,
    '-device', 'virtio-tablet-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-multitouch-pci',
    # eth0: SSH only (restrict=on: no way out, as root has none on the car);
    # eth1: the internet, for mgu-uplink (uplink = netdev:eth1) as a phone's hotspot would be
    '-netdev', 'user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22', '-device', 'virtio-net-pci,netdev=n0,mac=52:54:00:e0:00:01',
    # (a subnet of its own: two user networks both lease 10.0.2.15, and SSH breaks)
    '-netdev', 'user,id=n1,net=10.0.3.0/24', '-device', 'virtio-net-pci,netdev=n1,mac=52:54:00:e0:00:02',
    '-serial', "file:$console",
    # ttyS1 kept (unused) so the shell stays on ttyS2: the journal goes through a
    # virtio console (hvc0) instead. Through the UART (one exit per byte under
    # WHPX) journald managed ~25 KB/s; the HMI blocked on its full log socket
    # and missed its 30 s watchdog, again at every restart (a black screen).
    '-serial', 'null',
    '-serial', 'telnet:127.0.0.1:4552,server,nowait',
    '-device', 'virtio-serial-pci', '-chardev', "file,id=jlog,path=$journal", '-device', 'virtconsole,chardev=jlog',
    '-no-reboot'
)
Write-Host "booting; logs in $emu (console.log, journal.log); shell: telnet 127.0.0.1 4552"
& $qemu @qargs
Write-Host "QEMU exited ($LASTEXITCODE). A reboot or power-off inside the VM ends it (-no-reboot): see journal.log."
