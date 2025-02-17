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

# Use palGateCli.js to extract the Session Token, Token Type and Devices

1. Build the plugin `npm install`
2. Make the utility executable `chmod +x palGateCli.js`
3. Run `palGateCli.js config`
4. Open the PalGate App > Device Linking > Link A Device and scan the QR Code
5. All the required config will be printed, for example:
```
Configuration:
{
  "phoneNumber": "<phoneNumber>",
  "token": "<token>",
  "tokenType": <0|1|2>,
  "deviceIds": [
    "<deviceId1>",
    "<deviceId2>"
  ]
}
```
6. Copy this info to use in the config of the plugin. This output is also saved to `palGateCli.config`.
Note: on future usuage of the CLI for other commands (eg `./palGateCli.js devices`) it will use the saved config to populate the values and so the flags are not needed.

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
| `accessoryType`|No - Default usage: switch | switch/garageDoor* |

### Please note:
1. The default accessoryType is set to `switch`, if using `garageDoor` HomeKit can use location services to open the gate
automatically when arriving home but approval via push notification must be given. This is a security feature by Apple. If you wish to "bypass" it please set the `accessortyType` as `switch`.
2. You can duplicate the accessory so you will have one button as GarageDoor button useable in CarPlay and a switch for any automations.

2. When setting the `accessoryType` as `garageDoor` automation will not work independetly (as mentioned above) but you will loose the ability
to see the ability to use the Garage Door icon in Apple CarPlay.
If you wish that the gate will open automaticlly by setting location service automation please use `switch` as `accessoryType` value.


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
