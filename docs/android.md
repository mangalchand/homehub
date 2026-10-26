# Android app (APK) and wall-tablet setup

The Android app (`apps/android`, Capacitor) is a full-screen shell around the hosted FamilyHub web app. Web changes arrive from the server; native plugin or permission changes require installing a new APK. It keeps the screen awake for wall displays.

Production URL baked into the APK: `https://44-198-103-49.sslip.io` (override with `FAMILYHUB_URL` at build time).

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
