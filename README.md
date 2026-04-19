<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">
<br/>
<a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://badgen.net/badge/homebridge/verified/purple"></a>

</p>

<span align="center">

# Homebridge Eufy RoboVac

</span>

> [!IMPORTANT]
> **Homebridge <v1.8.4 Information**
>
> This plugin has a scoped name with a '.' in it.  You'll need Homebridge v1.8.5 or greater to run it.

---

This is a plugin to control the Eufy RoboVac via Homebridge.

It is recommended to run this plugin as a child bridge.

Multiple child bridges will enable you to control multiple Eufy RoboVacs.  To configure this scenario, you must manually edit Homebridge's config.json.

### Configuration

This plugin can be configured using homebridge-config-ui-x.  There are 4 required fields.

* Name - the name for your RoboVac
* IP Address - the IP address of your RoboVac.  Configure your DHCP server to serve a static IP address to your RoboVac for the best experience.
* Tuya Device ID and Tuya Device Key - these can be obtained by following https://github.com/gtalusan/eufy-device-id-js

### HomeKit (HAP)

The default accessory is a switch that will run the Eufy RoboVac in "auto" mode.  As part of this accessory, a sub-switch is also available to turn on the vacuum's location beacon.

You may also create arbitrary room switches.  A room switch will direct your Eufy RoboVac to clean an arbitrary set of rooms.  Use a comma-delimited list corresponding to the room numbers on your Eufy RoboVac's map.

### Matter over Thread (Homebridge 2.0+)

When running on **Homebridge 2.0** (beta.85 or later) with Matter enabled, this plugin automatically exposes your Eufy RoboVac as a native **Matter Robotic Vacuum Cleaner** device. No additional configuration is required — if Matter is available and enabled, it just works alongside the existing HAP accessories.

#### Matter Capabilities

| Feature | Matter Cluster | Description |
|---|---|---|
| Run Mode | `rvcRunMode` | Idle / Cleaning modes |
| Clean Mode | `rvcCleanMode` | Vacuum mode |
| Operational State | `rvcOperationalState` | Running, Paused, Docked, Charging, Seeking Charger, Error |
| Battery | `powerSource` | Battery level (0.5% increments), charge level (Ok/Warning/Critical) |
| Room Selection | `serviceArea` | Maps your configured room switches to Matter areas (see below) |
| Play Sound to Locate | `identify` | Uses HomeKit's native "Play Sound to Locate" action to trigger the locate beacon |

#### Room Selection via Matter

If you have `roomSwitches` configured, they are automatically mapped to Matter **Service Areas**:

- Each room switch becomes a selectable area in the Matter ecosystem
- All areas are assigned to a single floor map ("Home")
- Area names come directly from your room switch `name` field
- You can select/deselect areas and the vacuum will clean the corresponding rooms
- An empty area selection resets to "all areas"

#### Enabling Matter

1. Update to Homebridge 2.0 (beta.85+)
2. Enable Matter in your Homebridge settings
3. Run this plugin as a child bridge (recommended)
4. The plugin will log `Matter is available and enabled.` on startup

> **Note:** Matter support requires a fix for a network interface timing issue in Homebridge 2.0. This fix is pending merge in [homebridge/homebridge#3910](https://github.com/homebridge/homebridge/pull/3910). Until it is merged, Matter may fail to start if you are using the `HOMEBRIDGE_INTERFACE` environment variable.

