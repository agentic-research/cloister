// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Policy — the confinement/v1 fs allowlist, flattened to path-prefix sets. Read
// = every `fs.allow` entry; write = the `mode:"rw"` subset. Prefix matching is
// PATH-BOUNDARY-AWARE (a prefix `/skills` grants `/skills/x` but NOT
// `/skillsomething`) — applying the 2026-07-14 math-friend scope lesson.

use serde::Deserialize;

#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub read_prefixes: Vec<String>,
    pub write_prefixes: Vec<String>,
}

impl Policy {
    pub fn allows_read(&self, id: &str) -> bool {
        has_prefix(&self.read_prefixes, id)
    }
    pub fn allows_write(&self, id: &str) -> bool {
        has_prefix(&self.write_prefixes, id)
    }
}

/// True iff `id` equals a prefix or is a path-descendant of one (`<prefix>/…`).
/// Boundary-aware: `/skills` does NOT grant `/skillsomething`.
fn has_prefix(prefixes: &[String], id: &str) -> bool {
    let id = if id.is_empty() { "/" } else { id };
    prefixes.iter().any(|p| {
        let p = p.trim_end_matches('/');
        id == p || id.starts_with(&format!("{p}/"))
    })
}

/// The confinement/v1 `fs` block (mirrors tools/harness-sandbox's shape).
#[derive(Debug, Deserialize)]
pub struct ConfinementFs {
    pub allow: Vec<FsEntry>,
}

/// A `fs.allow` entry: a bare string (read-only) or `{path, mode}` (mode "rw" ⇒ writable).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum FsEntry {
    Ro(String),
    Rw { path: String, mode: String },
}

impl From<&ConfinementFs> for Policy {
    fn from(fs: &ConfinementFs) -> Self {
        let mut read_prefixes = Vec::new();
        let mut write_prefixes = Vec::new();
        for e in &fs.allow {
            match e {
                FsEntry::Ro(p) => read_prefixes.push(p.clone()),
                FsEntry::Rw { path, mode } => {
                    read_prefixes.push(path.clone());
                    if mode == "rw" {
                        write_prefixes.push(path.clone());
                    }
                }
            }
        }
        Policy { read_prefixes, write_prefixes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            read_prefixes: vec!["/skills".into(), "/work".into()],
            write_prefixes: vec!["/work".into()],
        }
    }

    #[test]
    fn read_allowed_under_prefix() {
        assert!(policy().allows_read("/skills/x.md"));
        assert!(policy().allows_read("/skills")); // the prefix itself
    }
    #[test]
    fn read_denied_outside_prefix() {
        assert!(!policy().allows_read("/etc/passwd"));
    }
    #[test]
    fn prefix_is_path_boundary_aware() {
        // /skills must NOT grant /skillsomething (the math-friend scope lesson).
        assert!(!policy().allows_read("/skillsomething"));
    }
    #[test]
    fn write_allowed_only_on_rw() {
        assert!(policy().allows_write("/work/out.txt"));
    }
    #[test]
    fn write_denied_on_ro_prefix() {
        assert!(!policy().allows_write("/skills/x.md"));
    }
    #[test]
    fn from_confinement_fs_flattens_ro_and_rw() {
        let fs = ConfinementFs {
            allow: vec![
                FsEntry::Ro("/skills".into()),
                FsEntry::Rw { path: "/work".into(), mode: "rw".into() },
                FsEntry::Rw { path: "/ro".into(), mode: "ro".into() },
            ],
        };
        let p = Policy::from(&fs);
        assert!(p.allows_read("/skills/x") && p.allows_read("/work/y") && p.allows_read("/ro/z"));
        assert!(p.allows_write("/work/y"));
        assert!(!p.allows_write("/ro/z") && !p.allows_write("/skills/x"));
    }
}
