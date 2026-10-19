import { requireOptionalNativeModule } from 'expo';

type TokifyTimerNotification = {
    // Posts or replaces the ongoing notification; Android counts up from startMs itself.
    show(title: string, text: string, startMs: number): void;
    hide(): void;
};

// Android only; null elsewhere.
export default requireOptionalNativeModule<TokifyTimerNotification>('TokifyTimerNotification');
