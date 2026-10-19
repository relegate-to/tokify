import { createContext, useContext } from 'react';

// Whether time fields offer hour and minute columns as well as typing.
// Provided once by App so every time field follows the setting.
export const TimePickerContext = createContext(true);

export function useTimePicker(): boolean {
    return useContext(TimePickerContext);
}
