# Update #
- This plugin has now been updated to work with the newest token and API flow for PalGate and works as of Feburary 2025.
- It has been updated to support Homebridge 2.0.

# Authors

Original plugin created by [@RoeiOfri](https://github.com/RoeiOfri).

API logic discovered by [@DonutByte](https://github.com/DonutByte).

Rewrite and migration by [@Knilo](https://github.com/Knilo).

# homebridge-palgate-opener
This plugin enables connection between Pal Gate App Controled systems and Apple HomeKit.

Before installing the homebridge plugin you must obtain the following info:
- Device ID: The ID for the gate you wish to control and can be found using the CLI (explained below)
- Phone Number: This is the phone number of your account beginning with the country code (eg 972000000000)
- Session Token: Extracted using the CLI (explained below)
- Token Type: 1 (Primary) or 2 (Secondary) and can be found using the CLI (explained below)

# Extract Session Token, Token Type and Devices

A CLI tool is provided to extract the required information using the latest PalGate API. Follow these steps:

1. **Build and Prepare the CLI Tool:**
   - Install the dependencies:
     ```bash
     npm install
     ```
   - Make the CLI executable:
     ```bash
     chmod +x palGateCli.js
     ```

2. **Run the Full Setup Command:**
   - To run the device linking flow (which displays a QR code for linking) and then retrieve your device information, run:
     ```bash
      ./palGateCli.js config --auto
     ```
     This command will:
     - Start device linking (displaying a QR code).
     - Wait for you to scan the QR code using the PalGate App.
     - Once linked, it retrieves your phone number, session token, and token type.
     - It then calls the devices endpoint to list your gate IDs.
     - **Final Output:** It prints a JSON object with the following keys:
       - `phoneNumber`
       - `token` (the permanent session token)
       - `tokenType`
       - `deviceIds`
     - Additionally, when you use the `--auto` flag, it appends new accessory configuration objects (one per gate) to your Homebridge config file at `~/.homebridge/config.json` and saves the linking data (excluding devices) to a local configuration file (`palGateCLI.config`). So your plugin will be ready to go!





# Plugin-in configuration

## Configure plugin via UI
1. Open your HomeBridge UI and navigate to "Plugins" tab.
2. Locate the PalGateOpener plugin and click on "Settings".
3. Follow on-screen instructions, please do so *after* extracting the required information listed above.

## Manual configuration (configuration.yaml file)
```
"accessories": [
    {
        "accessory": "PalGateOpener",
        "name": "<chosen name>",
        "deviceId": "<device id>",
        "token": "<token>,
        "phoneNumber": "<phone number>",
        "tokenType": <0|1|2>,
        "accessoryType": "garageDoor"
    }
]
```
# Explanation
| key | Mandatory/Optional |Description |
| --- | --- | --- |
| `accessory` | Yes |Must be PalGateOpener |
| `name` |Yes |Chosen name to populate to HomeKit |
| `deviceId`|Yes | Gate ID extracted from CLI tool |
| `token` |Yes| Token extracted using pylgate |
| `phoneNumber` |Yes| Phone number for your account |
| `tokenType` |Yes| 0 (SMS) or 1 (Primary) or 2 (Secondary) |
| `accessoryType`|No - Default usage: garageDoor | switch/garageDoor* |

### Please note:
1. The default accessoryType is set to `garageDoor`, if using `garageDoor` HomeKit can use location services to open the gate
automatically when arriving home but approval via push notification must be given. This is a security feature by Apple. If you wish to "bypass" it please set the `accessoryType` as `switch`.
2. You can duplicate the accessory so you will have one button as GarageDoor button useable in CarPlay and a switch for any automations.

2. When setting the `accessoryType` as `garageDoor` automation will not work independetly (as mentioned above) but you will loose the ability
to see the ability to use the Garage Door icon in Apple CarPlay.
If you wish that the gate will open automaticlly by setting location service automation please use `switch` as `accessoryType` value.

# Full CLI Reference:

   - **Validate a Token:**
     ```bash
     ./palGateCli.js validate --token <your_token> --phoneNumber <phone_number> --tokenType <1|2>
     ```
     Generates a temporary token from your credentials and validates it with the PalGate API.

   - **Open the Gate:**
     ```bash
     ./palGateCli.js open --deviceId <your_deviceId> --token <your_token> --phoneNumber <phone_number> --tokenType <1|2>
     ```
     Opens the gate corresponding to the specified device ID.

   - **Retrieve Devices:**
     ```bash
     ./palGateCli.js devices --token <your_token> --phoneNumber <phone_number> --tokenType <1|2>
     ```
     Retrieves a list of devices (gates) from the PalGate API.

   - **Generate a Temporary Token:**
     ```bash
     ./palGateCli.js token --token <your_token> --phoneNumber <phone_number> --tokenType <0|1|2>
     ```
     Prints the generated temporary token as JSON.

   - **Link Only:**
     ```bash
     ./palGateCli.js link
     ```
     Starts the device linking flow (shows the QR code and waits for linking) and prints the linking data (phone number, session token, token type) as plain text.

   - **Generate Config:**
     ```bash
      ./palGateCli.js config [--auto]
     ```
      Starts the device linking flow (shows the QR code and waits for linking). Retrieves the gateIds and prints the information. 
      
      When using the `--auto` command, the Homebride config will be automatically updated as well.
      

   - **Verbose Mode:**
     Add the `--verbose` flag to any command to enable detailed debug logging:
     ```bash
     ./palGateCli.js config --verbose
     ```
     In verbose mode, additional debug messages are printed to stdout. Otherwise, only essential prompts and the final JSON output are printed.

   - **Short Flags:**
     There are short versions of all the flags:
     ```bash
     --token | -t
     --phoneNumber | -p
     --token | -t
     --tokenType | -T
     --deviceId | -d
     --auto | -a
     --verbose | -v
     ```
     In verbose mode, additional debug messages are printed to stdout. Otherwise, only essential prompts and the final JSON output are printed.


# FAQ
### Can I control more than one Pal Gate barriers?
Yes you can! just insert the block more than once with different name and with the same token and deviceID and it should work just fine.
### Will I still be able to use the PalGate app on my phone?
Yes! With the Device Linking feature, adding this plugin using Pylgate does not remove access from your phone.
### Will I still be able to use voice-dial to open the gate?
Yes you can, it has nothing to do with this plugin.

# Disclaimer
This project is intended for research purpose only.

This project is not affiliated with, endorsed by, or in any way officially connected to PalGate.

The use of this software is at the user's own risk. The author(s) of this project take no responsibility and disclaim any liability for any damage, loss, or consequence resulting directly or indirectly from the use or application of this software.

Users are solely responsible for ensuring their use of this project complies with all applicable laws, regulations, and terms of service of any related platforms or services. The author(s) bear no accountability for any actions taken by users of this software.

# Support the original creator:
- https://paypal.me/roeio
- https://www.buymeacoffee.com/roeio
