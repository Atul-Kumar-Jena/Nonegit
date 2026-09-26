// Order matters: the CSPRNG polyfill must be installed before any crypto code runs,
// and the crash guard before the app starts.
import '../../packages/app-kit/src/polyfills';
import '../../packages/app-kit/src/crash-guard';
import { initPhoneNotifications } from '../../packages/app-kit/src/lib/notifications';

// Background notification checks must be defined at startup, before any screen.
initPhoneNotifications();

import 'expo-router/entry';
