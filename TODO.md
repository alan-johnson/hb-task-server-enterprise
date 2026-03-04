# To Do items

## Going Live

Microsoft "Unverified" — Now Matters
Paying customers seeing "unverified" on the Microsoft consent screen is a trust problem. You should pursue publisher verification. It also means:

Your Entra ID app registration should be multi-tenant (so any Microsoft account can connect, not just your own tenant)
You'll need a privacy policy URL and terms of service URL — Microsoft requires these for public-facing apps under Branding & properties in the app registration
Google — Same Requirement
Google also shows an "unverified app" warning for apps that haven't gone through Google's OAuth verification process. For a commercial product you'll need to submit for verification at Google API Console → OAuth consent screen → Publish & verify.

### Other Things That Change


| Area	| What's needed
|---|---|
| Privacy policy	| Required by Microsoft, Google, and most jurisdictions (GDPR, CCPA)
| Terms of service	| Required for paid subscriptions
| Token storage	Already encrypted at rest (AES-256-GCM) | - good
| Data residency	| Where Postgres is hosted matters for GDPR if you have EU customers
| Redis security	| README already notes tokens are decrypted in Redis — needs auth + TLS in production
| HTTPS	| OAuth providers require HTTPS redirect URIs for production (not http://localhost)

The most immediate blocker is HTTPS and a real domain — neither Microsoft nor Google will allow http://localhost redirect URIs for a published app. Everything else can follow, but that's the prerequisite for going live.

## Privacy and Terms of Agreement

New pages (accessible at clean URLs once deployed):

https://[yourdomain]/privacy — Privacy Policy
https://[yourdomain]/terms — Terms of Service
Before publishing, fill in the highlighted placeholders in both files:

| Placeholder	| What to fill in
|----|----|
| [EFFECTIVE DATE]	| Date you publish
| [YOUR DOMAIN]	| e.g. tasks.handsbreadth.com
| [HOSTING PROVIDER / REGION]	| e.g. AWS us-east-1
| [YOUR EMAIL]	| Support/legal contact email
| [YOUR ADDRESS]	| Business address
| [YOUR STATE / COUNTRY]	| Governing law jurisdiction
| [YOUR CITY, STATE]	| Arbitration venue
| [LOG RETENTION PERIOD]	| e.g. 30 days
| [YOUR PRICING PAGE URL]	| Link to your pricing page
| [monthly / annually]	| Your billing cycle

### Where to submit the URLs:

Microsoft: Azure Portal → your app registration → Branding & properties → Privacy statement URL + Terms of service URL
Google: Google Cloud Console → OAuth consent screen → Privacy Policy URL + Terms of Service URL
These documents are a solid starting point but are not a substitute for legal advice. For a commercial subscription service, have a lawyer review them before publishing.

## Testing

### get all lists

```
fetch('/api/lists?provider=microsoft', {
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
})
.then(r => r.json())
.then(data => data.lists.forEach(l => console.log(l.id, l.name)))
```