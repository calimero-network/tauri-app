fn main() {
    // The shell renders external app URLs, so it has no bundled frontend. But
    // `tauri::generate_context!()` still validates `frontendDist`; materialize a
    // placeholder so `cargo build` works without a separate prepare step.
    let dist = std::path::Path::new("dist");
    if !dist.exists() {
        std::fs::create_dir_all(dist).ok();
    }
    let index = dist.join("index.html");
    if !index.exists() {
        std::fs::write(&index, "<!doctype html><title>Calimero Shell</title>").ok();
    }
    println!("cargo:rerun-if-changed=dist");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
