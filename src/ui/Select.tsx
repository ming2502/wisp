import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  id?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** `md` matches the dialog text fields, `sm` the compact ones in settings. */
  size?: "md" | "sm";
  /** Width of the trigger; the list is at least as wide. */
  className?: string;
  "aria-label"?: string;
}

// Radix reserves the empty string for "nothing selected", which an option such as 无分组 needs.
const EMPTY = "\u0000empty";
const toRadix = (value: string) => (value === "" ? EMPTY : value);
const fromRadix = (value: string) => (value === EMPTY ? "" : value);

const sizes = {
  md: { trigger: "h-8 pl-2.5 pr-2 text-sm", item: "h-8 text-sm" },
  sm: { trigger: "h-7 pl-2 pr-1.5 text-xs", item: "h-7 text-xs" },
} as const;

/** A dropdown drawn by the app, so it looks the same in both themes on macOS and Windows. */
export function Select<T extends string>({ id, value, options, onChange, size = "md", className = "w-full", ...rest }: Props<T>) {
  const look = sizes[size];
  return (
    <RadixSelect.Root value={toRadix(value)} onValueChange={(next) => onChange(fromRadix(next) as T)}>
      <RadixSelect.Trigger
        id={id}
        aria-label={rest["aria-label"]}
        className={`group flex shrink-0 items-center justify-between gap-2 rounded-md border border-line-strong bg-canvas text-left outline-none transition-colors duration-150 hover:border-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 data-[state=open]:border-accent data-[state=open]:ring-2 data-[state=open]:ring-accent/25 disabled:opacity-50 ${look.trigger} ${className}`}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value />
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown
            size={14}
            className="shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180"
          />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-[60] max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] origin-[var(--radix-select-content-transform-origin)] animate-pop overflow-hidden rounded-lg border border-line-strong bg-raised text-ink shadow-overlay"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={toRadix(option.value)}
                className={`relative flex cursor-pointer select-none items-center rounded-md pl-2 pr-8 outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[state=checked]:font-medium ${look.item}`}
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2 flex items-center text-accent">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
