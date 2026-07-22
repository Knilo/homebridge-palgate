[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM](https://img.shields.io/badge/NPM-%23CB3837.svg?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/homebridge-palgate)
[![Ko-fi](https://img.shields.io/badge/support_me_on_ko--fi-F16061?style=for-the-badge&logo=kofi&logoColor=f5f5f5)](https://ko-fi.com/Knilo)

# PalGate Platform for Homebridge

PalGate Platform for Homebridge is a Homebridge plugin that integrates your PalGate controlled gate devices into HomeKit. The plugin supports garage door, switch, and lock accessory types, and provides customizable options for each device.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Automatic Configuration](#automatic-configuration)
- [Manual Configuration](#manual-configuration)
- [Support Me](#support-me)
- [Credits](#credits)
- [License](#license)
- [Disclaimer](#disclaimer)

## Features

- **Set Up using the Homebridge UI:**  
  No complicated token extraction required! Simply use the Set Up screen in the Homebridge UI to get everything configured.

- **Automatic Device Discovery:**  
  After Homebridge launches, the plugin automatically retrieves and registers your gate devices using the PalGate API.
  
- **Flexible Accessory Types:**  
  Expose each discovered gate as a garage door, switch, or lock. The default type can be overridden on a per-device basis.

- **Custom Gate Settings:**  
  Use the Homebridge UI or the `customGates` configuration option to rename, hide, or change the behavior of individual gates.

- **Multi-Gate Device Support:**  
  The plugin supports PalGate devices that control multiple gates as well as devices controlling a single gate.

- **External-Open Detection (opt-in):**  
  Poll the PalGate operation log and animate the accessory when a gate is opened outside HomeKit (from the PalGate app, a dial-in call, or another remote). This also gives you native Home-app "opened" notifications for free.

- **Timed Hold via Valve Mode (opt-in):**  
  Expose the Hold Open / Hold Closed relays as HomeKit Valves so you can set a duration and watch a live countdown natively in the Home app ("hold open for 30 minutes, then return to normal").

- **CLI Support:**  
  All the main PalGate API features are supported through the custom CLI. 
  ```bash
  ./cli/palgate-cli.js
  ```

## Installation
1. **Install Homebridge:**  
  If you haven’t already installed Homebridge, follow the instructions on [Homebridge’s website](https://homebridge.io/).
  
2. **Install the Plugin:**  
   Install the plugin using the command below, or through the Homebridge UI.
   ```bash
   npm install -g homebridge-palgate
   ```

3. **Restart Homebridge:**  
  Restart Homebridge to load the new plugin and configure it.

## Automatic Configuration

### Using the UI

This plugin features an automatic configuration UI that simplifies the device linking and configuration process. Follow these steps to configure your device:

1. Open the Homebridge UI
2. Go to Plugins and click Set Up 
3. Click the Begin Device Linking button. This initiates the linking process and generates a QR code.
4. Open the PalGate App, and navigate to Device Linking > Link a Device and then scan the QR code.
5. The linking will complete and configuration will be updated automatically. 
6. Once linked, you can use Customise Gates button to change the name or accessory type of each gate connected to your account.

### Using the CLI

A CLI tool is included to extract the required information using the latest PalGate API and setup the plugin automatically.

1. **Build and Prepare the CLI Tool:**
   - Install the dependencies:
     ```bash
     npm install
     ```
   - Make the CLI executable:
     ```bash
     chmod +x ./cli/palgate-cli.js
     ```

2. **Run the Full Setup Command:**
   - To run the device linking flow (which displays a QR code for linking) and then retrieve your device information, run:
     ```bash
      ./cli/palgate-cli.js config --auto
     ```
     This command will:
     - Start device linking (displaying a QR code).
     - Wait for you to scan the QR code using the PalGate App.
     - Once linked, it retrieves your phone number, session token, and token type.
     - It prints out the following information:
       - `phoneNumber`
       - `token`
       - `tokenType`
     - Additionally, when you use the `--auto` flag, it appends the platform configuration to your Homebridge config file at `~/.homebridge/config.json` and saves the linking data to a local configuration file (`~/.palgate-cli.json`) for further CLI usage.

## Manual Configuration

To configure the PalGate Platform, add the following snippet to your Homebridge config.json file under the platforms section. You can use the included `palgate-cli.js` to extract the necessary config:

```json
{
  "platforms": [
    {
      "platform": "PalGatePlatform",
      "name": "PalGate Platform",
      "token": "<session_token>",
      "phoneNumber": "<phone_number>",
      "tokenType": <0|1|2>,
      "accessoryType": "garageDoor",
      "triggerMode": "stateful",
      "gateOpeningDelay": 1000,
      "gateCloseDelay": 5000,
      "pollInterval": 60,
      "enableRelayLocks": true,
      "relayAccessoryType": "lock",
      "detectExternalOpens": false,
      "logPollInterval": 15,
      "customGates": [
        {
          "deviceId": "DEVICE_ID",
          "name": "Custom Gate Name",
          "garageDoor": true,
          "triggerMode": "stateless",
          "gateOpeningDelay": 1000,
          "gateCloseDelay": 8000,
          "relayLock": true
        }
      ]
    }
  ]
}
```

### Options

| Option | Description |
|---|---|
| `token` | Your session token generated during device linking. |
| `phoneNumber` | Your account’s phone number (e.g., `972500000000`). |
| `tokenType` | The linking type. Each PalGate account supports two device link slots. Valid values: <br> - `0` for SMS <br> - `1` for Linked Device 1 <br> - `2` for Linked Device 2 |
| `accessoryType`| Defines the default type for discovered devices; valid values are `"garageDoor"`, `"switch"`, or `"lock"`. |
| `triggerMode` | How accessories respond to a tap. Valid values: <br> - `"stateful"` — tap to open; tap again to trigger the closing animation in the Home app <br> - `"stateless"` — always triggers a new opening, even if the gate is listed as open <br> - `"momentary"` — triggers an opening, then immediately resets the accessory state to closed <br> Default is `"stateful"`. |
| `gateOpeningDelay` | The first part (ms) of the open window. A `garageDoor` shows it as the "Opening" state before "Open"; a `switch` or `lock` has no "Opening" state, but the time still counts toward how long it stays on/unlocked. The full window is `gateOpeningDelay` + `gateCloseDelay` for every type. Default is `1000`. |
| `gateCloseDelay` | The second part (ms) of the open window, after `gateOpeningDelay`, before the accessory returns to closed/locked/off. The full window is `gateOpeningDelay` + `gateCloseDelay`. Default is `5000`. |
| `pollInterval` | How often (in seconds) the plugin checks the PalGate API for changes made outside HomeKit, such as a relay toggled by another admin. Default is `60`, minimum `10`. |
| `detectExternalOpens` | Poll the PalGate operation log and animate accessories when a gate is opened outside HomeKit (PalGate app, dial-in call, another remote). Applies only to gates where you have admin access (the operation log is admin-only; no latch permission required). Default is `false`. |
| `logPollInterval` | How often (in seconds) to poll the operation log for external opens. Only applies when `detectExternalOpens` is enabled. Default is `15`, minimum `5`. |
| `enableRelayLocks` | Expose virtual relay accessories (Hold Open / Hold Closed) for gates where you have latch permission. Default is `false`. |
| `relayAccessoryType` | The accessory type to use for global virtual relay controllers. Valid values are `"lock"`, `"switch"`, or `"valve"`. Default is `"lock"`. |
| `valveDefaultDuration` | Default hold time (in seconds) for Valve relay accessories, shown as the countdown timer in the Home app. `0` holds indefinitely until manually released. Maximum `3600` (1 hour, HomeKit's limit). Default is `300` (5 minutes). Only applies when the relay accessory type is `"valve"`. |
| `relayHoldOpen` | When Relay Mode is enabled, expose the Hold Open accessory. Default is `true`. |
| `relayHoldClosed` | When Relay Mode is enabled, expose the Hold Closed accessory. Default is `true`. |
| `customGates` | An optional array of per-gate overrides. **Best managed through the plugin UI** — each entry contains only the settings you have overridden for that gate. See the per-gate options below. |

#### Per-gate options (`customGates[]`)

| Option | Description |
|---|---|
| `deviceId` | Unique identifier for the gate (required). For devices with multiple outputs, use format `deviceId:outputNum` (e.g., `"ABC123:2"` for output 2). |
| `name` | A custom name for the gate. |
| `garageDoor` | Set to `true` to expose as a garage door. |
| `switch` | Set to `true` to expose as a switch. |
| `lock` | Set to `true` to expose as a lock. |
| `hide` | Set to `true` to hide the gate from HomeKit. |
| `triggerMode` | Override the trigger mode for this gate; same values as the global `triggerMode`. |
| `gateOpeningDelay` | Override `gateOpeningDelay` (in ms) for this gate — part of the open window for every accessory type (see above). |
| `gateCloseDelay` | Override the close delay (in ms) for this specific gate. |
| `relayEnabled` | Per-gate relay override. `true` enables relay accessories for this gate even when Relay Mode is globally disabled; `false` disables them regardless of the global setting. Omit to follow the global setting. Requires latch permission. |
| `relaySwitch` | Set to `true` to expose the virtual relays for this gate as Switches. |
| `relayLock` | Set to `true` to expose the virtual relays for this gate as Locks. |
| `relayValve` | Set to `true` to expose the virtual relays for this gate as Valves (timed hold with a native Home-app countdown). |
| `valveDefaultDuration` | Override the default Valve hold duration (in seconds) for this gate. `0` = indefinite, maximum `3600`. Omit to use the global `valveDefaultDuration`. |
| `relayHoldOpen` | Set to `false` to hide the Hold Open accessory for this gate. |
| `relayHoldClosed` | Set to `false` to hide the Hold Closed accessory for this gate. |
| `detectExternalOpens` | Per-gate override for external-open detection. Only effective on gates where you have admin access. Omit to follow the global `detectExternalOpens` setting. |

#### Accessory Types
- You can expose a gate as a combination of `garageDoor`, `switch`, and `lock` simultaneously by setting the respective fields to true. 
- While you can use a `garageDoor` or `lock` in automations, due to Apple security restrictions, the automation will need to be approved through a push notification. A `switch` can be used without this step. 
- CarPlay will automatically surface a `garageDoor` as you approach your home. This does not happen to a `switch` or `lock`.
- The state HomeKit shows is animated on a timer, not the gate's real position (PalGate doesn't report it). In `stateful` and `stateless` modes, all three accessory types behave the same: after a trigger the accessory returns to its resting state — a `garageDoor` to "closed", a `lock` to "locked", a `switch` to "off" — after `gateOpeningDelay` + `gateCloseDelay` (the same total for every type). The only difference is cosmetic: a `garageDoor` splits that window into an "Opening" animation (`gateOpeningDelay`) followed by "Open" (`gateCloseDelay`), whereas a `switch` and `lock` show no intermediate state and just stay on/unlocked for the whole window. In `momentary` mode the accessory resets immediately instead.

#### Trigger Modes
`triggerMode` controls how an accessory reacts to a tap — set it globally or per gate.
- **Stateful** (default): Tap to open; the accessory animates open, then returns to rest after the open delay. Tapping again while it's still "open" just cancels the animation — it does **not** send another open command. Best when you want the tile to reflect an open/closed cycle.
- **Stateless**: Every tap sends an open command, even if the accessory is already open or mid-cycle. Best for gates you may want to re-trigger, or where the on-screen state doesn't matter.
- **Momentary**: Sends an open command, then immediately snaps back to closed/locked/off with no open window. Best for a push-button feel, or for triggering from automations and Siri.

#### External-Open Detection
When `detectExternalOpens` is enabled, the plugin polls the PalGate operation log (`logPollInterval`, default 15s) and animates the matching accessory whenever the gate is opened outside HomeKit — from the PalGate app, a dial-in call, or another remote.

* **Admin only:** the operation log is accessible only to gate admins (no latch permission is required, unlike Relay Mode). Detection is offered only for gates where you have admin access; non-admin gates show a note explaining this and are never polled.
* This surfaces native Home-app "opened" notifications for those events.
* The plugin never replays history: on startup it only reacts to opens that happen from then on.
* Opens triggered by the plugin itself (your own HomeKit taps) are de-duplicated so you won't see a doubled animation. The match window is at least 30 seconds and automatically grows to the poll interval, so a self-open is never misreported even with a long `logPollInterval`. Opens by your account from the PalGate app well after any HomeKit action are still surfaced.
* Detection is read-only — it never issues an open command; it only mirrors what already happened.

#### Relay Mode
Virtual relay controllers allow HomeKit to hold the gate in an "Always Open" (latch/hold open) or "Always Closed" (hold closed) state.
* **Important Permissions Required**: 
  Make sure the user (phone) that this gate is linked through, has the special permission for this action (on Palgate app, admin user: **Gate settings** -> **Manager Options** -> **Users** -> **Selected user** -> **"Latch Output 1"**).
* **Availability**: If the linked phone's user does not have the right permission, the Relays will not be exposed to Homekit. Once permission is granted, it will become operational.

#### Valve Mode
Set `relayAccessoryType` to `"valve"` (globally) or `relayValve: true` (per gate) to expose the Hold Open / Hold Closed relays as HomeKit **Valves**. Valves are the only HAP service with a native duration UI, so the Home app shows a live countdown on the tile and lets you set a default run time in the accessory's settings.

* Turn the valve **on** to hold the gate; it counts down the duration you set and automatically returns the relay to normal mode when it reaches zero. Turning it **off** early cancels the countdown and returns to normal immediately.
* A duration of `0` means an **indefinite** hold (no countdown), matching the lock/switch behavior.
* **Trade-offs**:
  * The Home app renders valves with **water iconography** (a faucet/sprinkler tile) — there's no gate glyph for valves.
  * The native duration picker **caps at 1 hour**.
  * If Homebridge restarts mid-countdown, the hold is **released to normal** on startup to avoid issues.
* You can get a timed hold without Valve Mode: with the Switch relay type, create a Home automation **"When Hold Open turns On → Turn Off after N hours"** (the Home app offers an auto-off delay up to 4 hours). When the switch turns off, the plugin returns the relay to normal. You can also use a pair of automations to enable and disable any of the Relay types (Switch, Lock, or Valve) on a schedule.


## Support Me

If you appreciate this contribution to the community, [please consider leaving me a tip!](https://ko-fi.com/knilo)

[![Ko-fi](https://img.shields.io/badge/support_me_on_ko--fi-F16061?style=for-the-badge&logo=kofi&logoColor=f5f5f5)](https://ko-fi.com/Knilo)


## Credits

Original plugin created by [@RoeiOfri](https://github.com/RoeiOfri).

API logic discovered by [@DonutByte](https://github.com/DonutByte).

Rewrite and platform migration by [@Knilo](https://github.com/Knilo).

## License

This project is licensed under the MIT License.

## Disclaimer

This project is intended for research purpose only.

This project is not affiliated with, endorsed by, or in any way officially connected to PalGate.

The use of this software is at the user's own risk. The author(s) of this project take no responsibility and disclaim any liability for any damage, loss, or consequence resulting directly or indirectly from the use or application of this software.

Users are solely responsible for ensuring their use of this project complies with all applicable laws, regulations, and terms of service of any related platforms or services. The author(s) bear no accountability for any actions taken by users of this software.
