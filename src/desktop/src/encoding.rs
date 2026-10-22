//! RFC 4648 Base64 encoders and the strict base64url decoder the shell needs; small enough
//! that a codec crate would only add supply-chain surface.

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk
            .iter()
            .enumerate()
            .fold(0u32, |group, (index, byte)| group | (u32::from(*byte) << (16 - 8 * index)));
        for index in 0..=chunk.len() {
            encoded.push(char::from(alphabet[((group >> (18 - 6 * index)) & 0x3f) as usize]));
        }
        if pad {
            for _ in chunk.len()..3 {
                encoded.push('=');
            }
        }
    }
    encoded
}

/// RFC 4648 §5 base64url without padding.
pub fn base64url(bytes: &[u8]) -> String {
    encode(bytes, URL_SAFE, false)
}

/// RFC 4648 §4 standard Base64 with `=` padding (the master key format).
pub fn base64_padded(bytes: &[u8]) -> String {
    encode(bytes, STANDARD, true)
}

/// Decodes unpadded base64url. Rejects padding, foreign characters, impossible lengths and
/// non-zero trailing bits, so every byte string has exactly one accepted encoding.
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut decoded = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = URL_SAFE.iter().position(|candidate| *candidate == byte)?;
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    (buffer == 0).then_some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: [(&[u8], &str, &str); 7] = [
        (b"", "", ""),
        (b"f", "Zg", "Zg=="),
        (b"fo", "Zm8", "Zm8="),
        (b"foo", "Zm9v", "Zm9v"),
        (b"foob", "Zm9vYg", "Zm9vYg=="),
        (b"fooba", "Zm9vYmE", "Zm9vYmE="),
        (b"foobar", "Zm9vYmFy", "Zm9vYmFy"),
    ];

    #[test]
    fn encodes_rfc4648_vectors() {
        for (input, url, padded) in VECTORS {
            assert_eq!(base64url(input), url);
            assert_eq!(base64_padded(input), padded);
        }
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64_padded(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn decodes_what_it_encodes() {
        for (input, url, _) in VECTORS {
            assert_eq!(base64url_decode(url).as_deref(), Some(input));
        }
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(base64url_decode(&base64url(&all)), Some(all));
    }

    #[test]
    fn rejects_malformed_base64url() {
        for text in ["Zg==", "Zm9v+", "Zm9v/", "Z", "Zm9vY", "Zh", "Zm9", "Zm9 v"] {
            assert_eq!(base64url_decode(text), None, "{text}");
        }
    }

    #[test]
    fn padded_32_bytes_is_44_characters() {
        let encoded = base64_padded(&[0xff; 32]);
        assert_eq!(encoded.len(), 44);
        assert!(encoded.ends_with('='));
    }
}
