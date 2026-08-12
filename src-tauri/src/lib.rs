use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn get_storage_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let storage_dir = app_dir.join("introvert_storage");
    if !storage_dir.exists() {
        fs::create_dir_all(&storage_dir)
            .map_err(|e| format!("Failed to create storage dir: {}", e))?;
    }
    Ok(storage_dir)
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

#[tauri::command]
fn storage_get(app_handle: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let dir = get_storage_dir(&app_handle)?;
    let file_path = dir.join(format!("{}.json", sanitize_key(&key)));
    if !file_path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(file_path).map_err(|e| format!("Failed to read key {}: {}", key, e))?;
    Ok(Some(data))
}

#[tauri::command]
fn storage_set(app_handle: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let dir = get_storage_dir(&app_handle)?;
    let file_path = dir.join(format!("{}.json", sanitize_key(&key)));
    fs::write(file_path, value).map_err(|e| format!("Failed to write key {}: {}", key, e))?;
    Ok(())
}

#[tauri::command]
fn storage_delete(app_handle: tauri::AppHandle, key: String) -> Result<(), String> {
    let dir = get_storage_dir(&app_handle)?;
    let file_path = dir.join(format!("{}.json", sanitize_key(&key)));
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| format!("Failed to remove key {}: {}", key, e))?;
    }
    Ok(())
}

#[tauri::command]
fn get_platform_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            storage_get,
            storage_set,
            storage_delete,
            get_platform_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running introvert tauri application");
}
