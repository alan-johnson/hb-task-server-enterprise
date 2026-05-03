# Go-To-Market: API Production Requirements

## Google Tasks API & Microsoft Tasks API

Both APIs require an **app publishing/verification process** before real users can authenticate in production.

---

## Google Tasks API

Your OAuth app starts in **Testing** mode, which:
- Limits you to 100 explicitly added test users
- Shows users a scary "unverified app" warning screen

**Before production:**
1. **Publish the OAuth app** — in Google Cloud Console, go to "OAuth consent screen" and click "Publish App" to move from Testing → In production
2. **Submit for verification** — Google Tasks uses sensitive scopes (`auth/tasks`), which requires Google's OAuth verification review. You submit via the consent screen and Google reviews your app, privacy policy, and domain ownership. This can take **several weeks**.
3. Without verification, external users see an interstitial warning and must click through to proceed.

---

## Microsoft Tasks API (Graph API / To Do)

Your app registration in Azure Entra ID (formerly Azure AD) starts as unverified.

**Before production:**
1. **Admin consent** — if you request application permissions (not just delegated), a tenant admin must grant consent. For delegated permissions, users consent individually.
2. **Publisher verification** — verify your Microsoft Partner Network (MPN) account and link it to your app registration. This adds a verified badge and removes the "unverified publisher" warning users see during OAuth.
3. Configure your app registration's redirect URIs and branding for production endpoints.

---

## Summary

| Step | Google | Microsoft |
|------|--------|-----------|
| App state change | Testing → Production (consent screen) | No equivalent gate, but publisher verification needed |
| Verification process | OAuth app review (weeks) | MPN publisher verification |
| Scope sensitivity | Tasks scopes require review | Delegated permissions = user consent; app permissions = admin consent |
| User warning without it | "Unverified app" interstitial | "Unverified publisher" warning |

> **Note:** The Google process is the more significant gate — budget time for the review before your launch date.
