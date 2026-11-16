# openMC3000 MQTT bridge for Home Assistant OS

The add-on runs the existing openMC3000 bridge locally on the HAOS machine. An
MQTT broker and the Home Assistant MQTT integration are required; this add-on
does not install a broker. It exposes eight sensors per slot via MQTT discovery.

## Safety first

`enable_control` defaults to **true**. The Charging switch starts
or stops **all occupied slots**; it is not a per-slot switch. Each charge-current
number writes that slot's program on the physical charger. A start can begin a
real charge or discharge using the existing program. Check every slot's chemistry,
settings and cell before starting the add-on or creating automations; do not rely
on the charger or this bridge to validate the program for your cells. Set
`enable_control: false` before starting if you want telemetry only.

Anyone able to publish to the bridge command topics can control the charger when
enabled, even without Home Assistant. Restrict broker access and MQTT ACLs to
trusted clients. Never retain commands: the bridge ignores retained messages
delivered on subscription, but MQTT brokers can deliver a newly published
retained command as an ordinary live message. Disabling control stops command
subscriptions and removes retained control discovery under the configured prefix;
it does not stop a charge already in progress.

Optional per-slot BLE switches require `ble_address`, the MC3000's Bluetooth
MAC address. Leave it empty to keep USB-only control. The address must identify
the **same physical charger** as the selected USB node; the bridge cannot
verify that association. A wrong address can control another charger. USB is
still used for telemetry and program changes. The add-on needs access to the
host system D-Bus and a working local Bluetooth adapter; remote Bluetooth
proxies are not supported. BLE must be available to the add-on, not already
exclusively connected to another application.
Host D-Bus access is granted to the add-on even when the address is empty.

The four BLE switches start/stop only their respective slots. They do not set or
validate a battery program. Before starting, verify the correct cell and all
program and protection settings on the charger. An acknowledged command may
still fail or time out; inspect the device and slot status rather than assuming
it worked. A STOP interrupts an in-flight BLE START and cancels queued BLE
starts, but reconnecting and delivering STOP can take time. If in doubt, stop
at the physical charger. BLE and USB exchanges are serialized.
Switch availability follows USB polling, not the BLE connection; a BLE failure
is reported in the add-on log. If USB or the add-on is unavailable, use the
charger's own controls to stop.

## Install and configure

1. Connect the powered MC3000 directly by USB to the HAOS machine. It needs its
   own DC supply. Only one program can use the charger at a time.
2. In **Settings → Apps → App store** (called **Add-ons** on older releases),
   open the menu, choose **Repositories**, add
   `https://github.com/GlassOnTin/openmc3000`, then install **openMC3000 MQTT
   bridge**. The repository must contain this add-on on its default branch first;
   unmerged worktree changes are not visible to HAOS.
3. Install/configure an MQTT broker, e.g. Mosquitto, and configure Home
   Assistant's MQTT integration to use it with discovery enabled. The broker
   must allow this add-on to publish discovery and state and, if control is
   enabled, subscribe to commands. Create a dedicated broker user.
4. Find the actual **hidraw** node as described below. In the add-on
   configuration select that `/dev/hidrawN` in `hidraw_path`, enter `mqtt_url`
   (for example `mqtt://core-mosquitto:1883` for the official Mosquitto app),
   and set `mqtt_username` and `mqtt_password` when the broker requires them.
   Do not put credentials in the URL. `mqtts://` uses Node's normal CA trust
   store; an untrusted/self-signed broker certificate will fail.
5. Keep `discovery_prefix: homeassistant` unless the MQTT integration uses
   another discovery prefix. Review the safety warning above: control is enabled
   by default. Save and start the add-on, then check its log and Home Assistant's
   MQTT device list.
6. To enable per-slot BLE control, find the charger's Bluetooth MAC in Home
   Assistant's Bluetooth device information, enter it as `ble_address`, and
   restart the add-on. Verify that it belongs to the USB-connected charger.
   The all-slot USB switch remains available independently.

The bridge is not a broker and does not use Supervisor's MQTT service
credentials automatically. Set the credentials explicitly. MQTT discovery,
status and command topics are detailed in [bridge/README.md](bridge/README.md).

## Find the host's HID device

Home Assistant's **Settings → System → Hardware → All hardware** can help
identify connected devices. Look for an MC3000 HID device with vendor/product
`0000:0001` and its `/dev/hidrawN` node, not `/dev/bus/usb/...` or a serial
port. If that view does not show the node, use a **host** shell (HAOS debug
access; an ordinary SSH add-on shell may show only its own container):

```sh
for d in /sys/class/hidraw/hidraw*; do
  echo "/dev/${d##*/}"
  grep -E '^(HID_ID|HID_NAME)=' "$d/device/uevent"
done
```

Find `HID_ID=0003:00000000:00000001` and use the `/dev/hidrawN` printed
immediately above it. For example, if it is `/dev/hidraw2`, select exactly
`/dev/hidraw2` in `hidraw_path`. The add-on checks the HID ID before opening
the node and fails rather than knowingly opening a different device.

Supervisor's `device(subsystem=hidraw)` option grants access to the selected
device; this does not need `usb: true` or `full_access`. It requires a Supervisor
version that exposes hidraw devices through the device selector. If the device
is missing from the selector or access is denied, inspect the host hardware and
Supervisor logs; do not assume raw USB mapping grants hidraw access.

**Limitation:** `/dev/hidrawN` is not stable. Replugging or rebooting can change
the number. Reidentify and select the new node, save, and restart the add-on.
The bridge does not automatically follow a changed path or reconnect after
unplugging. When multiple identical MC3000s are connected, the VID/PID check
cannot distinguish them; check the physical connection and device identity.
