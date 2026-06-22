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

This plugin can be configured using homebridge-config-ui-x.

The plugin supports two connection modes:

* Legacy Tuya 3.3 local control - the original local LAN control path for older RoboVac models.
* Eufy Clean cloud/MQTT - the newer Eufy Clean cloud control path for models that no longer expose the older local Tuya 3.3 API.

Existing configurations continue to use Legacy Tuya mode by default.  To opt in to the newer cloud/MQTT API, set `transport` to `eufy-clean-cloud`.

Homebridge Config UI will show the relevant fields for the selected connection type and validate the required settings for that mode.

#### Legacy Tuya 3.3 Local Control

Use this mode for older RoboVacs that still support local Tuya 3.3 control.

Required fields:

* `name` - the name for your RoboVac
* `transport` - `legacy-tuya`, or omit this field because it is the default
* `ip` - the IP address of your RoboVac.  Configure your DHCP server to serve a static IP address to your RoboVac for the best experience.
* `deviceId` - the Tuya/Eufy device ID
* `deviceKey` - the Tuya/Eufy local key

The Tuya device ID and local key can be obtained by following https://github.com/gtalusan/eufy-device-id-js.

Example:

```json
{
  "platform": "EufyRobovacHomebridgePlugin",
  "name": "Eufy RoboVac",
  "transport": "legacy-tuya",
  "ip": "10.0.1.69",
  "deviceId": "your-tuya-device-id",
  "deviceKey": "your-tuya-local-key"
}
```

#### Eufy Clean Cloud/MQTT

Use this mode for newer Eufy Clean RoboVacs that communicate through Eufy's cloud and MQTT API.

Required fields:

* `name` - the name for your RoboVac
* `transport` - `eufy-clean-cloud`
* `deviceId` - the Eufy Clean device ID
* `eufyEmail` and `eufyPassword` - Eufy Clean account credentials

Optional fields:

* `eufyAccessToken` - existing Eufy Clean access token
* `country` - two-letter account country code, defaults to `US`
* `eufyApiBaseUrl` - cloud API base URL override, defaults to `https://home-api.eufylife.com`
* `deviceModel` - optional model code override when Eufy Clean discovery cannot identify the model
* `showAdvancedMqtt` - reveals manual MQTT overrides. Most users should leave this disabled.

The plugin discovers MQTT credentials from Eufy's AIOT API and derives MQTT topics automatically:

* command topics: `cmd/eufy_home/{deviceModel}/{deviceId}/req` and `smart/mb/out/{deviceId}`
* status topics: `cmd/eufy_home/{deviceModel}/{deviceId}/res` and `smart/mb/in/{deviceId}`

Example:

```json
{
  "platform": "EufyRobovacHomebridgePlugin",
  "name": "Eufy RoboVac",
  "transport": "eufy-clean-cloud",
  "deviceId": "your-eufy-clean-device-id",
  "eufyEmail": "you@example.com",
  "eufyPassword": "your-eufy-clean-password",
  "country": "US"
}
```

The cloud/MQTT client accepts JSON status frames and protobuf-like status frames.  Status updates are normalized into the same internal RoboVac events used by the legacy Tuya path, so HomeKit and Matter accessories behave the same way in either mode.

#### Shared Options

`roomSwitches` works with both connection modes.  Each entry has:

* `name` - the room name shown in HomeKit/Matter
* `rooms` - a room number or comma-separated list of room numbers from the map in the Eufy Clean app

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
| Error State | `rvcOperationalState` | Mapped error codes with semantic details |
| Battery | `powerSource` | Battery level (0.5% increments), charge level (Ok/Warning/Critical) |
| Room Selection | `serviceArea` | Maps your configured room switches to Matter areas (see below) |
| Play Sound to Locate | `identify` | Uses HomeKit's native "Play Sound to Locate" action to trigger the locate beacon |

#### Error State Mapping

This plugin maps all 21 Eufy RoboVac error codes to Matter.js `RvcOperationalState.ErrorState` enum values, providing semantic device error reporting:

| Eufy Error | Matter ErrorState | Meaning |
|---|---|---|
| no error | NoError (0) | Device operating normally |
| wheel stuck / wheel suspended / device trapped | Stuck (65) | Device is mechanically stuck or trapped |
| wheel module stuck | WheelsJammed (76) | Wheels are jammed |
| side brush / rolling brush stuck | BrushJammed (77) | Brush mechanism is jammed |
| low battery | LowBattery (72) | Battery level is critically low |
| magnetic boundary / restricted area detected | CannotReachTargetArea (73) | Device cannot reach target area |
| insert dust collector | DustBinMissing (66) | Dust bin is missing |
| laser/wall sensor errors | NavigationSensorObscured (78) | Sensors are blocked or dirty |
| base blocked | Stuck (65) | Charging dock is blocked |

**Consumable Maintenance Alerts** (battery, wheel module, brush, suction fan, sensors) are logged as warnings and do not trigger error states, as they represent maintenance needs rather than operational failures.

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
