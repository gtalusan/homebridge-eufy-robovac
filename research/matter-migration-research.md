# Migrating homebridge-eufy-robovac to Homebridge 2.0 Matter Support

## Executive Summary

Homebridge 2.0 introduces native Matter protocol support, allowing plugins to expose devices via the Matter standard (instead of HAP/HomeKit Accessory Protocol alone). The official `homebridge-matter` plugin template[^1] provides a comprehensive reference implementation, including a **`RoboticVacuumCleaner`** device type[^2] that maps almost exactly to what the eufy-robovac plugin needs. The migration is feasible and well-supported: the Homebridge Matter API provides typed cluster definitions, command handlers, and state management utilities. Several real-world plugins (SwitchBot, Tuya) have already begun Matter integration. The Homebridge 2.0 release with Matter is targeted for around May 2026[^3], and the API is considered stable enough for plugin development now.

## Architecture Overview

### HAP (Current) vs Matter (Target)

```
┌──────────────────────────────────────────────────────────────────┐
│                     CURRENT (HAP) Architecture                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Apple Home ──HomeKit/HAP──▶ Homebridge ──▶ Plugin ──▶ RoboVac  │
│                                                                  │
│  Plugin creates:                                                 │
│    PlatformAccessory                                             │
│      └─ Service (Switch, Battery)                                │
│           └─ Characteristic (On, BatteryLevel)                   │
│                └─ onSet/onGet handlers                           │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                     TARGET (Matter) Architecture                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Apple Home ──Matter/Thread──▶ Homebridge ──▶ Plugin ──▶ RoboVac│
│  Google Home ─────────────────┘                                  │
│  Alexa ───────────────────────┘                                  │
│                                                                  │
│  Plugin creates:                                                 │
│    MatterAccessory                                               │
│      └─ Cluster (RvcRunMode, RvcCleanMode, RvcOperationalState) │
│           └─ Attributes (currentMode, operationalState)          │
│           └─ Command Handlers (changeToMode, pause, resume,      │
│              goHome, selectAreas, skipArea)                       │
└──────────────────────────────────────────────────────────────────┘
```

### Key Concept Mapping

| HAP Concept | Matter Equivalent | Description |
|---|---|---|
| `PlatformAccessory` | `MatterAccessory` (Endpoint) | One device / tile in Home app |
| `Service` | `Cluster` | A capability (Switch, Battery, etc.) |
| `Characteristic` | `Attribute` | A property (On, BatteryLevel, etc.) |
| `onSet`/`onGet` handlers | `handlers` object with named commands | Control callbacks |
| `api.registerPlatformAccessories()` | `api.matter.registerPlatformAccessories()` (async) | Registration |
| `configureAccessory()` | `configureMatterAccessory()` | Cache restore |
| `updateCharacteristic()` | `api.matter.updateAccessoryState()` | Push state to Home app |

## The Matter Protocol

### What is Matter?

Matter is a unified, open-source connectivity standard for smart home devices. It was developed by the Connectivity Standards Alliance (CSA, formerly Zigbee Alliance) with backing from Apple, Google, Amazon, Samsung, and others. Key features:

- **Multi-ecosystem**: Works with Apple Home, Google Home, Amazon Alexa, Samsung SmartThings simultaneously
- **Local-first**: Communicates over the local network (Thread, Wi-Fi, Ethernet) — no cloud required for control
- **Thread support**: Can operate over Thread mesh networking for low-power, reliable connectivity
- **IP-based**: Built on standard IP networking
- **Specification v1.4.x**: Current version with robotic vacuum support in Section 12[^4]

### Matter Device Type: RoboticVacuumCleaner (§12.1)

The Matter specification defines a native `RoboticVacuumCleaner` device type[^2] with these clusters:

