import type { ReactNode } from 'react';
import { Download, Smartphone, Tablet } from 'lucide-react';

const CONTACT = 'mangalkarichand@gmail.com';
const UPDATED = 'November 1, 2026';
export const APK_URL = '/downloads/FamilyHubPro.apk';

function Doc({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background px-4 pb-16 pt-[max(2rem,env(safe-area-inset-top))]">
      <article className="mx-auto max-w-3xl">
        <a href="/" className="mb-8 inline-flex items-center gap-3 font-display text-lg font-bold">
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" /> FamilyHub Pro
        </a>
        <h1 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{title}</h1>
        {intro && <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{intro}</p>}
        <div className="mt-8 space-y-7 text-[15px] leading-relaxed [overflow-wrap:anywhere]">{children}</div>
        <nav className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t pt-6 text-sm text-muted-foreground">
          <a className="hover:text-foreground" href="/install">Install the Android app</a>
          <a className="hover:text-foreground" href="/privacy">Privacy Policy</a>
          <a className="hover:text-foreground" href="/terms">Terms of Use</a>
          <a className="hover:text-foreground" href="/login">Sign in</a>
        </nav>
      </article>
    </div>
  );
}

const S = ({ h, children }: { h: string; children: ReactNode }) => (
  <section>
    <h2 className="mb-2 font-display text-xl font-semibold">{h}</h2>
    <div className="space-y-2 text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground">{children}</div>
  </section>
);

export function PrivacyPage() {
  return (
    <Doc title="Privacy Policy" intro={'Last updated ' + UPDATED + '. This explains what FamilyHub Pro stores and how it is used.'}>
      <S h="What we store">
        <ul>
          <li><strong>Account:</strong> your name, email address, a hashed password (if you set one) and sign-in sessions.</li>
          <li><strong>Household content you add:</strong> calendars, events, tasks, chores, points, rewards, lists, meal plans, notes, announcements and photos.</li>
          <li><strong>Location:</strong> only when someone starts an SOS alert, and only while it is active. The latest position is deleted when the alert stops or expires.</li>
          <li><strong>Devices:</strong> paired home displays and notification tokens used to deliver alerts.</li>
          <li><strong>Security logs:</strong> sign-in and administrative actions, kept to protect accounts.</li>
        </ul>
      </S>
      <S h="How it is used">
        <p>Your data is used only to run FamilyHub for your household: showing it to members of your home, sending reminders, summaries and alerts, and keeping accounts secure. We do not sell your data, show ads or share it with advertisers.</p>
      </S>
      <S h="Services that process data">
        <p>FamilyHub runs on Amazon Web Services. Emails are sent with Amazon SES, and push notifications with Google Firebase. If you choose to connect them, Google Calendar, Microsoft, Amazon Alexa and WhatsApp receive only what is needed for that feature, under their own privacy terms.</p>
      </S>
      <S h="Who can see your information">
        <p>Only members and paired displays of the same home. Photos and attachments are private to that home. New accounts and new homes are reviewed and approved by the FamilyHub owner, who can see the name and email address submitted for approval.</p>
      </S>
      <S h="Children">
        <p>Children’s profiles are created and managed by a parent or guardian, who is responsible for the information added about them.</p>
      </S>
      <S h="Keeping and deleting data">
        <p>Data is kept while your account or home is in use. A home owner can remove members. To delete your account or home data, email <a className="text-primary underline" href={'mailto:' + CONTACT}>{CONTACT}</a>.</p>
      </S>
      <S h="Security">
        <p>Connections use HTTPS, passwords and tokens are stored hashed, and access is limited to each home. No system is perfectly secure, so please use a strong password and keep your devices locked.</p>
      </S>
      <S h="Changes and contact">
        <p>This policy may be updated; the date above shows the latest version. Questions: <a className="text-primary underline" href={'mailto:' + CONTACT}>{CONTACT}</a>.</p>
      </S>
    </Doc>
  );
}

