interface Props {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** An on/off toggle for settings that take effect at once. Label it with a `<label htmlFor>`. */
export function Switch({ id, checked, onChange, disabled }: Props) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50 ${
        checked ? "bg-accent" : "bg-line-strong"
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden
        className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
