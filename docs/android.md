# Android app (APK) and wall-tablet setup

The Android app (`apps/android`, Capacitor) is a full-screen shell around the hosted FamilyHub web app. Because it loads the live site, every tablet and phone picks up new features as soon as the server is updated — no reinstall needed. It keeps the screen awake for wall displays.

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

Requirements: Node 22, pnpm, JDK 17, Android SDK (platform 35, build-tools 35).

```bash
pnpm install
cd apps/android
FAMILYHUB_URL=https://your-host npx cap sync android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

For the Play Store, create a keystore and run `./gradlew bundleRelease` with signing configured in `android/app/build.gradle`.
