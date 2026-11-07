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
$base = Join-Path $emu 'mgu.qcow2'
$run = Join-Path $emu 'run.qcow2'
# build-image.sh leaves mgu.qcow2.new when a running VM held the old disk
$new = Join-Path $emu 'mgu.qcow2.new'
if (Test-Path $new) { Move-Item -Force $new $base; $Keep = $false }
foreach ($f in $qemu, $kernel, $base) { if (-not (Test-Path $f)) { throw "missing: $f (README)" } }

# Each boot runs on a throwaway overlay of the built disk, unless -Keep.
if (-not $Keep -or -not (Test-Path $run)) {
    Remove-Item $run -ErrorAction SilentlyContinue
    & $img create -q -f qcow2 -b mgu.qcow2 -F qcow2 $run
    if ($LASTEXITCODE) { throw 'qemu-img create failed' }
}

# The unit's own kernel line, minus its hardware: services read bootmode /
# hwtype / hwvariant from /proc/cmdline.
$append = 'root=/dev/vda rw rootfstype=ext4 console=ttyS0,115200 loglevel=4 panic=-1 ' +
          'video=Virtual-1:1920x720@60 ipv6.disable_ipv6=1 bootmode=APP1 hwtype=MGU hwrevision=D1 hwvariant=HIGH config_version=MGU_A19455A_S9'

$console = Join-Path $emu 'console.log'
$journal = Join-Path $emu 'journal.log'
$qargs = @(
    '-name', 'iDrive (MGU I_21w12.2-1-4)',
    '-accel', 'whpx,kernel-irqchip=off', '-machine', 'q35', '-cpu', 'max',
    '-smp', "$Cpus", '-m', "$MemoryMB",
    '-kernel', $kernel, '-append', $append,
    '-drive', "file=$run,if=virtio,format=qcow2,cache=writeback,discard=unmap",
    '-vga', 'none', '-device', 'virtio-vga,xres=1920,yres=720,max_outputs=1',
    '-display', $Display,
    '-device', 'virtio-tablet-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-multitouch-pci',
    '-netdev', 'user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22', '-device', 'virtio-net-pci,netdev=n0',
    '-serial', "file:$console",
    '-serial', "file:$journal",
    '-serial', 'telnet:127.0.0.1:4552,server,nowait',
    '-no-reboot'
)
Write-Host "booting; logs in $emu (console.log, journal.log); shell: telnet 127.0.0.1 4552"
& $qemu @qargs
Write-Host "QEMU exited ($LASTEXITCODE). A reboot or power-off inside the VM ends it (-no-reboot): see journal.log."
