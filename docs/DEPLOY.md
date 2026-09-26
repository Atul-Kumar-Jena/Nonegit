# Deploying Attendly (Supabase database + Render server)

About 15 minutes. You need: a Supabase account (you have the org **Attendly**), a Render account, and this GitHub repo.

## 1. Supabase — the database

1. **supabase.com → your org "Attendly" → New project.**
   Name `attendly`, choose a strong **database password** (save it in a password manager), region **Mumbai (ap-south-1)** or the one closest to your college. Create.
2. When the project is ready, click **Connect** (top of the dashboard) → **Connection string** → choose **Session pooler**.
   Copy the URI. It looks like:
   `postgresql://postgres.abcdxyz:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
   Replace `[YOUR-PASSWORD]` with your database password. If the password contains `@ : / ? #`, write it URL-encoded (`@` → `%40`).
   *Use the Session pooler, not "Direct connection": Render's free servers can't reach IPv6-only addresses.*
3. *(Recommended, for full certificate checking)* **Project Settings → Database → SSL Configuration → Download certificate.** Open the downloaded `.crt` file in a text editor and copy all of it, including the `-----BEGIN CERTIFICATE-----` lines.

**Never paste the password or connection string into a chat, an issue or the code.** It only goes into Render's environment settings.

## 2. Render — the server

1. **render.com → New → Blueprint** → connect GitHub → pick **atul-kumar-jena/nonegit** and branch `claude/three-secure-synced-apps-42sdud` → Render reads `render.yaml`.
2. Render asks for these values:

| Setting | What to enter |
|---|---|
| `DATABASE_URL` | the Session pooler URI from step 1.2 |
| `DATABASE_SSL_CA` | the certificate text from step 1.3 (or leave empty: still encrypted, just without certificate checking) |
| `BOOTSTRAP_INSTITUTION_NAME` | your institution, e.g. `Green Valley College` |
| `BOOTSTRAP_ADMIN_EMAIL` | **your** email — you become the first admin |
| `BOOTSTRAP_ADMIN_NAME` | your name |
| `BOOTSTRAP_DEMO_TEACHER_EMAIL` | optional: a second email of yours to try the teacher role |
| `BOOTSTRAP_DEMO_STUDENT_EMAIL` | optional: a third email of yours to try the student role |
| `SMTP_URL`, `SMTP_FROM` | leave empty for now (see §4) |

3. **Apply.** The first deploy takes 5–8 minutes. When the service shows **Live**, copy its address, e.g. `https://attendly-api-x1y2.onrender.com`.
4. Check it: open `https://attendly-api-x1y2.onrender.com/v1/meta` in a browser. You should see `{"name":"Attendly",…}`.

The database tables are created automatically on first start, and the institution and accounts from step 2 are created once (restarting is safe).

## 3. Sign-in codes while testing

Until email is set up (`OTP_DELIVERY=console`), one-time codes are shown on a private web page:

1. Render → your service → **Environment** → copy the value of `DEV_TOOLS_TOKEN`.
2. Open `https://attendly-api-x1y2.onrender.com/dev?token=<that value>` on a laptop. Codes appear there a second after anyone taps "Send OTP".

Keep that link private: anyone with it can read sign-in codes.

## 4. Going live (real users)

- **Email codes.** Get SMTP details from any provider (Gmail with an App Password, Zoho, Brevo, SES…), then in Render → Environment:
  `OTP_DELIVERY=smtp`,
  `SMTP_URL=smtps://user%40domain.com:APP_PASSWORD@smtp.gmail.com:465`,
  `SMTP_FROM=Attendly <attendance@your-college.edu>`.
  Then **delete `DEV_TOOLS_TOKEN`** and redeploy.
- **Always-on server.** Render's free plan sleeps after 15 minutes idle; the first request then takes about 50 seconds (the apps wait for it). For real classes use the Starter plan.
- **Pin the server into the apps (strongest).** GitHub → repo **Settings → Secrets and variables → Actions → Variables**: set `ATTENDLY_API_URL` = your Render address, and `ATTENDLY_SERVER_KEY` = the `serverKey.publicKey` value from `/v1/meta`. The next APK build is pre-configured and refuses any other server.

## 5. Getting the apps

Every push builds both Android apps on GitHub Actions. They are always at:

- Student: `https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-student.apk`
- Institute: `https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-institute.apk`

Open the link on the phone → download → tap it → allow "Install unknown apps" for your browser → Install. On first launch, paste your Render address (unless it was pinned in §4).
