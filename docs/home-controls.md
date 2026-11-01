# Adding home controls (lights, switches, Ring, Blink, Eufy)

FamilyHub never shows a device as controllable unless a real hub is connected. The supported route is **Home Assistant** running in your home; FamilyHub talks to it over a secure link.

## 1. Install Home Assistant at home
1. Get a Raspberry Pi 4/5 (4 GB+), a mini-PC, or a NAS that can run virtual machines.
2. Follow https://www.home-assistant.io/installation/ and install **Home Assistant OS**.
3. Open http://homeassistant.local:8123 on the same Wi-Fi and create the owner account.

## 2. Add your devices to Home Assistant
Settings -> Devices & services -> Add integration, then:
- **Ring** (doorbells, cameras, chimes, alarm): integration "Ring". Sign in with your Ring account and 2-step code.
- **Blink** cameras: integration "Blink". Sign in and enter the email/SMS PIN.
- **Anker Eufy** cameras/doorbells: install HACS (https://hacs.xyz), then the community "Eufy Security" integration with the eufy-security-ws add-on. Support depends on the model; check the device list first.
- **Smart switches and plugs**: Wi-Fi brands (TP-Link Kasa/Tapo, Shelly, Meross, TP-Link) have built-in integrations; Zigbee switches need a Zigbee USB dongle (for example Sonoff ZBDongle-E) with the "ZHA" integration; Z-Wave needs a Z-Wave stick; Matter devices use the "Matter" integration.
- Put each device in an **Area** (Kitchen, Living room...). FamilyHub will group controls by area, like a home map.

## 3. Let FamilyHub reach Home Assistant securely
Pick one:
- **Home Assistant Cloud (Nabu Casa)**, easiest: Settings -> Home Assistant Cloud -> enable Remote control. You get an https://...ui.nabu.casa address.
- **Cloudflare Tunnel** add-on (free): gives an https address without opening router ports.

Do not forward router ports directly.

## 4. Create a FamilyHub access token in Home Assistant
1. Create a dedicated Home Assistant user called "FamilyHub" (not an administrator).
2. Sign in as that user -> Profile -> Security -> Long-lived access tokens -> Create token.
3. Give FamilyHub the https address and the token through Devin's private secret box. Never paste the token in chat.

## 5. What FamilyHub shows once connected
Home Management -> Home automation lists devices from Home Assistant by area, with on/off, brightness, thermostat and lock state, plus recent Ring/Blink/Eufy motion and doorbell events. Locks, alarms and garage doors require parent mode (PIN) on the home display.

The FamilyHub-side connector is built once steps 1-4 are done. Until then the section correctly says "Not connected".
