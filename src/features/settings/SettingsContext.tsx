import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { settingsLoad, settingsSave } from "../../ipc";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings";

const SAVE_DELAY_MS = 300;

interface Value {
  settings: Settings;
  update: (change: (current: Settings) => Settings) => void;
  /** Whether the app currently shows its dark appearance. */
  dark: boolean;
}

const Context = createContext<Value>({ settings: DEFAULT_SETTINGS, update: () => {}, dark: false });

function useSystemDark() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const systemDark = useSystemDark();
  const dark = settings.appearance === "system" ? systemDark : settings.appearance === "dark";

  useEffect(() => {
    settingsLoad()
      .then((raw) => {
        // Changes made before loading finished win over what was stored.
        if (!loaded.current) setSettings(normalizeSettings(raw));
      })
      .catch(() => {})
      .finally(() => (loaded.current = true));
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const update = useCallback((change: (current: Settings) => Settings) => {
    loaded.current = true;
    setSettings((current) => {
      const next = normalizeSettings(change(current));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void settingsSave(next).catch(() => {}), SAVE_DELAY_MS);
      return next;
    });
  }, []);

  return <Context.Provider value={{ settings, update, dark }}>{children}</Context.Provider>;
}

export function useSettings() {
  return useContext(Context);
}
