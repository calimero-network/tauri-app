fn main() {
    // tauri::generate_context!() panics at compile time if distDir doesn't exist,
    // which breaks `cargo test`. Create a stub so tests compile without a frontend build.
    let dist = std::path::Path::new("../dist");
    if !dist.exists() {
        std::fs::create_dir_all(dist).ok();
        std::fs::write(dist.join("index.html"), "").ok();
    }
    println!("cargo:rerun-if-changed=../dist");

    // Embed merod target version at compile time so the binary knows what to download at runtime.
    let config_path = std::path::Path::new("../../../merod-config.json");
    if let Ok(content) = std::fs::read_to_string(config_path) {
        if let Some(version) = extract_json_string(&content, "version") {
            println!("cargo:rustc-env=MEROD_CONFIG_VERSION={}", version);
        }
    }
    println!("cargo:rerun-if-changed=../../../merod-config.json");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}

/// Minimal JSON string field extractor — avoids a serde_json build dep.
/// Sufficient for merod-config.json which contains only a semver string value;
/// semver values never contain escaped quotes or nested JSON, so this parser is correct for this use.
fn extract_json_string(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{}\"", field);
    let key_idx = json.find(&key)?;
    let after = &json[key_idx + key.len()..];
    let colon = after.find(':')?;
    let after_colon = after[colon + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let inner = &after_colon[1..];
    let end = inner.find('"')?;
    Some(inner[..end].to_string())
}
