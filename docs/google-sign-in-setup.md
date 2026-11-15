# Google sign-in for organizers: setup

Organizers (only) can sign in or sign up with Google. The button is on the **Organizer Sign In** and **Create your account** pages.
The browser gets a signed ID token from Google; the server verifies it against the client id(s) in `GOOGLE_CLIENT_ID` and trusts only a
Google-verified email address. Administrators and system users cannot use it (they are refused with a clear message).

## 1. Google Cloud (one time)

1. Open <https://console.cloud.google.com/> and create a project (for example **LGPSM**), or pick the one you already use.
2. **APIs & Services > OAuth consent screen**
   - User type **External**, app name **LGPSM**, a support email and a developer contact email.
   - Authorized domains: the domain of the web app (for example `yourdomain.com`; a `*.vercel.app` or `*.onrender.com` host cannot be added as a domain, leave it blank while testing).
   - Scopes: only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile` (no sensitive scopes, so no Google review is needed).
   - While the app is in **Testing**, only the test users you add can sign in. Press **Publish app** when you are ready for everyone.
3. **APIs & Services > Credentials > Create credentials > OAuth client ID**
   - Application type **Web application**, name `LGPSM web`.
   - **Authorized JavaScript origins** (no paths, no trailing slash): `http://localhost:3000` and the real web address, for example `https://your-web-app.vercel.app`.
   - **Authorized redirect URIs**: none are needed for the Google button.
   - Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). The client secret is not used.

## 2. Settings

| Where | Name | Value |
|---|---|---|
| Backend (Render environment, and the local `.env`) | `GOOGLE_CLIENT_ID` | the Client ID. Several ids may be given, comma-separated (the web one now; an Android one later). |
| Web app (Vercel environment, and the local `.env.local`) | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | the same Client ID |

Redeploy both after setting them. Until `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is set the page shows a plain "Sign in with Google" button that
says Google sign-in is not set up yet; until `GOOGLE_CLIENT_ID` is set the server answers 503 `GOOGLE_NOT_CONFIGURED`.

## 3. Checking it

1. Open the Organizer Sign In page: Google's button shows. Sign in with a Google account that has no LGPSM account: you land on the dashboard and a **Complete your profile** window (with a percentage) opens; it closes only when the individual/organization choice, the name, the organization name (for organizations) and the phone number are filled in.
2. Sign out and use the button again: you are signed in without the window.
3. With an organizer who already exists on that email: the button signs them in (and links the Google account).
4. With an administrator's email: "Google sign-in is for organizers only."

## 4. The mobile app (later)

The Android app needs its own **Android** OAuth client in the same project: package name `com.lgpsm.mobile` and the SHA-1 fingerprint of the key
the APK is signed with (the current debug-signed builds: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`; read it with `apksigner verify --print-certs`; a Play Store
release needs the Play App Signing SHA-1 as well). Its id is added to `GOOGLE_CLIENT_ID` (comma-separated) once the app supports the button.

## Notes

- An organizer who signed up with Google has no password. If they want one, **Forgot password** sets it.
- A Google account that is already linked to an organizer cannot be replaced by a different Google account on the same address.
- Signing up with the form while a code is pending never says the address is "already registered": the pending sign-up is replaced. A
  clash with a real organizer account is only reported after a correct code has been entered.
