import type { CapacitorConfig } from '@capacitor/cli';

// The Android app is a thin, full-screen shell around the hosted FamilyHub web app, so
// sessions stay first-party and every device gets updates without reinstalling.
const url = process.env.FAMILYHUB_URL ?? 'https://44-198-103-49.sslip.io';

const config: CapacitorConfig = {
  appId: 'com.familyhub.pro',
  appName: 'FamilyHub Pro',
  webDir: 'www',
  server: { url, cleartext: false, androidScheme: 'https' },
  android: { allowMixedContent: false, backgroundColor: '#f5f6fb' },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, backgroundColor: '#5b3df5', showSpinner: false },
    StatusBar: { overlaysWebView: false, style: 'LIGHT', backgroundColor: '#5b3df5' },
  },
};

export default config;
