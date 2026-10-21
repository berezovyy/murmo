//! JSON-lines protocol: handshake, schemas, base64 assets, line size cap.

use serde_json::{json, Map, Value};

use crate::limits::{API_VERSION, ASSET_BYTES, MAX_LINE_BYTES, PROTOCOL, SOURCE_BYTES};

pub fn ready_message(pid: u32) -> Value {
    json!({
        "ready": true,
        "pid": pid,
        "protocol": PROTOCOL,
        "apiVersion": API_VERSION,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

pub fn hello_ok() -> Value {
    json!({
        "status": "ok",
        "protocol": PROTOCOL,
        "apiVersion": API_VERSION,
    })
}

pub fn protocol_mismatch(got: &Value) -> Value {
    json!({
        "status": "error",
        "kind": "transport",
        "error": format!(
            "protocol mismatch: helper speaks protocol {PROTOCOL} api {API_VERSION}, client sent {got}"
        ),
    })
}

/// True when the client handshake matches this binary.
pub fn hello_matches(q: &Value) -> bool {
    let protocol = q.get("protocol").and_then(Value::as_u64).unwrap_or(0);
    let api = q.get("apiVersion").and_then(Value::as_str).unwrap_or("");
    protocol == PROTOCOL as u64 && api == API_VERSION
}

pub fn line_too_large(len: usize) -> bool {
    len > MAX_LINE_BYTES
}

/// Decode one asset from the load payload: `{encoding:"base64", data:"..."}`
/// or a leftover JSON array of numbers (refused: use base64).
pub fn decode_asset(value: &Value) -> Result<Vec<u8>, String> {
    if let Some(obj) = value.as_object() {
        let encoding = obj
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("base64");
        if encoding != "base64" {
            return Err(format!("unsupported asset encoding {encoding}"));
        }
        let data = obj
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "asset data must be a base64 string".to_string())?;
        return decode_base64(data);
    }
    if value.as_array().is_some() {
        return Err("assets must be base64, not a JSON array of numbers".into());
    }
    Err("asset must be {encoding,data}".into())
}

pub fn decode_assets(value: Option<&Value>) -> Result<Vec<(String, Vec<u8>)>, String> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut total = 0usize;
    for (name, spec) in obj {
        let bytes = decode_asset(spec)?;
        total = total.saturating_add(bytes.len());
        if total > ASSET_BYTES {
            return Err(format!("assets exceed {ASSET_BYTES} bytes"));
        }
        out.push((name.clone(), bytes));
    }
    Ok(out)
}

pub fn source_of(q: &Value) -> Result<&str, String> {
    let source = q.get("source").and_then(Value::as_str).unwrap_or("");
    if source.len() > SOURCE_BYTES {
        return Err(format!("source exceeds {SOURCE_BYTES} bytes"));
    }
    Ok(source)
}

pub fn required_memory_mib(q: &Value) -> Result<u64, String> {
    q.get("memoryMiB")
        .or_else(|| q.get("memoryMb"))
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(|| "load refused: memoryMiB is required (no 32 MiB fallback)".into())
}

pub fn as_object(q: &Value) -> Option<&Map<String, Value>> {
    q.as_object()
}

/// RFC 4648 base64 (standard alphabet, optional padding).
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("invalid base64".into()),
        }
    }
    let bytes = input.as_bytes();
    if bytes.len() % 4 == 1 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut i = 0;
    while i < bytes.len() {
        let remaining = bytes.len() - i;
        if remaining == 0 {
            break;
        }
        let a = bytes[i];
        if a == b'=' {
            break;
        }
        let b = *bytes.get(i + 1).ok_or("invalid base64 length")?;
        let c = bytes.get(i + 2).copied().unwrap_or(b'=');
        let d = bytes.get(i + 3).copied().unwrap_or(b'=');
        let av = val(a)?;
        let bv = val(b)?;
        out.push((av << 2) | (bv >> 4));
        if c != b'=' {
            let cv = val(c)?;
            out.push((bv << 4) | (cv >> 2));
            if d != b'=' {
                let dv = val(d)?;
                out.push((cv << 6) | dv);
            }
        }
        i += 4;
    }
    Ok(out)
}

pub fn encode_base64(data: &[u8]) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = data.get(i + 1).copied();
        let b2 = data.get(i + 2).copied();
        out.push(ALPHA[(b0 >> 2) as usize] as char);
        out.push(ALPHA[(((b0 & 0x03) << 4) | (b1.unwrap_or(0) >> 4)) as usize] as char);
        match (b1, b2) {
            (Some(b1), Some(b2)) => {
                out.push(ALPHA[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
                out.push(ALPHA[(b2 & 0x3f) as usize] as char);
            }
            (Some(b1), None) => {
                out.push(ALPHA[((b1 & 0x0f) << 2) as usize] as char);
                out.push('=');
            }
            (None, _) => {
                out.push('=');
                out.push('=');
            }
        }
        i += 3;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_is_smaller_than_a_number_array() {
        // A 4 MiB asset as numbers is several times larger (E8).
        let data: Vec<u8> = (0..=255).collect();
        let encoded = encode_base64(&data);
        assert_eq!(decode_base64(&encoded).unwrap(), data);
        let as_numbers = serde_json::to_string(&data).unwrap();
        assert!(encoded.len() < as_numbers.len());
    }

    #[test]
    fn a_number_array_asset_is_refused() {
        let err = decode_asset(&json!([1, 2, 3])).unwrap_err();
        assert!(err.contains("base64"), "{err}");
    }

    #[test]
    fn load_without_memory_cap_is_refused() {
        assert!(required_memory_mib(&json!({"op":"load"})).is_err());
        assert_eq!(required_memory_mib(&json!({"memoryMiB": 8})).unwrap(), 8);
    }

    #[test]
    fn hello_rejects_a_mismatched_binary() {
        assert!(hello_matches(
            &json!({"protocol": 1, "apiVersion": "2.0.0"})
        ));
        assert!(!hello_matches(
            &json!({"protocol": 2, "apiVersion": "2.0.0"})
        ));
        assert!(!hello_matches(
            &json!({"protocol": 1, "apiVersion": "1.0.0"})
        ));
    }
}
