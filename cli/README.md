# Full CLI Reference

   - **Validate a Token:**
     ```bash
     ./palGateCli.js validate --token <your_token> --phoneNumber <phone_number> --tokenType <0|1|2>
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