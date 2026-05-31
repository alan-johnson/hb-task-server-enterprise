# Go-To-Market: API Production Requirements

## Google Tasks API & Microsoft Tasks API

Both APIs require an **app publishing/verification process** before real users can authenticate in production.

---

## Google Tasks API

~~Your OAuth app starts in **Testing** mode, which:~~
~~- Limits you to 100 explicitly added test users~~
~~- Shows users a scary "unverified app" warning screen~~

**Before production:**
1. ~~**Publish the OAuth app**~~ ✅ **Done** — app is now **In production**
~~2. **Submit for verification** — Google Tasks uses sensitive scopes (`auth/tasks`), which requires Google's OAuth verification review. This can take **several weeks**.~~ ✅ **Done**
   - ~~**2a. Prepare a privacy policy** — must be publicly accessible at a URL on your domain (e.g. `https://handsbreadth.com/privacy`)~~
     - [Google's guidance on privacy policy requirements](https://support.google.com/cloud/answer/9110914)
~~    - **2b. Verify domain ownership** — prove you own `handsbreadth.com` in Google Search Console ~~
     - [Google Search Console](https://search.google.com/search-console)
   - ~~**2c. Open the OAuth consent screen** in Google Cloud Console and click "Prepare for verification"~~
     - [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   - ~~**2d. Fill out the verification form** — provide app homepage, privacy policy URL, and justification for each sensitive scope (`auth/tasks`)~~
     - [OAuth app verification FAQ](https://support.google.com/cloud/answer/9110914)
   - ~~**2e. Submit** — Google will email updates; review typically takes 2–6 weeks~~
~~3. Without verification, external users see an interstitial warning and must click through to proceed.~~ ✅ **Resolved** — verification approved

---

## Microsoft Tasks API (Graph API / To Do)

Your app registration in Azure Entra ID (formerly Azure AD) starts as unverified.

**Before production:**
1. **Admin consent** — if you request application permissions (not just delegated), a tenant admin must grant consent. For delegated permissions, users consent individually.
2. **Publisher verification** — verify your Microsoft Partner Network (MPN) account and link it to your app registration. This adds a verified badge and removes the "unverified publisher" warning users see during OAuth.
   - **2a. Enroll in Microsoft AI Cloud Partner Program (formerly MPN)** — create or sign in to a Partner Center account
     - [Microsoft Partner Center](https://partner.microsoft.com/en-us/dashboard/account/v3/enrollment/introduction/azureactivedirectory)
   - **2b. Get a verified MPN ID** — Partner Center will issue a Partner ID (MPN ID) once enrollment is complete
     - [Partner Center overview](https://partner.microsoft.com/en-us/dashboard/home)
   - **2c. Link your MPN account to your Azure tenant** — in Partner Center, go to Settings → Account settings → Identifiers and associate your Entra tenant
     - [Linking guidance](https://learn.microsoft.com/en-us/partner-center/account-settings/connect-with-an-indirect-provider)
   - **2d. Start publisher verification in the Azure portal** — open the app registration and click "Add a verified publisher"
     - [Azure Portal → App Registration → Branding & properties](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) (find app `9fdb061f-087c-43e2-803a-b5157be7ed8a` → Branding & properties)
   - **2e. Enter your MPN ID** — Azure will validate it against Partner Center and add the verified badge
     - [Publisher verification docs](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)
     - [Step-by-step walkthrough](https://learn.microsoft.com/en-us/entra/identity-platform/mark-app-as-publisher-verified)
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
