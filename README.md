[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM](https://img.shields.io/badge/NPM-%23CB3837.svg?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/homebridge-palgate)
[![Ko-fi](https://img.shields.io/badge/support_me_on_ko--fi-F16061?style=for-the-badge&logo=kofi&logoColor=f5f5f5)](https://ko-fi.com/Knilo)

# PalGate Platform for Homebridge

PalGate Platform for Homebridge is a Homebridge plugin that integrates your PalGate controlled gate devices into HomeKit. The plugin supports both garage door and switch accessory types, and provides customizable options for each device.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Automatic Configuration](#automatic-configuration)
- [Manual Configuration](#manual-configuration)
- [Usage](#usage)
- [Credits](#credits)
- [Disclaimer](#disclaimer)

## Features

- **Set Up using the Homebridge UI:**  
  No complicated token extraction required! Simply use the Set Up screen in the Homebridge UI to get everythign configured.

- **Automatic Device Discovery:**  
  After Homebridge launches, the plugin automatically retrieves and registers your gate devices using the PalGate API.
  
- **Flexible Accessory Types:**  
  Configure each discovered gate as either a garage door or a switch. The default behavior can be overridden on a per-device basis.

- **Custom Gate Settings:**  
  Use the Homebridge UI or the `customGates` configuration option to rename, hide, or change the behavior of individual gates.

- **Multi-Gate Device Support:**  
  The plugin supports PalGate devices that control multiple gates as well as devices controlling a single gate.

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
      "gateOpeningDelay": 1000,
      "gateCloseDelay": 5000,
      "enableRelayLocks": true,
      "relayAccessoryType": "lock",
      "customGates": [
        {
          "deviceId": "DEVICE_ID",
          "name": "Custom Gate Name",
          "garageDoor": true,
          "switch": false,
          "lock": false,
          "hide": false,
          "gateOpeningDelay": 1000,
          "gateCloseDelay": 8000,
          "relayEnabled": true,
          "relaySwitch": false,
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
| `gateOpeningDelay` | The duration in milliseconds that the gate remains in the "Opening" state before transitioning to fully "Open". **Only relevant for Garage Door accessories.** Default is `1000`. |
| `gateCloseDelay` | The duration in milliseconds that a `garageDoor`, `switch`, or `lock` accessory remains in the open/unsecured/on state before automatically transitioning back to closed/locked/off. Default is `5000`. |
| `enableRelayLocks` | Expose virtual relay accessories (Hold Open / Hold Closed) for gates where you have admin/latching permissions. Default is `true`. |
| `relayAccessoryType` | The accessory type to use for global virtual relay controllers. Valid values are `"lock"` or `"switch"`. Default is `"lock"`. |
| `customGates` | An optional array for individual gate configuration. **These settings are best managed through the plugin UI** — editing them manually is only needed for advanced use cases. Each object may include the fields below. |

> **Note on UI-managed fields:** `admin`, `latch`, and `defaultName` inside `customGates` entries are written automatically by the plugin UI to cache discovery results. Do not edit them manually — they will be overwritten on the next discovery.

| `customGates[].deviceId` | Unique identifier for the gate (required). For devices with multiple outputs, use format `deviceId:outputNum` (e.g., `"ABC123:2"` for output 2). |
| `customGates[].name` | A custom name for the gate. |
| `customGates[].garageDoor` | Set to `true` to expose as a garage door. |
| `customGates[].switch` | Set to `true` to expose as a switch. |
| `customGates[].lock` | Set to `true` to expose as a lock. |
| `customGates[].hide` | Set to `true` to hide the gate from HomeKit. |
| `customGates[].gateOpeningDelay` | Override the opening state duration (in ms) for this specific gate. **Only relevant for Garage Door accessories.** |
| `customGates[].gateCloseDelay` | Override the close delay (in ms) for this specific gate. |
| `customGates[].relayEnabled` | `true` (default) allows relay accessories if Relay Mode is globally enabled. `false` disables relay accessories for this gate regardless of the global setting. |
| `customGates[].relaySwitch` | Set to `true` to expose the virtual relays for this gate as Switches. |
| `customGates[].relayLock` | Set to `true` to expose the virtual relays for this gate as Locks. |
| `customGates[].admin` | **UI-managed.** Cached from last discovery. `true` if the linked account is an admin user on this device. Do not edit manually. |
| `customGates[].latch` | **UI-managed.** Cached from last discovery. `true` if latch mode is enabled for this gate output (set by an admin in the PalGate app under Gate Settings → Manager Options). Do not edit manually. |
| `customGates[].defaultName` | **UI-managed.** Cached from last discovery. The device name returned by the PalGate API, used as a display fallback before the next discovery runs. Do not edit manually. |

#### Notes on Accessory Types
- You can expose a gate as a combination of `garageDoor`, `switch`, and `lock` simultaneously by setting the respective fields to true. 
- While you can use a `garageDoor` or `lock` in automations, due to Apple security restrictions, the automation will need to be approved through a push notification. A `switch` can be used without this step. 
- CarPlay will automatically surface a `garageDoor` as you approach your home. This does not happen to a `switch` or `lock`.
- The state reported by HomeKit does not reflect the actual physical state of the gate. For `garageDoor`s and `lock`s, the accessory will automatically switch to “closed”/”locked” after the delay specified by `gateCloseDelay` (and `gateOpeningDelay`), regardless of the door’s physical state. A `switch` will also remain "on" for the duration of the Close Delay before automatically switching back to "off".

#### Notes on Relay Mode Controllers
Virtual relay controllers allow HomeKit to hold the gate in an "Always Open" (latch/hold open) or "Always Closed" (hold closed) state.
* **Important Permissions Required**: 
  Make sure the user (phone) that this gate is linked through, has the special permission for this action (on Palgate app, admin user: **Gate settings** -> **Manager Options** -> **Users** -> **Selected user** -> **"Latch Output 1"**).
* **Availability**: If the linked phone's user does not have the right permission, the Relays will not be exposed to Homekit. Once permission is granted, it will become operational.

## Support Me

If you appreciate this contribution the community, [please consider leaving me a tip!](https://ko-fi.com/knilo)

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
