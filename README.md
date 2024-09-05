<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

<span align="center">

# Homebridge Eufy Robovac

</span>

> [!IMPORTANT]
> **Homebridge <v1.8.4 Information**
>
> This plugin has a scoped name with a '.' in it.  You'll need Homebridge v1.8.5 or greater to run it.

---

This is a plugin to control the Eufy Robovac via Homebridge.

It is recommended to run this plugin as a child bridge.

Multiple child bridges will enable you to control multiple Eufy Robovacs.  To configure this scenario, you must manually edit Homebridge's config.json.

### Configuration

This plugin can be configured using homebridge-config-ui-x.  There are 4 required fields.

* Name - the name for your Robovac
* IP Address - the IP address of your Robovac.  Configure your DHCP server to serve a static IP address to your Robovac for the best experience.
* Tuya Device ID and Tuya Device Key - these can be obtained by following https://github.com/markbajaj/eufy-device-id-python

### HomeKit

The default accessory is a switch that will run the Eufy Robovac in "auto" mode.  As part of this accessory, a sub-switch is also available to turn on the vacuum's location beacon.

You may also create arbitrary room switches.  A room switch will direct your Eufy Robovac to clean an arbitrary set of rooms.  Use a comma-delimited list corresponding to the room numbers on your Eufy Robovac's map.
