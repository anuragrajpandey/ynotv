use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "windows" {
        let libmpv = manifest.join("libmpv");
        if libmpv.join("mpv.lib").exists() {
            println!("cargo:rustc-link-search=native={}", libmpv.display());
            println!("cargo:rerun-if-changed={}", libmpv.join("mpv.lib").display());
        }
    }

    if target_os == "macos" {
        let mut prefixes: Vec<String> = Vec::new();
        if let Ok(p) = std::env::var("HOMEBREW_PREFIX") {
            if !p.is_empty() {
                prefixes.push(p);
            }
        }
        for p in ["/opt/homebrew", "/usr/local", "/opt/local"] {
            prefixes.push(p.to_string());
        }
        for prefix in &prefixes {
            for sub in ["lib", "opt/mpv/lib", "opt/libmpv/lib"] {
                let dir = std::path::Path::new(prefix).join(sub);
                if dir.exists() {
                    println!("cargo:rustc-link-search=native={}", dir.display());
                }
            }
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
        #[cfg(target_arch = "aarch64")]
        {
            println!("cargo:rustc-link-arg=-Wl,-rpath,/opt/homebrew/lib");
            println!("cargo:rustc-link-arg=-Wl,-rpath,/opt/homebrew/opt/mpv/lib");
        }
        #[cfg(target_arch = "x86_64")]
        {
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/local/lib");
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/local/opt/mpv/lib");
        }
    }

    tauri_build::build()
}

