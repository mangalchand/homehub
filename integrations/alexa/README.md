# FamilyHub Alexa skill

A custom skill ("Alexa, open family hub") hosted by the FamilyHub API. Each Alexa account is linked to one FamilyHub member in one home and acts with that member's permissions.

## One-time setup (Alexa developer console, https://developer.amazon.com/alexa/console/ask)

1. **Create skill**: name `FamilyHub`, model **Custom**, hosting **Provision your own**, template **Start from scratch**.
2. **Interaction model -> JSON Editor**: paste `interaction-model.json`, Save, Build.
3. **Endpoint**: HTTPS, Default region `https://<your-host>/api/v1/alexa/skill`, certificate option "My development endpoint has a certificate from a trusted certificate authority".
4. **Account linking**: Auth Code Grant.
   - Web Authorization URI: `https://<your-host>/alexa/link`
   - Access Token URI: `https://<your-host>/api/v1/alexa/token`
   - Client ID / Secret: generate your own random values
   - Authentication scheme: HTTP Basic. Scope: `household`. PKCE optional.
5. Server config: `ALEXA_CLIENT_ID`, `ALEXA_CLIENT_SECRET` (secret), and `ALEXA_SKILL_ID` (the skill ID, `amzn1.ask.skill...`). Redeploy.
6. **Test** tab: enable Development. In the Alexa app on the same Amazon account: More -> Skills & Games -> Your Skills -> Dev -> FamilyHub -> Enable, then sign in to FamilyHub and choose the home.

Development skills work on every Echo signed in to the developer's Amazon account without certification.

## Commands

- "Alexa, ask family hub to add milk and eggs to the grocery list"
- "Alexa, ask family hub to add a task to call the plumber" (parents)
- "Alexa, ask family hub what's on today" / "what's happening tomorrow"
- "Alexa, ask family hub for the daily summary" / "what's left to do"
- "Alexa, ask family hub how many points do we have"
- "Alexa, ask family hub to read my notifications"

Every request is checked for Amazon's signature (Signature-256 and the certificate chain) and timestamp. Linking stores only token hashes. Removing a member from the home, or unlinking in Settings -> Alexa, stops access immediately.
