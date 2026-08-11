//! macOS-only: the shell learns which app it is from `--app-config <path>`.
#![allow(dead_code)]
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct ShellConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default = "default_node_url")]
    pub node_url: String,
    #[serde(default)]
    pub cap: String,
}
fn default_node_url() -> String {
    "http://localhost:2528".to_string()
}

pub fn parse_app_config_arg(args: &[String]) -> Option<PathBuf> {
    flag_value(args, "--app-config").map(PathBuf::from)
}

/// Query params for THIS launch only (a deep link's `invitation=…`), passed on
/// argv precisely so they stay out of the bundle's stored URL.
pub fn parse_url_params_arg(args: &[String]) -> Option<String> {
    flag_value(args, "--url-params")
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

pub fn load_shell_config(path: &Path) -> Option<ShellConfig> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flag_and_file() {
        let args: Vec<String> = vec![
            "bin".into(),
            "--app-config".into(),
            "/x/app.json".into(),
            "--url-params".into(),
            "invitation=abc".into(),
        ];
        assert_eq!(parse_app_config_arg(&args), Some(PathBuf::from("/x/app.json")));
        assert_eq!(parse_url_params_arg(&args), Some("invitation=abc".into()));
        assert_eq!(parse_app_config_arg(&["bin".into()]), None);
        assert_eq!(parse_url_params_arg(&["bin".into(), "--url-params".into()]), None);

        let dir = std::env::temp_dir().join(format!("cal-shellcfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("app.json");
        std::fs::write(
            &p,
            r#"{"id":"mero-drive","name":"MeroDrive","url":"https://calimero.network","cap":"c1"}"#,
        )
        .unwrap();
        let c = load_shell_config(&p).unwrap();
        assert_eq!(c.id, "mero-drive");
        assert_eq!(c.node_url, "http://localhost:2528"); // default applied
        assert_eq!(c.cap, "c1");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
