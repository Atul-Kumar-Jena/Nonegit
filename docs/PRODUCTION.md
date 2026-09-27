# Attendly in production — the real thing, not the demo

The code is the same for demo and production; what changes is **how the server is set up** and
**how the apps are signed**. Do these once, in order. You never paste a password or key into a
chat: they go only into Render → Environment or GitHub → Secrets.

When you're done, the **Developer app → Console → Production checklist** shows 6/6 ✓.

| # | What | Why | Cost |
|---|---|---|---|
| 1 | Render **Starter** plan | the free server sleeps after 15 min; first request then takes ~1 min | ~$7/month |
| 2 | **Email** for sign-in codes (Brevo) | real people get their code by email | free (300/day) |
| 3 | **Demo off**, `/dev` off, only real phones | nobody can sign in without a code; no testing back doors | — |
| 4 | **Firebase** push | notifications arrive instantly, even with the app closed | free |
| 5 | Your own **signing key** | only you can publish updates; Play Store `.aab` files | free |
| 6 | **Supabase** Pro (recommended) | daily backups, no pausing | ~$25/month |

---

## 0 · Sign-up with Google Authenticator (no email needed)
Nobody needs email to get in. Each person links **Google Authenticator** once with a one-time
**setup code**, then signs in with their ID and the authenticator's 6-digit code.

1. **You (developer), once:** Render → **Logs** → find `Attendly Developer first-time setup → sign-in ID developer@attendly.app · setup code ABCD-EFGH-JKMN`.
   Attendly Developer → **First-time setup** → that ID and code → **Open Google Authenticator** (adds "Attendly") → type its code → **Bind this device**.
   After that: open the app, type the Google Authenticator code. (A new setup code is printed at every restart until you've done this; it's valid 24 h.)
   Want another ID? Set `DEVELOPER_SIGN_IN_ID` in Render → Environment. Lost the phone? Set `DEVELOPER_AUTHENTICATOR_RESET=true`, restart, set up again from the log, then delete the setting.
2. **Each institution — only the Developer app creates them:** Institutions → **New** → name, main admin's name and email (their sign-in ID; nothing is emailed) → **Create** → **Verify institution** → **Share instructions** (institution code + the main admin's setup code, shown once). Lost phone: **New setup code for the main admin**.
3. **The main admin:** Attendly Institute → institution code → **First time? Sign in with a setup code** → ID + code → Google Authenticator → bind. The main admin is the only one who adds, promotes or removes **admins**.
4. **Everyone else:** an admin adds professors (and gives them extra powers — "sudo" professors — under Role & permissions); a new professor/admin gets a setup code on the spot (**Share instructions**). Students: People → the student → **Create setup code** (or batches, as before).

## 1 · Always-on server (Render)
Render → your service (**attendly-api-bt9r**) → **Settings → Instance type → Starter** → Save.

