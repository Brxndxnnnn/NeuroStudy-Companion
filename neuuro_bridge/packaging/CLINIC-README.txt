NeuuroBridge — SenzeBand EEG bridge
===================================

Streams EEG from a Neeuro SenzeBand headset straight to the NeuroStudy
database while the web app runs the session.

Requirements
------------
- Windows 10 (1903+) or Windows 11, 64-bit. Uses the .NET Framework 4.8
  that ships with Windows — nothing to install.
- Bluetooth LE (built-in or USB dongle).
- Internet access: activation and license checks happen online, and the
  app writes directly to the study database.

Install (once per machine)
--------------------------
1. Run NeuuroBridge-win-Setup.exe.
   If Windows shows "Windows protected your PC", click "More info" then
   "Run anyway" — this appears once because the app is not yet signed.
2. The app starts and asks for an ACTIVATION CODE. Enter the code given
   by the study administrator. That's the whole setup — no configuration
   files, no credentials to type.
3. If the code is rejected, check for typos, then ask the administrator
   for a fresh code.

Updates
-------
The app checks for updates when it starts and asks before installing
them. Say No if a session is about to run; it will offer again next
launch. Updates never touch the activation — you activate once.

Daily use
---------
1. Power on the SenzeBand and wear it.
2. In the app: Scan, then Connect. Wait until authentication completes and
   signal quality looks good (reseat electrodes flagged "NO SIGNAL").
3. Start the session from the NeuroStudy web app — recording starts by
   itself when the web session begins. Leave the bridge window open.
4. The DB panel shows rows uploaded; "NOT connected — recording locally
   only" in red means data is not reaching the database — tell the admin.

Troubleshooting
---------------
- No data after a disconnect/reconnect: press Reauth, then reconnect.
- Activation problems, license errors, or database errors: contact the
  study administrator.
- Moving the app to a new machine: the administrator issues a new
  activation code for it.
