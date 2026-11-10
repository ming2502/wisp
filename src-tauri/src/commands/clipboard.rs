//! Files copied in Finder or Explorer, for pasting them into the file view. The web view only sees
//! their contents, if anything, never where they are, so the paths come from the system clipboard.

/// The paths of the files and folders on the clipboard; empty when it holds something else.
#[tauri::command]
pub fn clipboard_files() -> Vec<String> {
    platform::files()
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSURL;

    pub fn files() -> Vec<String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let Some(items) = pasteboard.pasteboardItems() else {
            return Vec::new();
        };
        // SAFETY: a constant string AppKit defines.
        let file_url = unsafe { NSPasteboardTypeFileURL };
        items
            .iter()
            .filter_map(|item| item.stringForType(file_url))
            .filter_map(|url| NSURL::URLWithString(&url))
            .filter_map(|url| url.path())
            .map(|path| path.to_string())
            .collect()
    }
}

#[cfg(windows)]
mod platform {
    use std::time::Duration;

    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    pub fn files() -> Vec<String> {
        // Another program may hold the clipboard for a moment.
        let opened = (0..5).any(|attempt| {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(20));
            }
            // SAFETY: plain Win32 call; the clipboard is closed again below.
            unsafe { OpenClipboard(None).is_ok() }
        });
        if !opened {
            return Vec::new();
        }
        // SAFETY: the handle belongs to the clipboard, which stays open while it is read.
        let paths = unsafe {
            match GetClipboardData(u32::from(CF_HDROP.0)) {
                Ok(handle) => {
                    let drop = HDROP(handle.0);
                    (0..DragQueryFileW(drop, u32::MAX, None))
                        .map(|index| {
                            let length = DragQueryFileW(drop, index, None) as usize;
                            let mut buffer = vec![0u16; length + 1];
                            DragQueryFileW(drop, index, Some(&mut buffer));
                            String::from_utf16_lossy(&buffer[..length])
                        })
                        .collect()
                }
                Err(_) => Vec::new(),
            }
        };
        // SAFETY: opened above.
        let _ = unsafe { CloseClipboard() };
        paths
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn files() -> Vec<String> {
        Vec::new()
    }
}
