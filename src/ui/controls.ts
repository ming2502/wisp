const shape =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50";
const sizes = { md: "h-8 px-3 text-sm", sm: "h-7 px-2.5 text-xs" } as const;
const variants = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border border-line-strong bg-raised hover:bg-hover",
  danger: "bg-danger text-on-danger hover:opacity-90",
} as const;

export function button(variant: keyof typeof variants, size: keyof typeof sizes = "md") {
  return `${shape} ${sizes[size]} ${variants[variant]}`;
}

export const primaryButton = button("primary");
export const secondaryButton = button("secondary");
export const dangerButton = button("danger");

const field =
  "w-full rounded-md border border-line-strong bg-canvas outline-none transition-colors duration-150 placeholder:text-muted hover:border-muted focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-50";
export const inputClass = `${field} h-8 px-2.5 text-sm`;
export const compactInputClass = `${field} h-7 px-2 text-xs`;

export const iconButton =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:opacity-100";
