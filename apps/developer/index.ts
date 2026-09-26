// Order matters: the CSPRNG polyfill must be installed before any crypto code runs,
// and the crash guard before the app starts.
import '../../packages/app-kit/src/polyfills';
import '../../packages/app-kit/src/crash-guard';

import 'expo-router/entry';
