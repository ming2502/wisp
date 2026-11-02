//! Reads `~/.ssh/config` for importing hosts. Only what a saved host can represent is read; the
//! file is never written.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{DEFAULT_PORT, HostAuth};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuth,
    /// Set when the entry relies on a jump host, which saved hosts cannot express yet.
    pub proxy_jump: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub candidates: Vec<ImportCandidate>,
    /// `Include` and `Match` directives that were not followed.
    pub skipped_directives: usize,
}

pub struct Environment<'a> {
    pub home: &'a Path,
    pub local_user: &'a str,
    /// The first of OpenSSH's default identity files that exists, used when no `IdentityFile`
    /// applies, since that is the key ssh itself would try.
    pub default_identity: Option<PathBuf>,
}

enum Patterns {
    /// Directives before the first `Host` line apply to every host.
    All,
    Hosts(Vec<String>),
    /// A `Match` block, whose conditions are not evaluated.
    Skipped,
}

struct Block {
    patterns: Patterns,
    directives: Vec<(String, Vec<String>)>,
}

pub fn preview(text: &str, env: &Environment) -> ImportPreview {
    let (blocks, skipped_directives) = parse_blocks(text);
    let mut aliases: Vec<&str> = Vec::new();
    for block in &blocks {
        if let Patterns::Hosts(patterns) = &block.patterns {
            for pattern in patterns {
                let concrete = !pattern.contains(['*', '?', '!']);
                if concrete && !aliases.contains(&pattern.as_str()) {
                    aliases.push(pattern);
                }
            }
        }
    }
    let candidates = aliases
        .into_iter()
        .filter_map(|alias| resolve(alias, &blocks, env))
        .collect();
    ImportPreview {
        candidates,
        skipped_directives,
    }
}

fn parse_blocks(text: &str) -> (Vec<Block>, usize) {
    let mut blocks = vec![Block {
        patterns: Patterns::All,
        directives: Vec::new(),
    }];
    let mut skipped = 0;
    for line in text.lines() {
        let Some((keyword, args)) = split_line(line) else {
            continue;
        };
        match keyword.as_str() {
            "host" => blocks.push(Block {
                patterns: Patterns::Hosts(args),
                directives: Vec::new(),
            }),
            "match" => {
                skipped += 1;
                blocks.push(Block {
                    patterns: Patterns::Skipped,
                    directives: Vec::new(),
                });
            }
            "include" => skipped += 1,
            _ => blocks.last_mut().unwrap().directives.push((keyword, args)),
        }
    }
    (blocks, skipped)
}

/// Splits `Keyword value`, `Keyword=value` or `Keyword = value`, honouring double quotes.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_token = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has_token = true;
            }
            '#' if !quoted && !has_token => break,
            c if c.is_whitespace() && !quoted => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    Some((keyword, args))
}

fn matches(alias: &str, patterns: &Patterns) -> bool {
    let Patterns::Hosts(patterns) = patterns else {
        return matches!(patterns, Patterns::All);
    };
    let mut matched = false;
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(negated) if glob(negated, alias) => return false,
            Some(_) => {}
            None => matched |= glob(pattern, alias),
        }
    }
    matched
}

