#!/bin/bash
ps -eo pid,args | awk '$2=="node" && $3=="dist/server.cjs" {print $1}' | xargs -r kill
psql -U postgres -h localhost -q -c "drop database if exists attendly_e2e" -c "create database attendly_e2e" >/dev/null 2>&1
cd "$(dirname "$0")/../server"
read SK TP DT < /tmp/e2ekeys
env NODE_ENV=production PORT=10000 DATABASE_URL=postgres://postgres@localhost:5432/attendly_e2e SERVER_SIGNING_KEY=$SK TOKEN_PEPPER=$TP OTP_DELIVERY=console SMS_DELIVERY=disabled DEV_TOOLS_TOKEN=$DT ALLOW_WEB_CLIENTS=true ALLOW_EMULATORS=true CORS_ORIGINS=http://localhost:8081,http://localhost:8082 BOOTSTRAP_INSTITUTION_NAME="Green Valley College" BOOTSTRAP_ADMIN_EMAIL=principal@greenvalley.edu BOOTSTRAP_ADMIN_NAME="Dr. Anita Rao" setsid nohup node dist/server.cjs > /tmp/server-e2e.log 2>&1 < /dev/null &
until curl -s -m 1 localhost:10000/v1/meta >/dev/null; do sleep 0.3; done
echo server-ready
if ! curl -s -m 1 -o /dev/null localhost:8082/; then
  (cd "$(dirname "$0")" && setsid nohup node static.cjs > /tmp/static2.log 2>&1 < /dev/null &)
  until curl -s -m 1 -o /dev/null localhost:8082/; do sleep 0.3; done
  echo static-ready
fi
