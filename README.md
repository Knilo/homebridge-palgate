# PalGate Platform for Homebridge

PalGate Platform for Homebridge is a Homebridge plugin that integrates your PalGate-controlled gate devices into HomeKit. The plugin supports both garage door and switch accessory types, and provides customizable options for each device.

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
  Use the `customGates` configuration option to rename, hide, or change the behavior of individual gates.

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
5. The linking will complete and configuration will be updated automatically. You can then edit it as you wish.

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

To configure the PalGate Platform, add the following snippet to your Homebridge config.json file under the platforms section. You can use the included `palgate-cli.js` to extract the neccesary config:

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
      "customGates": [
        {
          "deviceId": "DEVICE_ID",
          "name": "Custom Gate Name",
          "garageDoor": true,
          "switch": false,
          "hide": false
        }
      ]
    }
  ]
}
```

### Options

| Option         | Description                                                                                                                                                                                                                                      |
|----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `token`        | Your session token generated during device linking.                                                                                                                                                                                            |
| `phoneNumber`  | Your account’s phone number (e.g., `972500000000`).                                                                                                                                                                                              |
| `tokenType`    | The linking type. Valid values: <br> - `0` for SMS linking <br> - `1` for primary linking <br> - `2` for secondary linking                                                                                                                      |
| `accessoryType`| Defines the default type for discovered devices; valid values are `"garageDoor"` or `"switch"`.                                                                                                                                                   |
| `customGates`  | An optional array for individual gate configuration. Each object in the array may include: <br> - `deviceId`: Unique identifier for the gate (required). <br> - `name`: A custom name for the gate. <br> - `garageDoor`: Set to `true` to expose as a garage door. <br> - `switch`: Set to `true` to expose as a switch. <br> - `hide`: Set to `true` to hide the gate from HomeKit. |

#### Notes on Accesory Types
- You can expose a gate as both a `garageDoor` and a `switch` by setting both to true. 
- While you can use a `garageDoor` in automations, due to Apple security restrictions, the automation will need to be approved through a push notification. A `switch` can be used without this step. 
- CarPlay will automatically surface a `garageDoor` as you approach your home. This does not happen to a `switch`.

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
