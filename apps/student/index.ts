// Order matters: the CSPRNG polyfill must be installed before any crypto code runs.
import './src/polyfills';
import 'expo-router/entry';