## 2 · Sign-in emails (Brevo, free)
1. Sign up at <https://www.brevo.com> (free plan).
2. **Senders, domains & dedicated IPs → Senders → Add a sender**: name `Attendly`, your email (Gmail is fine) → verify it from the email Brevo sends you.
3. **SMTP & API → API keys → Generate a new API key** → copy it (it's shown once).
4. Render → your service → **Environment** → add / change:
   - `OTP_DELIVERY` = `brevo`
   - `EMAIL_API_KEY` = the key from step 3
   - `SMTP_FROM` = `Attendly <the-email-you-verified@gmail.com>`
   → **Save**. Render restarts the server by itself (about a minute).
5. Test: Attendly Institute → your institution code → your admin email → **Send OTP** → the code arrives in your inbox (check Spam the first time and mark it "Not spam").

(Resend works too: `OTP_DELIVERY=resend`, its API key, and a sender on a domain you verified there. Plain SMTP: `OTP_DELIVERY=smtp` + `SMTP_URL`.)
Tip: people can also use **Google Authenticator** instead of emailed codes (More / Profile → Sign-in security).

## 3 · Switch off demo and testing
Render → **Environment**:
- `DEMO_INSTANT_LOGIN` = `false`; `SEED_DEMO` = `false` (setting up email already turns demo sign-in off; these make it explicit).
- **Delete** `DEV_TOOLS_TOKEN` (turns off the `/dev` page).
- **Delete** `ALLOW_WEB_CLIENTS` and `ALLOW_EMULATORS` if they exist (only real phones can sign in).
- Optional: Developer app → Institutions → *Demo Institute of Technology* → **Suspend** (its accounts can't sign in any more; nothing is deleted).

Your institution's code is still in Render → **Logs** (`institution code for "…"`), the Developer app, and Institute app → More.

## 4 · Instant notifications (Firebase)
Follow [USER-GUIDE §5](USER-GUIDE.md#5--notifications). Then, on every phone, tap the **"Get notifications on time"** card on Home (or Permissions → *Battery: don't optimise*) and choose **Allow**; on Xiaomi / Oppo / Vivo / Realme / OnePlus also allow **Autostart** in App info.

## 5 · Your own signing key
Right now the APKs are signed with Android's public *debug* key: fine for testing, but anyone could build an "update" with it. Make your own key once:

1. GitHub → this repository → **Settings → Secrets and variables → Actions → New repository secret**:
   name `SIGNING_KEY_ZIP_PASSWORD`, value: a long password only you know (12+ characters). *(This repository is public, so the key is only ever delivered inside a zip locked with this password.)*
2. **Actions → Create Android signing key** → open its latest run → **Re-run all jobs**. When it's green, download **attendly-signing-key-ENCRYPTED** at the bottom of the run and open the zip with your password (7-Zip, WinRAR, or a phone file manager that supports AES zips).
3. Add four more repository secrets; each **name** is a file name without `.txt`, each **value** is that file's content:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
4. Keep `attendly-release.jks` and its password (in `ANDROID_KEYSTORE_PASSWORD.txt`) **safe and private** — Google Drive + a password manager. Lose it and you can never update these apps for existing users.
5. Delete that workflow run (**… → Delete workflow run**).
6. The next build (any push) is signed with your key and also produces `attendly-*.aab` files for the Play Store. The CI log prints the certificate's SHA-256.
7. Phones with a test build must **uninstall it once** and install the release-signed APK (Android refuses an update signed with a different key). Sign-in again afterwards; attendance history is on the server, nothing is lost.

**Play Store** (optional): Google Play Console (one-time $25) → create each app (`app.attendly.student`, `app.attendly.institute`) → upload the `.aab` → turn on *Play App Signing*. Google reviews the "ignore battery optimisation" permission: if they object, remove `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` from `apps/*/app.json` (the app then opens the battery settings list instead).

## 6 · Database (Supabase)
- **Pro plan** (recommended for real data): daily backups kept 7 days, and the project never pauses. (Free projects pause after a week without traffic and have no downloadable backups.)
- Keep the database password only in Render's `DATABASE_URL`. If it ever leaks: Supabase → Project settings → Database → **Reset password**, then update `DATABASE_URL` in Render.

## 7 · Phone binding with the security chip (Android)
Every Android phone now creates its key **inside its security chip** (TEE / StrongBox). Google signs a certificate that proves where the key is, that the phone isn't rooted or bootloader-unlocked, and that the key belongs to the official Attendly app. The server checks all of this against Google's root certificates and its list of revoked keys (refreshed every 6 hours). Every scan must then carry the chip's signature, so copying the app's data to another phone gets nothing.
- **Always on:** a phone that Google proves is rooted or unlocked, or that runs a copied app, is refused.
- **Stricter, per institution:** Developer app → Institutions → Flags → **Secure-hardware phones only**. Then phones without a working chip can't be bound at all. Turn it on once a few real phones have bound fine.
- **Stricter, for every institution:** Render env `REQUIRE_HARDWARE_KEYS=true`.
- **Only your signed APK:** Render env `ANDROID_APP_CERT_SHA256` = the SHA-256 of your release key's certificate (from `keytool -list -v -keystore attendly-release.jks`, "SHA256:"). Don't set it while testing debug-signed builds.
- **Emergency:** if a phone model is wrongly refused, Developer app → Console → switch **Relax phone hardware checks** on, and tell us the model.
- Phones bound before this update move their key into the chip by themselves the next time the app opens online.

## 8 · Classes, alerts and notifications
- Classes **go live by themselves** at their start time (the professor gets “▶ CS-301 is live now”) and close 15 minutes after they end. A QR class needs its room’s location saved (Rooms → Use my location); otherwise its professor starts it from their phone.
- When the QR is on screen (phone or big screen), students see **“Attendance being taken — scan now”** and get one notification.
- Phone requests go to each batch’s **mentor** (Batches → a batch → Settings → Mentor); batches without one go to the admins.
- Push notifications carry a thumbnail. On Render this works by itself; elsewhere set `PUBLIC_URL` to the server’s https address.
- Optional: Developer app → Institutions → Flags → **Refuse offline scans** (campuses with reliable internet).

## 9 · Go-live check
1. Developer app → **Console → Production checklist**: 6/6 ✓.
2. Developer app → **Institutions** → each real institution shows **✓ Verified**; share its code with its admin.
3. A real professor and a real student sign in with emailed codes, run a class, scan, download a report.

## Good to know
- **This GitHub repository is public**: anyone can read the code (not your secrets or data). For a business you may want it private (Settings → General → Change visibility); then the public download links for the APKs stop working and you share APKs another way (Play Store, Drive).
- Updates: push → CI builds signed APKs → install over the old ones (same key → data kept).
- Monitoring: Render → **Logs / Metrics**; the Developer app shows live health, errors and the audit log.
