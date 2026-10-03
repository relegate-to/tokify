import { TextInput, type TextInputProps } from 'react-native';

import { cn } from '@/lib/utils';

function Input({ className, ...props }: TextInputProps & { className?: string }) {
    return (
        <TextInput
            className={cn(
                'h-12 rounded-lg border border-input bg-card px-3.5 font-sans text-base text-foreground placeholder:text-muted-foreground',
                props.editable === false && 'opacity-50',
                className,
            )}
            {...props}
        />
    );
}

export { Input };
