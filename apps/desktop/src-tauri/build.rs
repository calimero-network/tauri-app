fn main() {
    // tauri::generate_context!() panics at compile time if distDir doesn't exist,
    // which breaks `cargo test`. Create a stub so tests compile without a frontend build.
    let dist = std::path::Path::new("../dist");
    if !dist.exists() {
        std::fs::create_dir_all(dist).ok();
        std::fs::write(dist.join("index.html"), "").ok();
    }
    println!("cargo:rerun-if-changed=../dist");

    // tauri-build fails on a declared resource that doesn't exist; these are normally
    // staged by beforeBuildCommand, which `cargo test` never runs.
    let merod = std::path::Path::new("merod");
    if !merod.exists() {
        std::fs::create_dir_all(merod).ok();
    }
    let exe = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        ".exe"
    } else {
        ""
    };
    for name in ["calimero-shell", "launcher-trampoline"] {
        let stub = std::path::PathBuf::from(format!("shell/{name}{exe}"));
        if !stub.exists() {
            std::fs::create_dir_all("shell").ok();
            std::fs::write(stub, "").ok();
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
