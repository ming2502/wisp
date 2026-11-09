//! The Windows title bar: it keeps the system's buttons and behaviour, takes the colours of the
//! app's top row in either theme, and shows only the icon. macOS overlays the title bar on the
//! app, so there is nothing to do there.

use tauri::WebviewWindow;

/// Paints the title bar like the app's top row in the light or dark theme.
#[tauri::command]
pub fn set_title_bar_theme(window: WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(windows)]
    windows::paint(&window, dark)?;
    #[cfg(not(windows))]
    let _ = (window, dark);
    Ok(())
}

/// Hides the title text, leaving the icon. The title stays set for the taskbar and Alt+Tab.
pub fn hide_title_text(window: &WebviewWindow) {
    #[cfg(windows)]
    windows::hide_caption(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;

    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::Graphics::Dwm::{
        DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWINDOWATTRIBUTE,
        DwmSetWindowAttribute,
    };
    use windows::Win32::UI::Controls::{
        SetWindowThemeAttribute, WTA_NONCLIENT, WTA_OPTIONS, WTNCA_NODRAWCAPTION,
    };
    use windows::core::BOOL;

    /// `--color-panel` and `--color-ink` of src/ui/tokens.css, as 0x00BBGGRR.
    const LIGHT: (u32, u32) = (0x00FC_FAF8, 0x002A_170F);
    const DARK: (u32, u32) = (0x0020_110B, 0x00F9_F5F1);

    fn hwnd(window: &WebviewWindow) -> Result<HWND, String> {
        Ok(HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _))
    }

    fn set<T>(hwnd: HWND, attribute: DWMWINDOWATTRIBUTE, value: &T) -> windows::core::Result<()> {
        // SAFETY: `value` is a live value of the size the attribute expects.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                value as *const T as *const c_void,
                size_of::<T>() as u32,
            )
        }
    }

    pub fn paint(window: &WebviewWindow, dark: bool) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        // Dark buttons and frame; Windows 10 20H1 and later.
        let _ = set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &BOOL::from(dark));
        // The exact colours need Windows 11; older versions keep the system's light or dark grey.
        let (caption, text) = if dark { DARK } else { LIGHT };
        let _ = set(hwnd, DWMWA_CAPTION_COLOR, &COLORREF(caption));
        let _ = set(hwnd, DWMWA_TEXT_COLOR, &COLORREF(text));
        Ok(())
    }

    pub fn hide_caption(window: &WebviewWindow) {
        let Ok(hwnd) = hwnd(window) else { return };
        let options = WTA_OPTIONS {
            dwFlags: WTNCA_NODRAWCAPTION,
            dwMask: WTNCA_NODRAWCAPTION,
        };
        // SAFETY: the options live for the call and their size is passed along.
        let _ = unsafe {
            SetWindowThemeAttribute(
                hwnd,
                WTA_NONCLIENT,
                &options as *const WTA_OPTIONS as *const c_void,
                size_of::<WTA_OPTIONS>() as u32,
            )
        };
    }
}
