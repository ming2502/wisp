//! File and folder pickers centred over the app's window. The dialog plugin shows them as a sheet
//! sliding from the top of the window on macOS, and wherever the system last put them on Windows.

use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickOptions {
    /// Folders instead of files.
    folders: bool,
    multiple: bool,
    title: String,
    default_path: Option<String>,
}

/// The chosen paths, or none when the dialog was cancelled.
#[tauri::command]
pub async fn pick_paths(
    window: WebviewWindow,
    options: PickOptions,
) -> Result<Vec<String>, String> {
    pick(window, options).await
}

#[cfg(target_os = "macos")]
async fn pick(window: WebviewWindow, options: PickOptions) -> Result<Vec<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(macos::pick(&parent, &options));
        })
        .map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn pick(window: WebviewWindow, options: PickOptions) -> Result<Vec<String>, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    // The dialog runs its own message loop, on a thread of its own as COM requires.
    tokio::task::spawn_blocking(move || windows::pick(owner, &options))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn pick(window: WebviewWindow, options: PickOptions) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = window.dialog().file().set_title(options.title);
    if let Some(path) = options.default_path {
        dialog = dialog.set_directory(path);
    }
    let picked = match (options.folders, options.multiple) {
        (true, true) => dialog.blocking_pick_folders(),
        (true, false) => dialog.blocking_pick_folder().map(|path| vec![path]),
        (false, true) => dialog.blocking_pick_files(),
        (false, false) => dialog.blocking_pick_file().map(|path| vec![path]),
    };
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string())
        .collect())
}

#[cfg(target_os = "macos")]
mod macos {
    use dispatch2::DispatchQueue;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSWindow};
    use objc2_foundation::{NSPoint, NSString, NSURL};
    use tauri::WebviewWindow;

    use super::PickOptions;

    /// Carries the panel into a block for the main queue, which runs on the main thread.
    struct MainThreadOnly(Retained<NSOpenPanel>);
    // SAFETY: only ever used by a block on the main queue, so on the main thread.
    unsafe impl Send for MainThreadOnly {}

    impl MainThreadOnly {
        fn panel(&self) -> &NSOpenPanel {
            &self.0
        }
    }

    /// A free-standing panel rather than a sheet, so that it can sit in the middle of the window.
    pub fn pick(window: &WebviewWindow, options: &PickOptions) -> Vec<String> {
        let mtm = MainThreadMarker::new().expect("run on the main thread");
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseFiles(!options.folders);
        panel.setCanChooseDirectories(options.folders);
        panel.setAllowsMultipleSelection(options.multiple);
        panel.setCanCreateDirectories(true);
        panel.setMessage(Some(&NSString::from_str(&options.title)));
        if let Some(path) = &options.default_path {
            panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(path))));
        }
        if let Ok(pointer) = window.ns_window() {
            // SAFETY: Tauri hands out the window's live NSWindow, used here on the main thread.
            let parent = unsafe { &*(pointer as *const NSWindow) };
            let outer = parent.frame();
            let own = panel.frame();
            let origin = NSPoint::new(
                outer.origin.x + (outer.size.width - own.size.width) / 2.0,
                outer.origin.y + (outer.size.height - own.size.height) / 2.0,
            );
            // runModal centres the panel on the screen as it opens, so it is moved once the modal
            // loop is running, which drains the main queue.
            let moving = MainThreadOnly(panel.clone());
            DispatchQueue::main().exec_async(move || {
                // Through a method, since naming only the field would capture just the field.
                moving.panel().setFrameOrigin(origin);
            });
        }
        if panel.runModal() != NSModalResponseOK {
            return Vec::new();
        }
        panel
            .URLs()
            .iter()
            .filter_map(|url| url.path())
            .map(|path| path.to_string())
            .collect()
    }
}

