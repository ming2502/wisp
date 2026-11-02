import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { SettingsProvider } from "./features/settings/SettingsContext";
// Latin only: CJK text falls back to the system font, which keeps the app small.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./ui/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>,
);