| Cluster | Purpose | Key Attributes |
|---|---|---|
| `rvcRunMode` | What the vacuum is doing | `supportedModes`, `currentMode` (Idle/Cleaning/Mapping) |
| `rvcCleanMode` | How the vacuum cleans | `supportedModes`, `currentMode` (Vacuum/Mop/Deep Clean) |
| `rvcOperationalState` | Current operational state | `operationalStateList`, `operationalState` (Running/Paused/Docked/etc.) |
| `serviceArea` | Room/zone selection | `supportedAreas`, `selectedAreas`, `currentArea`, `progress` |
| `powerSource` | Battery status | `batPercentRemaining`, `batChargeLevel`, `batReplaceability` |

This is a significant upgrade from the current HAP implementation, which is limited to representing the vacuum as a **Switch** (on/off) and a **Battery** service — essentially a workaround since HomeKit had no native vacuum device type.

## The homebridge-matter Plugin Template

### Repository Structure

The official template at [homebridge-plugins/homebridge-matter](https://github.com/homebridge-plugins/homebridge-matter)[^1] provides:

```
src/
├── index.ts              # Plugin registration (identical pattern to HAP)
├── platform.ts           # MatterPlatform - DynamicPlatformPlugin implementation
├── settings.ts           # Plugin name constants
├── utils.ts              # Error parsing utility
└── devices/
    ├── BaseMatterAccessory.ts      # Abstract base class for all Matter devices
    ├── RoboticVacuumAccessory.ts   # ⭐ Robot vacuum implementation (567 lines)
    ├── OnOffLightAccessory.ts      # Simple light example
    ├── DimmableLightAccessory.ts
    ├── ColorTemperatureLightAccessory.ts
    ├── DoorLockAccessory.ts
    ├── ThermostatAccessory.ts
    ├── FanAccessory.ts
    ├── ... (20+ device types)
    └── custom/
        └── PowerStripAccessory.ts  # Composed device example (multi-endpoint)
```

### Plugin Registration Pattern

The entry point is identical to HAP plugins[^5]:

```typescript
// src/index.ts
import type { API } from 'homebridge'
import { MatterPlatform } from './platform.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MatterPlatform)
}
```

### Platform Class — Key Differences from HAP

The platform class[^6] implements `DynamicPlatformPlugin` but uses Matter-specific APIs:

1. **Matter availability check**: `api.isMatterAvailable?.()` and `api.isMatterEnabled?.()`[^6]
2. **Matter accessory cache**: `configureMatterAccessory(accessory: MatterAccessory)` instead of `configureAccessory(accessory: PlatformAccessory)`[^6]
3. **Async registration**: `await api.matter.registerPlatformAccessories(...)` (async, unlike HAP's sync version)[^6]
4. **UUID generation**: `api.matter.uuid.generate(...)` (same as `api.hap.uuid.generate()` internally)[^7]

### BaseMatterAccessory — The Pattern to Follow

The `BaseMatterAccessory` class[^8] is an abstract base that implements `MatterAccessory`:

```typescript
interface MatterAccessory {
  UUID: string
  displayName: string
  deviceType: EndpointType
  serialNumber: string
  manufacturer: string
  model: string
  firmwareRevision: string
  hardwareRevision: string
  context: Record<string, unknown>
  clusters?: MatterAccessory['clusters']
  handlers?: MatterAccessory['handlers']
  parts?: MatterAccessory['parts']   // For composed devices
}
```

It provides helper methods:
- `updateState(cluster, attributes, partId?)` — typed state updates[^8]
- `readState(cluster, partId?)` — typed state reads[^8]
- `toAccessory()` — converts the class instance to a plain `MatterAccessory` for registration[^8]

### RoboticVacuumAccessory — Direct Reference

The `RoboticVacuumAccessory`[^2] is a **567-line comprehensive example** that demonstrates:

#### Clusters defined:
- **`powerSource`**: Battery at 100%, status Active, non-replaceable[^2]
- **`rvcRunMode`**: Three modes — Idle (16384), Cleaning (16385), Mapping (16386)[^2]
- **`rvcCleanMode`**: 15 modes including Vacuum, Mop, Vacuum & Mop, Deep Clean, Quick Clean, Quiet, Night Mode, Eco, Auto[^2]
- **`rvcOperationalState`**: 11 states — Stopped, Running, Paused, Error, Seeking Charger, Charging, Docked, Emptying Dust Bin, Cleaning Mop, Filling Water Tank, Updating Maps[^2]
- **`serviceArea`**: 4 rooms (Living Room, Kitchen, Bedroom, Bathroom) with area namespace tags[^2]

#### Handlers defined:
```typescript
handlers: {
  rvcRunMode: {
    changeToMode: async (request) => { /* Start/stop cleaning */ }
  },
  rvcCleanMode: {
    changeToMode: async (request) => { /* Change vacuum/mop mode */ }
  },
  rvcOperationalState: {
    pause: async () => { /* Pause cleaning */ },
    resume: async () => { /* Resume cleaning */ },
    goHome: async () => { /* Return to dock */ },
  },
  serviceArea: {
    selectAreas: async (request) => { /* Select rooms to clean */ },
    skipArea: async (request) => { /* Skip a room */ },
  },
}
```

#### Error Handling with MatterStatus:
```typescript
import { MatterStatus } from 'homebridge'

// Throw typed Matter errors from handlers
throw new MatterStatus.InvalidInState('Cannot pause while Docked')
```

## Current Plugin Analysis

### What homebridge-eufy-robovac Does Today

The current plugin[^9] creates HAP accessories:

| Feature | HAP Implementation | Matter Equivalent |
|---|---|---|
| Clean on/off | `Switch` service with `On` characteristic | `rvcRunMode` cluster: Idle ↔ Cleaning |
| Battery level | `Battery` service with `BatteryLevel` | `powerSource` cluster: `batPercentRemaining` |
| Find my robot | `Switch` service (separate) | No direct Matter equivalent (custom cluster or keep as HAP) |
| Room cleaning | Separate `Switch` per room config | `serviceArea` cluster: `selectAreas` + `rvcRunMode` |
| Volume control | `Speaker` service | No direct Matter equivalent |
| Go home | Implicit (turn off → pause → goHome) | `rvcOperationalState.goHome` handler |

### Current Capabilities from eufy-robovac-js

The underlying `@george.talusan/eufy-robovac-js` library provides[^9]:
- `robovac.clean()` — start cleaning
- `robovac.pause()` — pause cleaning
- `robovac.goHome(true)` — return to dock
- `robovac.locate(on)` — find my robot
- `robovac.cleanRooms(rooms)` — clean specific rooms
- `robovac.batteryLevel()` — get battery percentage
- `robovac.docked()` — check if docked
- `robovac.goingHome()` — check if returning home
- `robovac.volume()` / `robovac.setVolume(n)` — volume control
- Events: `tuya.connected`, `tuya.disconnected`, `tuya.data`, `event`, `error`

## Migration Strategy

### Approach: Dual HAP + Matter Support

Following the pattern recommended by bwp91 (homebridge-matter author)[^3], the plugin should support **both HAP and Matter** simultaneously:

```typescript
export class EufyRobovacPlatform implements DynamicPlatformPlugin {
  private matterAccessories: Map<string, MatterAccessory> = new Map()
  private hapAccessories: PlatformAccessory[] = []

  constructor(log: Logging, config: PlatformConfig, api: API) {
    // Check if Matter is available and enabled
    const matterEnabled = api.isMatterAvailable?.() && api.isMatterEnabled?.()
    
    api.on('didFinishLaunching', async () => {
      await this.connectToRobovac()
      
      if (matterEnabled) {
        await this.registerMatterAccessories()
      } else {
        this.registerHapAccessories()  // fallback to existing HAP behavior
      }
    })
  }

  // HAP cache restore (existing behavior)
  configureAccessory(accessory: PlatformAccessory) {
    this.hapAccessories.push(accessory)
  }

  // Matter cache restore (new)
  configureMatterAccessory(accessory: MatterAccessory) {
    this.matterAccessories.set(accessory.UUID, accessory)
  }
}
```

### Matter Accessory Implementation

The primary vacuum would be registered as a `RoboticVacuumCleaner` device type:

```typescript
import type { API, Logger, MatterAccessory } from 'homebridge'
import { BaseMatterAccessory } from './BaseMatterAccessory.js'

export class EufyRobovacMatterAccessory extends BaseMatterAccessory {
  constructor(api: API, log: Logger, config: PlatformConfig, robovac: RoboVac) {
    super(api, log, {
      UUID: api.matter.uuid.generate(`eufy-robovac-${config.ip}`),
      displayName: config.name || 'Eufy RoboVac',
      deviceType: api.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: config.deviceId,
      manufacturer: 'Eufy',
      model: 'RoboVac',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',

      clusters: {
        powerSource: {
          status: 0,
          order: 0,
          description: 'Battery',
          batPercentRemaining: 200,  // 100% = 200
          batChargeLevel: 0,
          batReplaceability: 1,
        },
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 },  // stopped
            { operationalStateId: 1 },  // running
            { operationalStateId: 2 },  // paused
            { operationalStateId: 64 }, // seeking charger
            { operationalStateId: 65 }, // charging
            { operationalStateId: 66 }, // docked
          ],
          operationalState: 66,  // start docked
        },
        // Service areas from config.roomSwitches
        serviceArea: {
          supportedMaps: [],
          supportedAreas: buildAreasFromConfig(config),
          selectedAreas: [],  // populated from config
        },
      },

      handlers: {
        rvcRunMode: {
          changeToMode: async (request) => {
            if (request.newMode === 1) {
              await robovac.clean()
            } else if (request.newMode === 0) {
              await robovac.pause()
              if (robovac.goingHome !== undefined) {
                await robovac.goHome(true)
              }
            }
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await robovac.pause()
          },
          resume: async () => {
            await robovac.clean()
          },
          goHome: async () => {
            await robovac.pause()
            await robovac.goHome(true)
          },
        },
        serviceArea: {
          selectAreas: async (request) => {
            // Map area IDs to room numbers from config
            // Store selected areas for the next clean command
          },
          skipArea: async (request) => {
            // Remove area from active selection
          },
        },
      },
    })

    // Set up event listeners for state sync (Flow B)
    this.setupEventListeners(robovac)
  }

  private setupEventListeners(robovac: RoboVac) {
    robovac.on('tuya.data', async () => {
      // Update battery
      const battery = robovac.batteryLevel()
      await this.updateBatteryPercentage(battery)
      
      // Update operational state
      if (robovac.docked()) {
        await this.updateState('rvcOperationalState', { operationalState: 66 })
        await this.updateState('rvcRunMode', { currentMode: 0 })
      } else if (robovac.goingHome()) {
        await this.updateState('rvcOperationalState', { operationalState: 64 })
      }
    })
  }
}
```

### Features That Don't Map to Matter

| Feature | Recommendation |
|---|---|
| **Find My Robot** (`locate()`) | No Matter equivalent. Could keep as a separate HAP Switch accessory alongside the Matter vacuum, or drop it. |
| **Volume Control** | No Matter equivalent for robotic vacuums. Could keep as HAP or drop. |
| **Per-Room Switches** | Replaced by `serviceArea` cluster — superior native support. Users select rooms in the Home app directly. |

### Important: Robot Vacuum Gets Its Own QR Code

Robot vacuums registered via `registerPlatformAccessories()` automatically receive their own unique QR code for pairing[^4][^6], separate from the main Homebridge bridge QR code. This is mentioned in both the homebridge-matter config schema[^10] and the wiki documentation[^4].

## Existing Plugins Using Matter

### 1. homebridge-matter (Official Template)
- **Repository**: [homebridge-plugins/homebridge-matter](https://github.com/homebridge-plugins/homebridge-matter)[^1]
- **Status**: Active, v1.2.0, by bwp91
- **Relevance**: Primary reference for all Matter device types, including `RoboticVacuumCleaner`
- **Requires**: Homebridge `>=2.0.0-beta.85`, Node `^22.10.0 || ^24.0.0`

### 2. homebridge-switchbot (SwitchBot)
- **Repository**: [OpenWonderLabs/homebridge-switchbot](https://github.com/OpenWonderLabs/homebridge-switchbot)[^11]
- **Status**: Active, has `SwitchBotMatterPlatform.ts` on `latest` branch
- **Approach**: Separate Matter platform class alongside HAP platform; uses `configureMatterAccessory()`, `api.matter.registerPlatformAccessories()`, device type mapping, and OpenAPI polling for state sync[^11]
- **Notable**: Full production integration with both HAP and Matter side-by-side

### 3. homebridge-tuya-matter
- **Repository**: [talrhv/homebridge-tuya-matter](https://github.com/talrhv/homebridge-tuya-matter)[^12]
- **Status**: Beta, JavaScript (ESM)
- **Approach**: Wraps existing Tuya cloud API with Matter bridge layer; supports HAP 1.3+ fallback[^12]
- **Notable**: Uses `TuyaMatterBridge` helper class and MQTT for real-time state sync

### 4. homebridge-roborock-matter-vacuum
- **Repository**: [yahavzarfati/homebridge-roborock-matter-vacuum](https://github.com/yahavzarfati/homebridge-roborock-matter-vacuum)[^13]
- **Status**: Early/placeholder — only contains README and a zip file, no source
- **Relevance**: Someone else is trying to do the exact same thing (robotic vacuum via Matter)

### 5. Matterbridge (Alternative)
- **Not Homebridge**: A separate project ([Luligu/matterbridge](https://github.com/Luligu/matterbridge)) that is a standalone Matter bridge
- **Mentioned in Issues**: Some developers are comparing Homebridge Matter support vs Matterbridge[^14]

## Key Issues & Discussion

### homebridge-matter Issue #2: "Ready for prime time?"[^3]
- **Key insight from bwp91** (March 2026): "We are hoping to release homebridge v2 with matter around the start of May. The matter implementation will probably still be in a beta state."
- **Advice**: "You could start to migrate your plugin to create those services via matter. There's no reason why you can't keep the existing HAP version too."
- **Each service must be its own accessory**: "You'd need to publish each 'part' as its own accessory, rather than trying to bundle all the services into one accessory."

### homebridge-matter Issue #3: "Multiple endpoints under one accessory"[^14]
- **Resolved in v1.2.0**: Multi-endpoint (composed) devices are now supported via the `parts` property on `MatterAccessory`
- **Example**: PowerStripAccessory demonstrates 4 outlets under one device

### homebridge/homebridge Issue #3228: "[Discussion] Implementing Matter"[^15]
- Original discussion from 2022 about Matter support in Homebridge
- Led to the current Homebridge 2.0 Matter implementation

## Technical Requirements for Migration

### Dependencies
```json
{
  "engines": {
    "node": "^22.10.0 || ^24.0.0",
    "homebridge": ">=2.0.0-beta.85"
  },
  "devDependencies": {
    "homebridge": "2.0.0-beta.85"
  }
}
```

### Key TypeScript Imports
```typescript
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,      // NEW - Matter accessory type
  PlatformAccessory,    // EXISTING - HAP accessory type
  PlatformConfig,
  ClusterStateMap,      // NEW - Typed cluster state
  ClusterHandlerMap,    // NEW - Typed handler args
  EndpointType,         // NEW - Device type enum
  MatterRequests,       // NEW - Handler request types
} from 'homebridge'

import { MatterStatus } from 'homebridge'  // NEW - Error types (runtime import)
```

### Checklist for Migration

- [ ] Update `engines` in `package.json` to require `homebridge >= 2.0.0-beta.85`
- [ ] Update Node engine requirement to `^22.10.0 || ^24.0.0`
- [ ] Add `configureMatterAccessory()` method to platform class
- [ ] Add `api.isMatterAvailable?.()` / `api.isMatterEnabled?.()` checks
- [ ] Create `BaseMatterAccessory` (or copy from template)
- [ ] Create `EufyRobovacMatterAccessory` extending base class
- [ ] Define clusters: `powerSource`, `rvcRunMode`, `rvcCleanMode`, `rvcOperationalState`, `serviceArea`
- [ ] Implement handlers: `changeToMode`, `pause`, `resume`, `goHome`, `selectAreas`
- [ ] Wire up `tuya.data` and `event` listeners for Flow B state sync
- [ ] Map `config.roomSwitches` to `serviceArea.supportedAreas`
- [ ] Decide on `locate()` and `volume()` features (HAP fallback or drop)
- [ ] Register via `api.matter.registerPlatformAccessories()`
- [ ] Test with Homebridge 2.0 beta
- [ ] Keep HAP fallback for Homebridge 1.x users

## Confidence Assessment

| Claim | Confidence | Basis |
|---|---|---|
| Matter API shape and usage patterns | **High** | Direct source code analysis of homebridge-matter template |
| RoboticVacuumCleaner device type availability | **High** | Confirmed in template code and wiki documentation |
| Homebridge 2.0 release timeline (~May 2026) | **Medium** | Based on bwp91's comment in Issue #2, subject to change |
| eufy-robovac-js compatibility with Matter handlers | **High** | The underlying library provides all needed methods |
| Dual HAP/Matter support feasibility | **High** | Explicitly recommended by homebridge-matter maintainer |
| Robot vacuum gets separate QR code | **High** | Documented in config schema and wiki |
| Matter API stability | **Medium** | Still in beta; bwp91 notes "hasn't had much exposure to real plugins" |

## Footnotes

[^1]: [homebridge-plugins/homebridge-matter](https://github.com/homebridge-plugins/homebridge-matter) — `package.json` (v1.2.0)
[^2]: `../homebridge-matter/src/devices/RoboticVacuumAccessory.ts` — full 567-line implementation
[^3]: [homebridge-matter Issue #2](https://github.com/homebridge-plugins/homebridge-matter/issues/2) — bwp91 comment (2026-03-07): "We are hoping to release homebridge v2 with matter around the start of May"
[^4]: [homebridge-matter wiki: Section 12 - Robotic Devices](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-12-Robotic)
[^5]: `../homebridge-matter/src/index.ts:1-11`
[^6]: `../homebridge-matter/src/platform.ts:1-456` — MatterPlatform class with `isMatterAvailable`, `isMatterEnabled`, `configureMatterAccessory`, and async `registerPlatformAccessories`
[^7]: [homebridge-matter wiki: API Reference](https://github.com/homebridge-plugins/homebridge-matter/wiki/API-Reference) — `api.matter.uuid` is alias of `api.hap.uuid`
[^8]: `../homebridge-matter/src/devices/BaseMatterAccessory.ts:1-165` — abstract base with `updateState()`, `readState()`, `toAccessory()`
[^9]: `/Users/george/build/homebridge-eufy-robovac/src/platform.ts:1-140` — current HAP implementation using RoboVac library
[^10]: `../homebridge-matter/config.schema.json:136-143` — Robot vacuum config entry describing separate QR codes
[^11]: [OpenWonderLabs/homebridge-switchbot](https://github.com/OpenWonderLabs/homebridge-switchbot) — `src/SwitchBotMatterPlatform.ts` on `latest` branch
[^12]: [talrhv/homebridge-tuya-matter](https://github.com/talrhv/homebridge-tuya-matter) — `src/platform.mjs` and `lib/matter_support.mjs`
[^13]: [yahavzarfati/homebridge-roborock-matter-vacuum](https://github.com/yahavzarfati/homebridge-roborock-matter-vacuum) — placeholder repo, no source code
[^14]: [homebridge-matter Issue #3](https://github.com/homebridge-plugins/homebridge-matter/issues/3) — Multi-endpoint support discussion, resolved in v1.2.0
[^15]: [homebridge/homebridge Issue #3228](https://github.com/homebridge/homebridge/issues/3228) — Original Matter discussion from 2022