#[cfg(windows)]
mod windows {
    use std::cell::Cell;

    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
        CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::Ole::IOleWindow;
    use windows::Win32::UI::Shell::{
        FDE_OVERWRITE_RESPONSE, FDE_SHAREVIOLATION_RESPONSE, FDEOR_DEFAULT, FDESVR_DEFAULT,
        FILEOPENDIALOGOPTIONS, FOS_ALLOWMULTISELECT, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
        FileOpenDialog, IFileDialog, IFileDialogEvents, IFileDialogEvents_Impl, IFileOpenDialog,
        IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };
    use windows::core::{HSTRING, Interface, PWSTR, Ref};
    use windows_core::implement;

    use super::PickOptions;

    /// Moves the dialog to the middle of its owner the first time it reports a folder, which it
    /// does as it opens.
    #[implement(IFileDialogEvents)]
    struct Centre {
        owner: HWND,
        done: Cell<bool>,
    }

    impl IFileDialogEvents_Impl for Centre_Impl {
        fn OnFolderChange(&self, dialog: Ref<IFileDialog>) -> windows::core::Result<()> {
            if !self.done.replace(true)
                && let Some(dialog) = dialog.as_ref()
            {
                // SAFETY: the dialog is alive for the whole call.
                let hwnd = unsafe { dialog.cast::<IOleWindow>()?.GetWindow()? };
                centre(hwnd, self.owner);
            }
            Ok(())
        }
        fn OnFileOk(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnFolderChanging(
            &self,
            _: Ref<IFileDialog>,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnSelectionChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnShareViolation(
            &self,
            _: Ref<IFileDialog>,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
            Ok(FDESVR_DEFAULT)
        }
        fn OnTypeChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnOverwrite(
            &self,
            _: Ref<IFileDialog>,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
            Ok(FDEOR_DEFAULT)
        }
    }

    fn centre(dialog: HWND, owner: HWND) {
        let mut outer = RECT::default();
        let mut own = RECT::default();
        unsafe {
            if GetWindowRect(owner, &mut outer).is_err() || GetWindowRect(dialog, &mut own).is_err()
            {
                return;
            }
            let width = own.right - own.left;
            let height = own.bottom - own.top;
            let x = outer.left + (outer.right - outer.left - width) / 2;
            let y = outer.top + (outer.bottom - outer.top - height) / 2;
            let _ = SetWindowPos(
                dialog,
                None,
                x,
                y.max(outer.top),
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    pub fn pick(owner: isize, options: &PickOptions) -> Result<Vec<String>, String> {
        unsafe {
            let initialised =
                CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
            let picked = show(HWND(owner as _), options).map_err(|e| e.message());
            if initialised {
                CoUninitialize();
            }
            picked
        }
    }

    unsafe fn show(owner: HWND, options: &PickOptions) -> windows::core::Result<Vec<String>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            let mut flags: FILEOPENDIALOGOPTIONS = dialog.GetOptions()? | FOS_FORCEFILESYSTEM;
            if options.folders {
                flags |= FOS_PICKFOLDERS;
            }
            if options.multiple {
                flags |= FOS_ALLOWMULTISELECT;
            }
            dialog.SetOptions(flags)?;
            dialog.SetTitle(&HSTRING::from(options.title.as_str()))?;
            if let Some(path) = &options.default_path
                && let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(
                    &HSTRING::from(path.as_str()),
                    None,
                )
            {
                dialog.SetFolder(&folder)?;
            }
            let events: IFileDialogEvents = Centre {
                owner,
                done: Cell::new(false),
            }
            .into();
            let cookie = dialog.Advise(&events)?;
            let shown = dialog.Show(Some(owner));
            let _ = dialog.Unadvise(cookie);
            if shown.is_err() {
                // Cancelling is reported as an error too.
                return Ok(Vec::new());
            }
            let items = dialog.GetResults()?;
            let mut paths = Vec::new();
            for index in 0..items.GetCount()? {
                let item = items.GetItemAt(index)?;
                let name: PWSTR = item.GetDisplayName(SIGDN_FILESYSPATH)?;
                paths.push(name.to_string().unwrap_or_default());
                windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as _));
            }
            Ok(paths)
        }
    }
}
