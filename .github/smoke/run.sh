#!/bin/bash
# Runs inside the emulator job. For each app: install, open, wait, then report
# whether it is still running, any crash / JS error in the log, and the text on screen.
set +e
OUT=smoke-out; mkdir -p $OUT
PY=$(command -v python3)

screen_text() { # $1 = file prefix
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml $OUT/$1.xml >/dev/null 2>&1
  adb exec-out screencap -p > $OUT/$1.png 2>/dev/null
  $PY - $OUT/$1.xml <<'P'
import re,sys
try: x=open(sys.argv[1],encoding='utf-8').read()
except Exception: print("   (no UI dump)"); sys.exit()
seen=[]
for t,d in re.findall(r'text="([^"]*)"[^>]*content-desc="([^"]*)"',x):
  for s in (t,d):
    s=s.strip()
    if s and s not in seen: seen.append(s)
print("   SCREEN: "+" | ".join(seen)[:1500])
P
}

tap_text() { # $1 = prefix of the xml, $2 = regex to find in text or content-desc
  $PY - $OUT/$1.xml "$2" <<'P' | while read x y; do echo "   tap '$2' at $x,$y"; adb shell input tap $x $y; done
import re,sys
x=open(sys.argv[1],encoding='utf-8').read()
for n in re.findall(r'<node [^>]*>',x):
  t=re.search(r'text="([^"]*)"',n).group(1)+" "+re.search(r'content-desc="([^"]*)"',n).group(1)
  if re.search(sys.argv[2],t):
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',n)
    if b:
      a,c,d,e=map(int,b.groups()); print((a+d)//2,(c+e)//2); break
P
}

report() { # $1 = package, $2 = label
  local pid; pid=$(adb shell pidof $1)
  if [ -n "$pid" ]; then echo "   RUNNING (pid $pid)"; else echo "   NOT RUNNING — crashed or closed"; fi
  adb logcat -d > $OUT/$2-logcat.txt
  echo "   --- crash / JS errors ---"
  grep -E "FATAL EXCEPTION|AndroidRuntime|ReactNativeJS|E ReactNative|Error:|attendly\]|libc.*Fatal|SIGSEGV|SIGABRT|DEBUG   :" $OUT/$2-logcat.txt | grep -v "^.*W ReactNativeJS" | head -80
}

for app in student institute developer; do
  PKG=app.attendly.$app
  echo "=================== $app ==================="
  adb install -r -g $app.apk 2>&1 | tail -1
  adb logcat -c
  adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 45
  echo "-- after open"; report $PKG $app-1; screen_text $app-1
  if [ $app = student ]; then
    # Demo sign-in: tap the demo student, then bind this phone, then look at the home screen.
    tap_text $app-1 "Aarav"; sleep 25
    echo "-- after demo sign-in"; report $PKG $app-2; screen_text $app-2
    tap_text $app-2 "Bind this"; sleep 30
    echo "-- after binding"; report $PKG $app-3; screen_text $app-3
    tap_text $app-3 "Later|Done|Not now|Skip"; sleep 10
    echo "-- after permissions"; report $PKG $app-4; screen_text $app-4
    # Close and reopen: the signed-in start-up path.
    adb shell am force-stop $PKG; adb logcat -c
    adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 30
    echo "-- reopened while signed in"; report $PKG $app-5; screen_text $app-5
  fi
  if [ $app = developer ]; then
    tap_text $app-1 "[Dd]emo|Open console|Continue"; sleep 25
    echo "-- after demo / continue"; report $PKG $app-2; screen_text $app-2
  fi
done
exit 0
