import { invoke } from "@tauri-apps/api/core";

export function coreVersion(): Promise<string> {
  return invoke<string>("core_version");
}
