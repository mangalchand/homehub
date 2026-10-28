# Android app (APK) and wall-tablet setup

The Android app (`apps/android`, Capacitor) is a full-screen shell around the hosted FamilyHub web app. Web changes arrive from the server; native plugin or permission changes require installing a new APK. It keeps the screen awake for wall displays.

Production URL baked into the APK: `https://44-198-103-49.sslip.io` (override with `FAMILYHUB_URL` at build time).

## Family safety and communication (1.2)

Install the updated APK over the previous debug build to add the native Geolocation plugin. The hosted API/web deployment must also contain the family-feature migration and routes; installing this shell alone does not deploy them. Location, microphone, notification and text-to-speech behavior still needs verification on the actual Android device.

- **Panic / SOS** is available throughout the signed-in app, including a shortcut from the idle photo frame. Confirm activation; optionally consent to share the latest location while the app is open and visible. Denying GPS still creates an alert. Stop it in **More → Safety**; alerts expire after 30 minutes. No background tracking, location history or guaranteed emergency dispatch/delivery.
- **More → Notes** supports household notes with images. Saved tasks and notes accept up to five JPEG, PNG or WebP images, each up to 10 MB. Uploads require connectivity and confirmation from the server.
- **More → Evening summary** previews pending tasks and points, shows saved delivery history and lets an owner/admin or PIN-unlocked display change the default **20:30 household-time-zone** schedule. Delivery uses the in-app feed and configured best-effort push, not email, SMS or WhatsApp messaging.
- **Home Management → Communication** or **Safety** lets an owner/admin or PIN-unlocked display paste a WhatsApp Calls link. Each person taps **Join family call**; FamilyHub cannot automatically ring everyone. Anyone with the link may join; clearing the shortcut does not revoke the WhatsApp link.
- **More → Announcements** supports typed announcements and microphone composition on paired home displays. Unlock the household PIN before posting from a display. Commands include “announce dinner is ready”, “read announcements”, “read notifications”, “read my points” and “read pending tasks”. Rewards and the notification bell also have read-aloud buttons. Automatic spoken household alerts are opt-in per display and never include personal inboxes. Speech recognition is tap-to-start, not continuous listening.

## Install on an Android phone or tablet

1. Copy `FamilyHubPro.apk` to the device (Google Drive, email, USB cable, or open the download link on the device).
2. Tap the file. When Android asks, allow **Install unknown apps** for the app you opened it with (Settings → Apps → Special access → Install unknown apps).
3. Tap **Install**, then **Open**.
4. Sign in with your account — or, for a shared kitchen tablet, choose **Wall display**, and pair it with the code from **Settings → Wall displays** on a parent's phone.

No APK? Any Android device can also install the web app: open the URL in Chrome → menu ⋮ → **Install app / Add to Home screen**.

## Make a tablet a dedicated wall display

- Settings → Display → Screen timeout: *Never* (or keep the device charging; the app keeps the screen on while open).
- Settings → Security → **App pinning** (Screen pinning): open FamilyHub, open Recents, tap the app icon → *Pin*. This keeps kids in the app.
- In FamilyHub, kiosk mode is on automatically for paired wall displays. After 5 idle minutes the **photo frame screensaver** starts; tap to return. Night mode dims the screen on a schedule (Settings → Display).

## Build the APK yourself

## Voice, alerts and email codes

- On a paired display, tap the microphone, grant microphone permission and speak in English. Android's speech dialog returns the transcript; review or edit it, then tap **Run command**. Tasks and grocery additions work without parent mode. Calendar writes still require the household PIN. Recognition depends on an installed Android recognition service and may need an internet connection. Audio may be processed by that service.
- Tap the screen once after opening the app to enable notification audio. The bell shows household alerts, and Settings → Notifications has a chime toggle and test button. A new list or each distinct list item creates an alert (offline retries of the same item do not duplicate it).
- Grant Android notification permission for background push. Paired displays register their own FCM token; they do not need a personal login. The idle photo frame shows the latest unread household alerts. Read status is independent for each paired display. Private member alerts are not copied to the shared feed.
- Sign in → **Email code (OTP)** requests a six-digit, single-use code instead of a password. Codes expire after 15 minutes and allow five attempts. Requesting a new code invalidates the previous code; wait 30 seconds between requests. Existing password sign-in remains available.
- SES sandbox only sends to AWS-verified recipients and enforces a rolling 24-hour quota, not a midnight reset. The app spaces email sends to respect the sandbox rate. Delivery failures are reported rather than claiming the code was sent. SES acceptance does not guarantee inbox placement; check Spam. Use an owned, verified domain with DKIM/DMARC for production delivery rather than a Gmail sender address. AWS free-tier eligibility is account-specific; the SES sending quota is not itself a free billing allowance.

## Build requirements

Requirements: Node 22, pnpm, JDK 17, Android SDK (platform 35, build-tools 35).

```bash
pnpm install
cd apps/android
FAMILYHUB_URL=https://your-host npx cap sync android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

For the Play Store, create a keystore and run `./gradlew bundleRelease` with signing configured in `android/app/build.gradle`.
