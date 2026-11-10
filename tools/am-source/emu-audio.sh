#!/bin/sh
# emu-audio.sh: the car's audio around the head unit, in the emulator only:
# the amplifier (DOMAIN_RAM), mediaapp's encoded domain (DOMAIN_MGU_ENCODED)
# and both ends of AVB, so the audio manager routes an entertainment source
# from SmartXbar to the amplifier as on the car (knowledge/sound.md, "The
# emulator"). What SmartXbar plays to the amplifier on the recorded AVB
# devices lands in /run/avbcap/<NAME>.wav (90-emu-avb.conf).
#
#   sh emu-audio.sh DIR [NAME...]   DIR holds the am-source scripts and iface/;
#                                   NAMEs: AVB devices to record (default the
#                                   two stereo gateways to the amplifier)
#
# Restarts the audio manager (its front media sink starts only when the
# amplifier is there and the power state says on) and the routing adapter
# (SmartXbar opens its AVB devices, and the recordings, at start), then starts
# the stand-ins against them. Never on the car: there the real ones run.
set -eu
D=${1:?dir}; shift
REC=${*:-MGU_GW_1_SINK_CF_48_STEREO MGU_GW_2_SINK_CF_48_STEREO}
# SmartXMGU.bin's plug:avb: devices
AVB="MGU_GW_1_SINK_CF_24_MONO MGU_GW_1_SINK_CF_48_MULTICHANNEL MGU_GW_1_SINK_CF_48_STEREO
 MGU_GW_1_SOURCE_CF_24_MONO MGU_GW_1_SOURCE_CF_48_MULTICHANNEL MGU_GW_1_SOURCE_CF_48_STEREO
 MGU_GW_2_SINK_CF_24_MONO MGU_GW_2_SINK_CF_48_MULTICHANNEL MGU_GW_2_SINK_CF_48_STEREO
 MGU_GW_2_SOURCE_CF_24_MONO MGU_GW_2_SOURCE_CF_48_MULTICHANNEL MGU_GW_2_SOURCE_CF_48_STEREO
 MGU_GW_3_SOURCE_CF_1MIC_1REF MGU_GW_3_SOURCE_CF_1MIC_6REF MGU_GW_3_SOURCE_CF_2MIC_1REF_CONN
 MGU_GW_3_SOURCE_CF_2MIC_1REF_SPEECH MGU_GW_3_SOURCE_CF_2MIC_6REF MGU_GW_3_SOURCE_CF_3MIC_1REF
 MGU_GW_3_SOURCE_CF_4MIC_5REF MGU_GW_3_SOURCE_CF_5MIC_5REF
 MGU_GW_5_SINK_CF_24_MONO MGU_GW_5_SINK_CF_48_MULTICHANNEL MGU_GW_5_SINK_CF_48_STEREO"
cd "$D"
if systemctl is-enabled recmgr >/dev/null 2>&1 || [ ! -e /usr/share/alsa/alsa.conf.d/90-emu-avb.conf ]; then
    echo "emu-audio: this doesn't look like the emulator (recmgr enabled or no 90-emu-avb.conf)" >&2; exit 1
fi
for p in $(ps | awk '/node (domain-sim|avb-sim)\.js/ && !/awk/ {print $1}'); do kill "$p" 2>/dev/null || true; done

systemctl stop alsaroutingadapters
rm -rf /run/avbcap; mkdir -m 1777 /run/avbcap
for n in $AVB; do ln -s /dev/null "/run/avbcap/$n.wav"; done
for n in $REC; do rm -f "/run/avbcap/$n.wav"; done

# the power state must read "on" (FULL_ON_USER_ON / ENTERTAINMENT_MODE_USER_ON)
# when the front media sink subscribes. The unit's NodeStateManager serves
# Lifecycle (carsim's copy isn't the one read) and derives it from the
# vehicle condition: carsim's default PWF WOHNEN gives WELCOME_SCREEN, FAHREN
# gives FULL_ON_USER_ON.
echo 'set VehicleCondition VehicleCondition {"cRCConditionVehicle":0,"aliveConditionVehicle":0,"controlBasePartialNetworks":"KOM_FAHREN","controlFunctionalPartialNetworks":0,"statusConditionVehicle":"FAHREN","qualifierStatusConditionVehicle":"SIGNALWERT_GUELTIG","dummy":0}' > /run/carsim/ctl
sleep 1
echo 'set VehicleCondition vehicleConditionNoCrc {"controlBasePartialNetworks":"KOM_FAHREN","controlFunctionalPartialNetworks":0,"statusConditionVehicle":"FAHREN","qualifierStatusConditionVehicle":"SIGNALWERT_GUELTIG"}' > /run/carsim/ctl
sleep 5
systemctl restart audiomanager
sleep 2
systemctl start alsaroutingadapters
sleep 3
nohup node domain-sim.js iface ram > /run/emu-ram.log 2>&1 &
nohup node domain-sim.js iface encoded > /run/emu-encoded.log 2>&1 &
sleep 3
nohup node avb-sim.js iface > /run/emu-avb.log 2>&1 &
sleep 3
# mediaapp's media output, which it says is available on the car
node amsrc.js iface hook --src=386 >/dev/null
grep -h -E "available|failed" /run/emu-ram.log /run/emu-encoded.log /run/emu-avb.log | cut -c1-160
echo "emu-audio: recording $REC"