fn glob(pattern: &str, text: &str) -> bool {
    fn go(pattern: &[char], text: &[char]) -> bool {
        match pattern.split_first() {
            None => text.is_empty(),
            Some(('*', rest)) => (0..=text.len()).any(|skip| go(rest, &text[skip..])),
            Some(('?', rest)) => !text.is_empty() && go(rest, &text[1..]),
            Some((c, rest)) => {
                text.first().is_some_and(|t| t.eq_ignore_ascii_case(c)) && go(rest, &text[1..])
            }
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    go(&pattern, &text)
}

/// OpenSSH uses the first value it finds for each keyword, reading blocks top to bottom.
fn resolve(alias: &str, blocks: &[Block], env: &Environment) -> Option<ImportCandidate> {
    let mut values: HashMap<&str, &str> = HashMap::new();
    for block in blocks
        .iter()
        .filter(|block| matches(alias, &block.patterns))
    {
        for (keyword, args) in &block.directives {
            if let Some(first) = args.first() {
                values.entry(keyword.as_str()).or_insert(first.as_str());
            }
        }
    }
    let host = values
        .get("hostname")
        .map_or_else(|| alias.to_string(), |name| name.replace("%h", alias));
    let port = match values.get("port") {
        Some(port) => port.parse().ok().filter(|port| *port != 0)?,
        None => DEFAULT_PORT,
    };
    let user = values
        .get("user")
        .map_or_else(|| env.local_user.to_string(), |user| user.to_string());
    let identity = values
        .get("identityfile")
        .filter(|path| !path.eq_ignore_ascii_case("none"))
        .map(|path| expand(path, alias, &host, port, &user, env))
        .or_else(|| env.default_identity.clone());
    let auth = match identity {
        Some(path) => HostAuth::Key { path },
        None => HostAuth::Password,
    };
    let proxy_jump = values
        .get("proxyjump")
        .or_else(|| values.get("proxycommand"))
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| value.to_string());
    Some(ImportCandidate {
        name: alias.to_string(),
        host,
        port,
        user,
        auth,
        proxy_jump,
    })
}

fn expand(
    path: &str,
    alias: &str,
    host: &str,
    port: u16,
    user: &str,
    env: &Environment,
) -> PathBuf {
    let mut expanded = String::new();
    let mut chars = path.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            expanded.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => expanded.push('%'),
            Some('d') => expanded.push_str(&env.home.to_string_lossy()),
            Some('h') => expanded.push_str(host),
            Some('n') => expanded.push_str(alias),
            Some('p') => expanded.push_str(&port.to_string()),
            Some('r') => expanded.push_str(user),
            Some('u') => expanded.push_str(env.local_user),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    match expanded.strip_prefix("~/") {
        Some(rest) => env.home.join(rest),
        None => PathBuf::from(expanded),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(default_identity: Option<&str>) -> Environment<'static> {
        Environment {
            home: Path::new("/home/me"),
            local_user: "me",
            default_identity: default_identity.map(PathBuf::from),
        }
    }

    fn preview_of(text: &str) -> ImportPreview {
        preview(text, &env(None))
    }

    fn only(text: &str) -> ImportCandidate {
        let preview = preview_of(text);
        assert_eq!(preview.candidates.len(), 1, "{preview:?}");
        preview.candidates.into_iter().next().unwrap()
    }

    #[test]
    fn reads_basic_entry() {
        let candidate = only(
            "Host web\n  HostName 10.0.0.5\n  Port 2222\n  User deploy\n  IdentityFile ~/.ssh/web\n",
        );
        assert_eq!(
            candidate,
            ImportCandidate {
                name: "web".into(),
                host: "10.0.0.5".into(),
                port: 2222,
                user: "deploy".into(),
                auth: HostAuth::Key {
                    path: "/home/me/.ssh/web".into()
                },
                proxy_jump: None,
            }
        );
    }

    #[test]
    fn defaults_follow_openssh() {
        let candidate = only("Host plain\n");
        assert_eq!(candidate.host, "plain");
        assert_eq!(candidate.port, 22);
        assert_eq!(candidate.user, "me");
        assert_eq!(candidate.auth, HostAuth::Password);
    }

    #[test]
    fn falls_back_to_default_identity_file() {
        let preview = preview("Host a\n", &env(Some("/home/me/.ssh/id_ed25519")));
        assert_eq!(
            preview.candidates[0].auth,
            HostAuth::Key {
                path: "/home/me/.ssh/id_ed25519".into()
            }
        );
    }

    #[test]
    fn identity_file_none_falls_back_to_default() {
        let preview = preview("Host a\n  IdentityFile none\n", &env(Some("/k")));
        assert_eq!(
            preview.candidates[0].auth,
            HostAuth::Key { path: "/k".into() }
        );
    }

    #[test]
    fn first_value_wins_across_matching_blocks() {
        let text = "Host a\n  User first\nHost *\n  User fallback\n  Port 2200\nHost a\n  Port 9\n";
        let candidate = only(text);
        assert_eq!(candidate.user, "first");
        assert_eq!(candidate.port, 2200);
    }

    #[test]
    fn global_directives_apply_before_host_blocks() {
        let candidate = only("User everyone\nHost a\n  User mine\n");
        assert_eq!(candidate.user, "everyone");
    }

    #[test]
    fn wildcards_and_negations_are_not_imported_but_apply() {
        let text = "Host *.prod !db.prod\n  User ops\nHost web.prod db.prod\n";
        let preview = preview_of(text);
        let users: Vec<_> = preview
            .candidates
            .iter()
            .map(|c| (c.name.as_str(), c.user.as_str()))
            .collect();
        assert_eq!(users, [("web.prod", "ops"), ("db.prod", "me")]);
    }

    #[test]
    fn multiple_aliases_on_one_line() {
        let preview = preview_of("Host a b\n  HostName %h.example.com\n");
        let hosts: Vec<_> = preview.candidates.iter().map(|c| c.host.as_str()).collect();
        assert_eq!(hosts, ["a.example.com", "b.example.com"]);
    }

    #[test]
    fn syntax_variants_comments_and_case() {
        let text =
            "# comment\nHOST=a\n\thostname = 1.2.3.4 # trailing\n  IDENTITYFILE \"~/my keys/id\"\n";
        let candidate = only(text);
        assert_eq!(candidate.host, "1.2.3.4");
        assert_eq!(
            candidate.auth,
            HostAuth::Key {
                path: "/home/me/my keys/id".into()
            }
        );
    }

    #[test]
    fn identity_file_tokens_are_expanded() {
        let candidate = only("Host a\n  User bob\n  IdentityFile %d/.ssh/%r@%h-%%\n");
        assert_eq!(
            candidate.auth,
            HostAuth::Key {
                path: "/home/me/.ssh/bob@a-%".into()
            }
        );
    }

    #[test]
    fn jump_hosts_are_flagged() {
        let preview = preview_of(
            "Host a\n  ProxyJump bastion\nHost b\n  ProxyCommand ssh -W %h:%p x\nHost c\n  ProxyJump none\n",
        );
        let jumps: Vec<_> = preview
            .candidates
            .iter()
            .map(|c| c.proxy_jump.is_some())
            .collect();
        assert_eq!(jumps, [true, true, false]);
    }

    #[test]
    fn match_and_include_are_skipped_and_counted() {
        let text = "Include ~/.ssh/extra\nHost a\nMatch host a\n  User matched\n";
        let preview = preview_of(text);
        assert_eq!(preview.skipped_directives, 2);
        assert_eq!(preview.candidates[0].user, "me");
    }

    #[test]
    fn invalid_port_skips_the_entry() {
        assert!(preview_of("Host a\n  Port nope\n").candidates.is_empty());
    }

    #[test]
    fn duplicate_aliases_are_listed_once() {
        assert_eq!(preview_of("Host a\nHost a\n").candidates.len(), 1);
    }
}
