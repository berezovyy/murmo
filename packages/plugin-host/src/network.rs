//! Brokered HTTP: one exact origin, one pinned resolution, no redirects (E6).

use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::{json, Value};

pub fn is_http_redirect(status: u16) -> bool {
    (300..400).contains(&status)
}

pub fn classify_ip(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            if o[0] == 127 || o[0] == 0 {
                "loopback"
            } else if o[0] == 10
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
            {
                "private"
            } else if o[0] == 169 && o[1] == 254 {
                "link-local"
            } else {
                "public"
            }
        }
        IpAddr::V6(v) => {
            if v.is_loopback() {
                "loopback"
            } else if v.segments()[0] & 0xffc0 == 0xfe80 {
                "link-local"
            } else if v.segments()[0] & 0xfe00 == 0xfc00 {
                "private"
            } else {
                "public"
            }
        }
    }
}

fn parse_origin(origin: &str) -> Option<(String, String, u16)> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    let scheme = if origin.starts_with("https://") {
        "https"
    } else {
        "http"
    };
    let (host, port) = if let Some(h) = rest.strip_prefix('[') {
        let (host, rest) = h.split_once(']')?;
        let port = rest.strip_prefix(':').and_then(|p| p.parse().ok())?;
        (host.to_string(), port)
    } else if let Some((host, p)) = rest.rsplit_once(':') {
        (host.to_lowercase(), p.parse().ok()?)
    } else {
        (
            rest.to_lowercase(),
            if scheme == "https" { 443 } else { 80 },
        )
    };
    Some((scheme.to_string(), host, port))
}

fn url_parts(url: &str) -> Option<(String, String, u16, String)> {
    if url.contains('@') {
        return None;
    }
    let idx = url.find("://")?;
    let after = &url[idx + 3..];
    let slash = after.find('/').unwrap_or(after.len());
    let origin = format!("{}://{}", &url[..idx], &after[..slash]);
    let path = if slash < after.len() {
        after[slash..].to_string()
    } else {
        "/".into()
    };
    let (scheme, host, port) = parse_origin(&origin)?;
    Some((scheme, host, port, path))
}

pub fn handle(req: &Value, origins: &[String], allow_loopback: bool) -> Value {
    let url = req.get("url").and_then(Value::as_str).unwrap_or("");
    let method = req.get("method").and_then(Value::as_str).unwrap_or("GET");
    let body = req.get("body").and_then(Value::as_str).unwrap_or("");
    if body.len() > 65_536 {
        return json!({"status": "too-large", "reason": "request exceeds 64 KiB"});
    }
    let Some((scheme, host, port, path)) = url_parts(url) else {
        return json!({"status": "denied", "reason": "origin denied"});
    };
    let origin_ok = origins.iter().any(|granted| {
        parse_origin(granted).is_some_and(|(s, h, p)| s == scheme && h == host && p == port)
    });
    if !origin_ok {
        return json!({"status": "denied", "reason": "origin denied"});
    }
    let addrs = match (host.as_str(), port).to_socket_addrs() {
        Ok(a) => a.collect::<Vec<_>>(),
        Err(_) => {
            return json!({"status": "denied", "reason": "private or invalid DNS address denied"})
        }
    };
    if addrs.is_empty() {
        return json!({"status": "denied", "reason": "private or invalid DNS address denied"});
    }
    let first = addrs[0];
    let kind = classify_ip(first.ip());
    if kind != "public" && !(allow_loopback && kind == "loopback") {
        return json!({"status": "denied", "reason": "private or invalid DNS address denied"});
    }
    // Pin the first resolution; never ask DNS again. HTTP/1.0, no redirects.
    if scheme == "https" {
        return json!({"status": "denied", "reason": "https not offered in the helper broker yet"});
    }
    let mut stream = match TcpStream::connect_timeout(&first, Duration::from_millis(200)) {
        Ok(s) => s,
        Err(_) => return json!({"status": "timeout", "reason": "connect timeout"}),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let payload = format!(
        "{method} {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(payload.as_bytes()).is_err() {
        return json!({"status": "error", "reason": "write failed"});
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 262_144 {
                    return json!({"status": "too-large", "reason": "response exceeds 256 KiB"});
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    if text.starts_with("HTTP/1.") {
        if let Some(code) = text[8..]
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u16>().ok())
        {
            if is_http_redirect(code) {
                return json!({"status": "denied", "reason": "redirect denied"});
            }
            let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
            return json!({"status": "ok", "httpStatus": code, "body": body, "bytes": body.len()});
        }
    }
    json!({"status": "ok", "httpStatus": 200, "body": text, "bytes": text.len()})
}
