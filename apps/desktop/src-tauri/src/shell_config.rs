//! macOS-only: the shell learns which app it is from `--app-config <path>`.
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
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--app-config" {
            return it.next().map(PathBuf::from);
        }
    }
    None
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
        let args = vec!["bin".into(), "--app-config".into(), "/x/app.json".into()];
        assert_eq!(parse_app_config_arg(&args), Some(PathBuf::from("/x/app.json")));
        assert_eq!(parse_app_config_arg(&["bin".into()]), None);

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
