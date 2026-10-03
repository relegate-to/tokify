import { SafeAreaView as RNSafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

// Uniwind styles React Native's own components; third-party ones need wrapping
// before className reaches them.
export const SafeAreaView = withUniwind(RNSafeAreaView);
