use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use tauri::{Emitter, Manager};

static PENDING_OAUTH_CODE: Mutex<Option<String>> = Mutex::new(None);

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

#[tauri::command]
fn get_oauth_code() -> Option<String> {
    let mut lock = PENDING_OAUTH_CODE.lock().unwrap();
    lock.take()
}

fn start_oauth_listener(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:1420") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[OAuth Server] Could not bind to 127.0.0.1:1420 (port in use or dev mode): {}", e);
                return;
            }
        };

        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let mut buffer = [0u8; 4096];
                if let Ok(n) = stream.read(&mut buffer) {
                    let req_str = String::from_utf8_lossy(&buffer[..n]);
                    if let Some(line) = req_str.lines().next() {
                        if line.contains("GET /oauth/callback") || line.contains("code=") {
                            let mut code = String::new();
                            if let Some(code_idx) = req_str.find("code=") {
                                let after = &req_str[code_idx + 5..];
                                code = after
                                    .chars()
                                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
                                    .collect();

                                if !code.is_empty() {
                                    {
                                        let mut lock = PENDING_OAUTH_CODE.lock().unwrap();
                                        *lock = Some(code.clone());
                                    }
                                    let _ = app_handle.emit("oauth_code", &code);

                                    // On Android the flow runs inside the app's
                                    // own WebView, so after capturing the code we
                                    // send the WebView back to the app origin
                                    // (http://tauri.localhost — the Android
                                    // workaround URL; `tauri://localhost` is not
                                    // loadable from a served page) with the code
                                    // in the query string, and the app completes
                                    // the login on boot. Navigating natively is
                                    // more reliable than relying on the served
                                    // page's meta-refresh.
                                    #[cfg(target_os = "android")]
                                    {
                                        let app_url = format!("http://tauri.localhost/?code={}", code);
                                        if let Ok(url) = tauri::Url::parse(&app_url) {
                                            if let Some(webview) =
                                                app_handle.get_webview_window("main")
                                            {
                                                let _ = webview.navigate(url);
                                            }
                                        }
                                    }
                                }
                            }

                            // Fallback for the system-browser path / any browser
                            // that can still navigate: on Android the meta-refresh
                            // points back at the app origin too.
                            let app_return = if cfg!(target_os = "android") && !code.is_empty() {
                                format!(
                                    "<meta http-equiv='refresh' content='1; url=http://tauri.localhost/?code={}'>",
                                    code
                                )
                            } else {
                                String::new()
                            };

                            let body = format!(
                                "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Introvert - Authorized</title>{}<style>body{{background:#0c0e12;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}}.card{{background:#151821;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:32px;text-align:center;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,0.5)}}h2{{margin:0 0 8px;font-size:20px;color:#38bdf8}}p{{font-size:13px;color:#94a3b8;margin:0 0 16px;line-height:1.5}}</style></head><body><div class='card'><h2>Authorization Successful</h2><p>You can close this window and return to Introvert. The app will log you in automatically.</p></div><script>window.setTimeout(function(){{ window.close(); }}, 1200);</script></body></html>",
                                app_return
                            );
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                        } else {
                            let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = stream.write_all(response.as_bytes());
                        }
                    }
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            start_oauth_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_get,
            storage_set,
            storage_delete,
            get_platform_info,
            get_oauth_code
        ])
        .run(tauri::generate_context!())
        .expect("error while running introvert tauri application");
}
