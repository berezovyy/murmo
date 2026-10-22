//! Network, listing and git brokers in the helper (C3, E6).
//! Live HTTP is skipped inside the offline sandbox (deny network*); origin,
//! redirect-status and loopback checks stay.

use murmo_plugin_host::listing;
use murmo_plugin_host::network;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

#[test]
fn network_denies_another_origin_and_redirects() {
    let denied = network::handle(
        &json!({"url": "http://other.test/"}),
        &["http://allowed.test:80".into()],
        true,
    );
    assert_eq!(denied["status"], "denied");
    let spoof = network::handle(
        &json!({"url": "http://allowed.test@other.test/"}),
        &["http://allowed.test:80".into()],
        true,
    );
    assert_eq!(spoof["status"], "denied");
    let loopback = network::handle(
        &json!({"url": "http://127.0.0.1/"}),
        &["http://127.0.0.1:80".into()],
        false,
    );
    assert_eq!(loopback["status"], "denied");
    assert!(network::is_http_redirect(301));
    assert!(network::is_http_redirect(302));
    assert!(!network::is_http_redirect(200));

    // Live 302 follow is only possible when loopback bind is allowed.
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 256];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.0 302 Found\r\nLocation: http://other.test/\r\n\r\n");
            }
        });
        let origin = format!("http://127.0.0.1:{port}");
        let redirect = network::handle(&json!({"url": format!("{origin}/")}), &[origin], true);
        assert_eq!(redirect["status"], "denied", "{redirect}");
        assert!(redirect["reason"]
            .as_str()
            .unwrap_or("")
            .contains("redirect"));
    }
}

#[test]
fn listing_pages_a_small_tree() {
    let dir = std::env::temp_dir().join(format!("murmo-list-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/a.ts"), "a").unwrap();
    std::fs::write(dir.join(".gitignore"), "ignored\n").unwrap();
    std::fs::write(dir.join("ignored"), "x").unwrap();
    let page = listing::handle(dir.to_str().unwrap(), &json!({"offset": 0, "limit": 10}));
    assert_eq!(page["status"], "ok", "{page}");
    let entries = page["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["path"] == "src/a.ts"));
    let _ = std::fs::remove_dir_all(&dir);
}