export function TermsPage() {
  return (
    <Doc title="Terms of Use" intro={'Last updated ' + UPDATED + '. By creating an account or using FamilyHub Pro, you agree to these terms.'}>
      <S h="1. Use at your own risk">
        <p>FamilyHub Pro is a free personal project, provided <strong>“as is” and “as available”, without warranties of any kind</strong>, express or implied, including fitness for a particular purpose, accuracy, availability or freedom from errors. You use it entirely at your own discretion and risk.</p>
      </S>
      <S h="2. Not an emergency service">
        <p>The SOS and location features <strong>do not contact police, ambulance or any emergency service</strong>, and alerts, notifications, reminders and location updates may be delayed or not delivered. In an emergency, call your local emergency number (for example 112, 911 or 999) first.</p>
      </S>
      <S h="3. No liability">
        <p>To the fullest extent permitted by law, the owner, creator and operator of FamilyHub Pro <strong>are not liable for any loss or damage of any kind</strong> — direct, indirect, incidental, special or consequential — arising from use of, or inability to use, the service. This includes missed reminders or alerts, lost or exposed data, device or smart-home actions, injury, property damage and financial loss. Where liability cannot be excluded by law, it is limited to the smallest amount the law allows.</p>
      </S>
      <S h="4. Your responsibilities">
        <ul>
          <li>You are responsible for your account, your home, everything you and your household members add, and how you use any connected devices or services.</li>
          <li>Only add people, photos and information you have the right to share. Parents and guardians are responsible for children’s use.</li>
          <li>Do not misuse the service, try to access other homes, or use it for anything unlawful.</li>
        </ul>
        <p>You agree to indemnify and hold harmless the owner and creator from any claims arising from your use of FamilyHub Pro or from content you add.</p>
      </S>
      <S h="5. Third-party services and devices">
        <p>Features that use other companies — such as Amazon Alexa, WhatsApp, Google, Microsoft, Home Assistant, Ring, Blink or Eufy — depend on those services and their terms. The owner is not responsible for them or for any device they control.</p>
      </S>
      <S h="6. Accounts and approval">
        <p>New accounts and homes need the owner’s approval. The owner may refuse, suspend or remove any account, home or content, and may change or stop the service at any time without notice.</p>
      </S>
      <S h="7. Changes">
        <p>These terms may be updated. Continuing to use FamilyHub Pro after a change means you accept the new terms. Questions: <a className="text-primary underline" href={'mailto:' + CONTACT}>{CONTACT}</a>.</p>
      </S>
    </Doc>
  );
}

export function InstallPage() {
  return (
    <Doc title="Install FamilyHub on Android" intro="For Android phones and tablets (Android 7 or newer). The app opens your family dashboard full-screen and adds the microphone, location and notification support used by home displays.">
      <a href={APK_URL} download className="flex w-full items-center justify-center gap-3 rounded-2xl bg-primary px-6 py-4 text-lg font-semibold text-primary-foreground shadow-lift transition hover:opacity-95 sm:w-auto sm:inline-flex">
        <Download className="h-6 w-6" /> Download FamilyHub Pro (APK)
      </a>
      <S h="Install steps">
        <ol className="ml-5 list-decimal space-y-2">
          <li>Open this page on the Android phone or tablet and tap <strong>Download</strong>.</li>
          <li>Open the downloaded <strong>FamilyHubPro.apk</strong> from the notification or the Files app.</li>
          <li>If Android asks, allow <strong>Install unknown apps</strong> for your browser or Files app, then go back.</li>
          <li>Tap <strong>Install</strong>, then <strong>Open</strong>.</li>
          <li>Sign in with your email, or choose <strong>Home display</strong> to pair a shared tablet with a code from Settings → Devices.</li>
          <li>Allow <strong>notifications</strong>, <strong>microphone</strong> (voice commands) and <strong>location</strong> (only used during SOS).</li>
        </ol>
      </S>
      <S h="Updating">
        <p>Download the latest APK from this page and install it over the existing app. Your sign-in and settings stay in place.</p>
      </S>
      <S h="Tips for a kitchen or hallway tablet">
        <p className="flex gap-2"><Tablet className="mt-0.5 h-5 w-5 shrink-0" /> Keep it plugged in, pair it as a Home display, and set a parent PIN in Settings so only adults can change things.</p>
        <p className="flex gap-2"><Tablet className="mt-0.5 h-5 w-5 shrink-0" /> The app keeps the screen on and the Back button never closes it. To stop the Home and Recents buttons leaving the app, turn on Android <strong>Settings → Security → App pinning</strong>, open Recents, tap the FamilyHub icon and choose <strong>Pin</strong>. Hold Back and Recents together to unpin when you want to leave.</p>
        <p className="flex gap-2"><Smartphone className="mt-0.5 h-5 w-5 shrink-0" /> iPhone or iPad: open this site in Safari, tap Share → <strong>Add to Home Screen</strong>.</p>
      </S>
    </Doc>
  );
}

const PAGES: Record<string, () => JSX.Element> = { '/privacy': PrivacyPage, '/terms': TermsPage, '/install': InstallPage };
export const publicPage = (pathname: string) => PAGES[pathname.replace(/\/$/, '')] ?? null;
