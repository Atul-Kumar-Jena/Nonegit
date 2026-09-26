# Two-app browser rehearsal (29 steps)

Drives the **web builds** of both apps against a **production-mode server** with an empty database:
admin onboarding → teacher QR class + big screen + register → both phones offline → reports →
drag-and-drop planner publish → student notified. QR codes are decoded from screen *pixels*.

```bash
# once
cd e2e && npm install            # jsqr + pngjs; Playwright comes from the machine (NODE_PATH)
# keys for the throwaway server: "<signing b64> <pepper b64> <dev-token hex>" in /tmp/e2ekeys, token in /tmp/devtoken
node -e "const c=require('crypto');console.log(c.randomBytes(32).toString('base64')+' '+c.randomBytes(32).toString('base64')+' '+c.randomBytes(24).toString('hex'))" > /tmp/e2ekeys
awk '{print $3}' /tmp/e2ekeys > /tmp/devtoken

# each run
npm run build -w server
(cd apps/institute && EXPO_PUBLIC_ALLOW_HTTP=1 npx expo export --platform web --output-dir /tmp/web-institute)
(cd apps/student   && EXPO_PUBLIC_ALLOW_HTTP=1 npx expo export --platform web --output-dir /tmp/web-student)
bash e2e/reset-server.sh          # fresh DB "attendly_e2e", server on :10000, static apps on :8081/:8082
NODE_PATH=$(npm root -g) OUT=/tmp/shots node e2e/both.cjs
```

Needs PostgreSQL on localhost (user `postgres`) and Chromium at `/opt/pw-browsers/chromium-1194` (edit `executablePath` otherwise).
Screenshots of every step land in `$OUT`.
