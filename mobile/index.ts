// The background push task must be defined before the router renders, so it
// is registered here and expo-router's entry follows.
import './src/polyfills';
import './src/sync/background';
import 'expo-router/entry';
