/** The app mark: a prompt chevron and cursor, drawn like the app icon. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#0f172a" />
      <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="none" stroke="#ffffff" strokeOpacity="0.12" />
      <polyline points="6.5,8 10,12 6.5,16" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="11.5" y="15" width="6" height="2" rx="1" fill="#e2e8f0" />
    </svg>
  );
}
