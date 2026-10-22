//! The bilibili login window. It shows passport.bilibili.com in its own
//! WebView2 profile, holds no capability and so gets no IPC; the trusted Rust side watches
//! its cookie store and hands the login cookies to the main WebView once. The main WebView
//! also keeps the minimal login set in its own cookie store, solely so the bilibili player
//! iframe shows the account; the shell clears it again on request.
//!
//! On Windows the shell writes and deletes those cookies through WebView2's cookie manager
//! itself. The `cookie` crate reports `Domain` without its leading dot and wry hands that on
//! to WebView2, which treats `bilibili.com` as host-only, so wry's cookie API would store a
//! cookie that neither player.bilibili.com nor api.bilibili.com receives, and could not delete
//! a real `.bilibili.com` cookie. Reading still goes through wry: the dot does not matter there.
//!
//! Cookie names and values are never logged and never written anywhere by the shell (shell.log
//! gets counts only); the profile directory is wiped before and after every attempt.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::webview::Cookie;
use tauri::webview::cookie::SameSite;
use tauri::webview::cookie::time::OffsetDateTime;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT, ICoreWebView2_2, ICoreWebView2CookieManager,
};
#[cfg(windows)]
use windows_core::{HSTRING, Interface};

const LABEL: &str = "bilibili-login";
const LOGIN_URL: &str = "https://passport.bilibili.com/login";
/// The cookies of this URL are what yt-dlp later sends to bilibili.
const COOKIE_URL: &str = "https://www.bilibili.com/";
const REQUIRED_COOKIES: [&str; 2] = ["SESSDATA", "bili_jct"];
const MAIN_LABEL: &str = "main";
/// The minimal login set the main WebView receives for the player iframe.
const PLAYER_COOKIES: [&str; 4] = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];
/// Where the self-check after a sync looks: the host the player iframe loads from, and the
/// host it calls for the account.
const PLAYER_URL: &str = "https://player.bilibili.com/";
const API_URL: &str = "https://api.bilibili.com/";
const SITE_DOMAIN: &str = "bilibili.com";
/// Where the player set is written, whatever domain the login window reported: bilibili sets
/// its login cookies here, and the player and API hosts are subdomains of it. The leading dot
/// is what makes WebView2 store a domain cookie rather than a host-only one.
#[cfg(windows)]
const PLAYER_COOKIE_DOMAIN: &str = ".bilibili.com";
/// How long the calling thread waits for the main thread to run a cookie-manager call.
#[cfg(windows)]
const COOKIE_MANAGER_WAIT: Duration = Duration::from_secs(5);
/// The site name, not UI copy: it reads the same in every language.
const TITLE: &str = "bilibili";
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How long to wait for the closed window's WebView to go away before wiping its profile.
const DESTROY_WAIT: Duration = Duration::from_secs(5);
/// The WebView2 browser process may hold profile files briefly after the window is gone.
const REMOVE_ATTEMPTS: u32 = 10;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Serialize)]
pub struct LoginCookies {
    cookies: String,
}

/// One line of a Netscape cookies.txt file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetscapeCookie {
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix seconds; 0 marks a session cookie.
    pub expires: i64,
    pub name: String,
    pub value: String,
}

impl NetscapeCookie {
    /// The `cookie` crate drops the leading dot of `Domain`, so host-only and domain cookies
    /// look alike. Every cookie is written as a domain cookie: bilibili sets its login cookies
    /// on `.bilibili.com`, and widening a host-only cookie to that host's subdomains is
    /// harmless for the requests yt-dlp makes.
    fn from_webview(cookie: &Cookie<'static>, fallback_host: &str) -> Self {
        let host = cookie.domain().unwrap_or(fallback_host).trim_start_matches('.');
        Self {
            domain: format!(".{host}"),
            path: path_of(cookie).to_owned(),
            secure: cookie.secure().unwrap_or(false),
            http_only: cookie.http_only().unwrap_or(false),
            expires: cookie.expires_datetime().map_or(0, |at| at.unix_timestamp().max(0)),
            name: cookie.name().to_owned(),
            value: cookie.value().to_owned(),
        }
    }
}

/// Netscape cookies.txt: a header line, then seven tab-separated fields per cookie with
/// `#HttpOnly_` marking http-only cookies; `includeSubdomains` is `TRUE` exactly when the
/// domain starts with a dot, as Python's cookie jar (used by yt-dlp) requires. Cookies whose
/// fields would break the line format are dropped.
pub fn format_netscape(cookies: &[NetscapeCookie]) -> String {
    let mut text = String::from("# Netscape HTTP Cookie File\n");
    let breaks_line = |field: &str| field.contains(['\t', '\r', '\n']);
    for cookie in cookies {
        if cookie.domain.is_empty()
            || cookie.name.is_empty()
            || [&cookie.domain, &cookie.path, &cookie.name, &cookie.value].into_iter().any(|field| breaks_line(field))
        {
            continue;
        }
        let flag = |value: bool| if value { "TRUE" } else { "FALSE" };
        text.push_str(&format!(
            "{}{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            if cookie.http_only { "#HttpOnly_" } else { "" },
            cookie.domain,
            flag(cookie.domain.starts_with('.')),
            cookie.path,
            flag(cookie.secure),
            cookie.expires,
            cookie.name,
            cookie.value
        ));
    }
    text
}

/// bilibili.com itself or one of its subdomains; a leading dot is ignored, and lookalikes
/// such as `notbilibili.com` do not match.
fn is_bilibili_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == SITE_DOMAIN || domain.ends_with(&format!(".{SITE_DOMAIN}"))
}

/// The cookie's domain without its leading dot, `None` when it has none.
fn domain_of<'a>(cookie: &'a Cookie<'_>) -> Option<&'a str> {
    cookie.domain().map(|domain| domain.trim_start_matches('.')).filter(|domain| !domain.is_empty())
}

/// Whether a login-window cookie belongs to the set the main WebView receives. The cookies
/// come from `COOKIE_URL`, so one without a domain is a www.bilibili.com cookie and stays.
fn is_player_cookie(cookie: &Cookie<'_>) -> bool {
    PLAYER_COOKIES.contains(&cookie.name()) && domain_of(cookie).is_none_or(is_bilibili_domain)
}

/// How many of the player cookie names are present with a value.
fn count_player_cookies(cookies: &[Cookie<'static>]) -> usize {
    PLAYER_COOKIES
        .iter()
        .filter(|name| cookies.iter().any(|cookie| cookie.name() == **name && !cookie.value().is_empty()))
        .count()
}

/// A domainless cookie gets the host it was read from: wry cannot store a cookie without a
/// domain, and on Windows that host is where an earlier sync may have left a copy.
fn with_domain(cookie: &Cookie<'static>, fallback_host: &str) -> Cookie<'static> {
    let mut cookie = cookie.clone();
    if domain_of(&cookie).is_none() {
        cookie.set_domain(fallback_host.to_owned());
    }
    cookie
}

/// The cookie's path, `/` when it has none.
fn path_of<'a>(cookie: &'a Cookie<'_>) -> &'a str {
    cookie.path().filter(|path| !path.is_empty()).unwrap_or("/")
}

/// The same cookie, already expired: storing it makes the cookie store drop the original.
#[cfg(not(windows))]
fn expired(cookie: &Cookie<'static>) -> Cookie<'static> {
    let mut cookie = cookie.clone();
    cookie.set_value("");
    cookie.set_max_age(None);
    cookie.set_expires(OffsetDateTime::UNIX_EPOCH);
    cookie
}

/// The domain and host-only spellings of a domain, `[".x", "x"]`: WebView2 matches a cookie's
/// domain exactly, so deleting a cookie whose form is unknown takes both.
#[cfg(windows)]
fn domain_forms(domain: &str) -> [String; 2] {
    let bare = domain.strip_prefix('.').unwrap_or(domain);
    [format!(".{bare}"), bare.to_owned()]
}

/// The host-only domains a player cookie may already sit on in the main WebView: wry wrote the
/// set there, without the leading dot, before the shell wrote it itself. Such a copy reaches
/// neither the player nor the API host but would linger in the store.
#[cfg(windows)]
fn stale_domains(cookie: &Cookie<'_>) -> Vec<String> {
    let [_, bare] = domain_forms(PLAYER_COOKIE_DOMAIN);
    let mut domains = vec![bare];
    if let Some(own) = domain_of(cookie).filter(|own| !domains.iter().any(|known| known == own)) {
        domains.push(own.to_owned());
    }
    domains
}

/// Unix seconds the cookie expires at, `None` for a session cookie; `Max-Age` wins over
/// `Expires`, as in wry's own conversion.
#[cfg(windows)]
fn expires_at(cookie: &Cookie<'_>, now: OffsetDateTime) -> Option<i64> {
    match cookie.max_age() {
        Some(max_age) => Some(now.saturating_add(max_age).unix_timestamp()),
        None => cookie.expires_datetime().map(|at| at.unix_timestamp()),
    }
}

/// Runs `work` against the main WebView's cookie manager on the main thread and waits for its
/// result. `None` when the WebView is gone, the manager is unavailable or the main thread does
/// not answer in time. Must not be called on the main thread, which would wait for itself.
#[cfg(windows)]
fn with_cookie_manager<T: Send + 'static>(
    main: &WebviewWindow,
    work: impl FnOnce(&ICoreWebView2CookieManager) -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = mpsc::channel();
    main.with_webview(move |webview| {
        // SAFETY: plain COM calls on interfaces the live WebView hands out, on its own thread.
        let manager = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| core.cast::<ICoreWebView2_2>())
            .and_then(|core| unsafe { core.CookieManager() });
        // A dropped sender ends the wait at once.
        if let Ok(manager) = manager {
            let _ = sender.send(work(&manager));
        }
    })
    .ok()?;
    receiver.recv_timeout(COOKIE_MANAGER_WAIT).ok()
}

/// Writes one player cookie as a domain cookie on `PLAYER_COOKIE_DOMAIN`, after dropping the
/// host-only copies an earlier sync may have left.
#[cfg(windows)]
fn store_on_player_domain(manager: &ICoreWebView2CookieManager, cookie: &Cookie<'static>) -> windows_core::Result<()> {
    let name = HSTRING::from(cookie.name());
    let path = HSTRING::from(path_of(cookie));
    // SAFETY: plain COM calls with live string arguments, on the WebView's thread.
    unsafe {
        for domain in stale_domains(cookie) {
            // Best effort: nothing to delete is the usual case.
            let _ = manager.DeleteCookiesWithDomainAndPath(&name, &HSTRING::from(domain), &path);
        }
        let created =
            manager.CreateCookie(&name, &HSTRING::from(cookie.value()), &HSTRING::from(PLAYER_COOKIE_DOMAIN), &path)?;
        if let Some(expires) = expires_at(cookie, OffsetDateTime::now_utc()) {
            created.SetExpires(expires as f64)?;
        }
        if let Some(http_only) = cookie.http_only() {
            created.SetIsHttpOnly(http_only)?;
        }
        if let Some(same_site) = cookie.same_site() {
            created.SetSameSite(match same_site {
                SameSite::Lax => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                SameSite::Strict => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                SameSite::None => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
            })?;
        }
        if let Some(secure) = cookie.secure() {
            created.SetIsSecure(secure)?;
        }
        manager.AddOrUpdateCookie(&created)
    }
}

/// Stores the player set in the main WebView; the number stored, `None` when unknown.
#[cfg(windows)]
fn store_player_cookies(main: &WebviewWindow, cookies: &[Cookie<'static>]) -> Option<usize> {
    let cookies = cookies.to_vec();
    with_cookie_manager(main, move |manager| {
        cookies.iter().filter(|cookie| store_on_player_domain(manager, cookie).is_ok()).count()
    })
}

#[cfg(not(windows))]
fn store_player_cookies(main: &WebviewWindow, cookies: &[Cookie<'static>]) -> Option<usize> {
    Some(cookies.iter().filter(|cookie| main.set_cookie((*cookie).clone()).is_ok()).count())
}

/// The main WebView's cookies on bilibili.com or one of its subdomains.
fn read_bilibili_cookies(main: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    let cookies = main.cookies().map_err(|error| format!("could not read the main window's cookies: {error}"))?;
    Ok(cookies.into_iter().filter(|cookie| domain_of(cookie).is_some_and(is_bilibili_domain)).collect())
}

/// Deletes the main WebView's bilibili cookies in both domain forms, since the domain read
/// back has lost its dot. The caller counts what remains.
#[cfg(windows)]
fn remove_bilibili_cookies(main: &WebviewWindow) -> Result<(), String> {
    let cookies = read_bilibili_cookies(main)?;
    let _ = with_cookie_manager(main, move |manager| {
        for cookie in &cookies {
            let Some(domain) = domain_of(cookie) else { continue };
            let name = HSTRING::from(cookie.name());
            let path = HSTRING::from(path_of(cookie));
            for form in domain_forms(domain) {
                // SAFETY: a plain COM call with live string arguments, on the WebView's thread.
                let _ = unsafe { manager.DeleteCookiesWithDomainAndPath(&name, &HSTRING::from(form), &path) };
            }
        }
    });
    Ok(())
}

#[cfg(not(windows))]
fn remove_bilibili_cookies(main: &WebviewWindow) -> Result<(), String> {
    for cookie in read_bilibili_cookies(main)? {
        let _ = main.delete_cookie(cookie);
    }
    // The cookie crate reports a domain cookie without its leading dot, so a delete may not
    // match the stored cookie; overwriting it with an expired copy removes what is left.
    for cookie in read_bilibili_cookies(main)? {
        let _ = main.set_cookie(expired(&cookie));
    }
    Ok(())
}

/// How many player cookie names the main WebView would send to `url`, as text for the log.
fn present_for(main: &WebviewWindow, url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| main.cookies_for_url(url).ok())
        .map_or_else(|| "unknown".to_owned(), |found| count_player_cookies(&found).to_string())
}

/// Appends a line to shell.log, in the supervisor's format. Messages carry counts only.
fn log(app: &AppHandle, message: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(dir.join("shell.log")) {
        let _ = writeln!(file, "{millis} {message}");
    }
}

/// Copies the minimal login set into the main WebView, then checks what the player's host
/// would receive. Runs on the login thread: the cookie APIs deadlock on the main thread on
/// Windows. A failure is logged and never fails the login, since yt-dlp gets its cookies
/// through the backend regardless.
fn sync_player_session(app: &AppHandle, cookies: &[Cookie<'static>], fallback_host: &str) {
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        log(app, "bilibili player session not synced: main window unavailable");
        return;
    };
    let kept: Vec<Cookie<'static>> =
        cookies.iter().filter(|cookie| is_player_cookie(cookie)).map(|cookie| with_domain(cookie, fallback_host)).collect();
    let stored = store_player_cookies(&main, &kept).map_or_else(|| "unknown".to_owned(), |stored| stored.to_string());
    // A cross-site iframe only receives cookies marked SameSite=None.
    let cross_site = kept.iter().filter(|cookie| cookie.same_site() == Some(SameSite::None)).count();
    let player = present_for(&main, PLAYER_URL);
    let api = present_for(&main, API_URL);
    let wanted = PLAYER_COOKIES.len();
    log(
        app,
        &format!(
            "bilibili player session synced: stored {stored} of {} cookies ({cross_site} SameSite=None); {player} of {wanted} present for the player, {api} of {wanted} for the API",
            kept.len()
        ),
    );
}

fn has_login(cookies: &[Cookie<'static>]) -> bool {
    REQUIRED_COOKIES
        .iter()
        .all(|required| cookies.iter().any(|cookie| cookie.name() == *required && !cookie.value().is_empty()))
}

/// Removes the profile directory, retrying while WebView2 still holds its files.
fn remove_profile(dir: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                attempt += 1;
                if attempt >= REMOVE_ATTEMPTS {
                    return Err(format!("could not remove the login profile: {error}"));
                }
                thread::sleep(REMOVE_RETRY_DELAY);
            }
        }
    }
}

fn wait_until(flag: &AtomicBool, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !flag.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
}

/// Watches the open login window and returns its cookies once logged in; runs on its own
/// thread because reading cookies from the main thread or a synchronous command deadlocks on
/// Windows (Tauri `Webview::cookies`).
fn watch(window: &tauri::WebviewWindow, url: &Url, destroyed: &AtomicBool) -> Result<Option<Vec<Cookie<'static>>>, String> {
    loop {
        thread::sleep(POLL_INTERVAL);
        if destroyed.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let cookies = match window.cookies_for_url(url.clone()) {
            Ok(cookies) => cookies,
            // The user closed the window between the check and the read.
            Err(_) if destroyed.load(Ordering::SeqCst) => return Ok(None),
            Err(error) => return Err(format!("could not read the login window's cookies: {error}")),
        };
        if has_login(&cookies) {
            return Ok(Some(cookies));
        }
    }
}

fn run(app: &AppHandle, profile: PathBuf) -> Result<Option<String>, String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_focus();
        return Err("the bilibili login window is already open".to_owned());
    }
    // Leftovers of a crashed attempt would otherwise log the user straight back in.
    remove_profile(&profile)?;
    let url = Url::parse(LOGIN_URL).map_err(|error| error.to_string())?;
    let cookie_url = Url::parse(COOKIE_URL).map_err(|error| error.to_string())?;
    let fallback_host = cookie_url.host_str().unwrap_or_default().to_owned();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title(TITLE)
        .inner_size(960.0, 720.0)
        .center()
        .data_directory(profile.clone())
        // Keep the remote page on the web; it has no business with local or custom schemes.
        .on_navigation(|url| matches!(url.scheme(), "https" | "http"))
        .build()
        .map_err(|error| format!("could not open the login window: {error}"))?;
    let destroyed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&destroyed);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            flag.store(true, Ordering::SeqCst);
        }
    });

    let outcome = watch(&window, &cookie_url, &destroyed).map(|login| {
        login.map(|cookies| {
            // Read, hand the player set to the main WebView, and only then wipe the login window.
            sync_player_session(app, &cookies, &fallback_host);
            let _ = window.clear_all_browsing_data();
            let lines: Vec<NetscapeCookie> =
                cookies.iter().map(|cookie| NetscapeCookie::from_webview(cookie, &fallback_host)).collect();
            format_netscape(&lines)
        })
    });
    if !destroyed.load(Ordering::SeqCst) {
        let _ = window.destroy();
        wait_until(&destroyed, DESTROY_WAIT);
    }
    drop(window);
    // Best effort: a profile that survives is wiped before the next attempt anyway.
    let _ = remove_profile(&profile);
    outcome
}

/// Opens the login window and resolves with Netscape cookies once `SESSDATA` and `bili_jct`
/// are present, or `None` when the user closes the window first.
#[tauri::command]
pub async fn open_bilibili_login(app: AppHandle) -> Result<Option<LoginCookies>, String> {
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data directory unavailable: {error}"))?
        .join("login-sessions")
        .join("bilibili");
    tauri::async_runtime::spawn_blocking(move || run(&app, profile))
        .await
        .map_err(|error| format!("login task failed: {error}"))?
        .map(|cookies| cookies.map(|cookies| LoginCookies { cookies }))
}

fn clear_player_session(app: &AppHandle) -> Result<(), String> {
    let main = app.get_webview_window(MAIN_LABEL).ok_or("the main window is unavailable")?;
    remove_bilibili_cookies(&main)?;
    let remaining = read_bilibili_cookies(&main)?.len();
    log(app, &format!("bilibili player session cleared: {remaining} bilibili cookies remain"));
    if remaining == 0 { Ok(()) } else { Err(format!("{remaining} bilibili cookies could not be removed")) }
}

/// Removes every bilibili cookie from the main WebView: after the account is removed, all
/// credentials are reset, or a fresh login could not be stored. All names
/// go, not only the synced set, since the player iframe may have set cookies of its own.
#[tauri::command]
pub async fn clear_bilibili_player_session(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clear_player_session(&app))
        .await
        .map_err(|error| format!("clear task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(domain: &str, name: &str, value: &str) -> NetscapeCookie {
        NetscapeCookie {
            domain: domain.to_owned(),
            path: "/".to_owned(),
            secure: false,
            http_only: false,
            expires: 0,
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    #[test]
    fn formats_netscape_cookies() {
        let cookies = [
            NetscapeCookie { secure: true, http_only: true, expires: 1_798_761_600, ..cookie(".example.com", "session", "fake-1") },
            cookie("www.example.com", "theme", "dark"),
            NetscapeCookie { path: "/app".to_owned(), secure: true, ..cookie(".example.com", "csrf", "fake%2C2") },
        ];
        assert_eq!(
            format_netscape(&cookies),
            "# Netscape HTTP Cookie File\n\
             #HttpOnly_.example.com\tTRUE\t/\tTRUE\t1798761600\tsession\tfake-1\n\
             www.example.com\tFALSE\t/\tFALSE\t0\ttheme\tdark\n\
             .example.com\tTRUE\t/app\tTRUE\t0\tcsrf\tfake%2C2\n"
        );
    }

    #[test]
    fn drops_cookies_that_would_break_the_format() {
        let cookies = [
            cookie(".example.com", "bad", "a\tb"),
            cookie(".example.com", "bad\nname", "x"),
            cookie("", "nodomain", "x"),
            cookie(".example.com", "", "x"),
            cookie(".example.com", "good", ""),
        ];
        assert_eq!(format_netscape(&cookies), "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tgood\t\n");
        assert_eq!(format_netscape(&[]), "# Netscape HTTP Cookie File\n");
    }

    #[test]
    fn converts_webview_cookies_to_domain_cookies() {
        let expires = tauri::webview::cookie::time::OffsetDateTime::from_unix_timestamp(1_798_761_600).unwrap();
        let built = Cookie::build(("SESSDATA", "fake-value"))
            .domain(".example.com")
            .path("/")
            .secure(true)
            .http_only(true)
            .expires(expires)
            .build();
        let line = NetscapeCookie::from_webview(&built, "www.example.com");
        assert_eq!(line.domain, ".example.com");
        assert!(line.secure && line.http_only);
        assert_eq!(line.expires, 1_798_761_600);

        let host_only = Cookie::build(("theme", "dark")).domain("www.example.com").build();
        let line = NetscapeCookie::from_webview(&host_only, "fallback.example.com");
        assert_eq!(line.domain, ".www.example.com");
        assert_eq!((line.path.as_str(), line.expires, line.secure), ("/", 0, false));

        let no_domain = Cookie::new("a", "b");
        assert_eq!(NetscapeCookie::from_webview(&no_domain, "www.example.com").domain, ".www.example.com");
    }

    #[test]
    fn requires_both_login_cookies() {
        let session = Cookie::new("SESSDATA", "fake");
        let csrf = Cookie::new("bili_jct", "fake");
        let other = Cookie::new("buvid3", "fake");
        assert!(!has_login(&[session.clone(), other.clone()]));
        assert!(!has_login(&[Cookie::new("SESSDATA", ""), csrf.clone()]));
        assert!(has_login(&[other, csrf, session]));
    }

    #[test]
    fn matches_bilibili_domains_only() {
        for domain in ["bilibili.com", ".bilibili.com", "www.bilibili.com", ".passport.bilibili.com", "Player.Bilibili.COM"] {
            assert!(is_bilibili_domain(domain), "{domain}");
        }
        for domain in ["", ".", "notbilibili.com", "bilibili.com.example.com", "example.com", "bilibili.cn"] {
            assert!(!is_bilibili_domain(domain), "{domain}");
        }
    }

    #[test]
    fn keeps_only_the_minimal_login_set_on_bilibili() {
        let on = |name: &str, domain: &str| Cookie::build((name.to_owned(), "fake")).domain(domain.to_owned()).build();
        for name in PLAYER_COOKIES {
            assert!(is_player_cookie(&on(name, ".bilibili.com")), "{name}");
            assert!(is_player_cookie(&on(name, "www.bilibili.com")), "{name}");
        }
        assert!(!is_player_cookie(&on("buvid3", ".bilibili.com")));
        assert!(!is_player_cookie(&on("sessdata", ".bilibili.com")));
        assert!(!is_player_cookie(&on("SESSDATA", ".example.com")));
        assert!(!is_player_cookie(&on("SESSDATA", "evilbilibili.com")));
        // Read from `COOKIE_URL`, so a cookie without a domain is a www.bilibili.com cookie.
        assert!(is_player_cookie(&Cookie::new("SESSDATA", "fake")));
        assert!(is_player_cookie(&on("bili_jct", "")));
    }

    #[test]
    fn gives_a_domainless_cookie_its_host() {
        let filled = with_domain(&Cookie::new("SESSDATA", "fake"), "www.bilibili.com");
        assert_eq!(filled.domain(), Some("www.bilibili.com"));
        let kept = with_domain(&Cookie::build(("SESSDATA", "fake")).domain(".bilibili.com").build(), "www.bilibili.com");
        assert_eq!(kept.domain(), Some("bilibili.com"));
    }

    #[test]
    fn counts_player_cookie_names_with_a_value() {
        let cookies = [
            Cookie::new("SESSDATA", "fake"),
            Cookie::new("SESSDATA", "fake"),
            Cookie::new("bili_jct", ""),
            Cookie::new("DedeUserID", "fake"),
            Cookie::new("buvid3", "fake"),
        ];
        assert_eq!(count_player_cookies(&cookies), 2);
        assert_eq!(count_player_cookies(&[]), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn expires_a_cookie_without_changing_its_identity() {
        let original = Cookie::build(("SESSDATA", "fake")).domain(".bilibili.com").path("/").secure(true).build();
        let gone = expired(&original);
        assert_eq!((gone.name(), gone.domain(), gone.path(), gone.value()), ("SESSDATA", Some("bilibili.com"), Some("/"), ""));
        assert_eq!(gone.expires_datetime(), Some(OffsetDateTime::UNIX_EPOCH));
        assert_eq!(gone.max_age(), None);
    }

    #[cfg(windows)]
    #[test]
    fn writes_the_player_set_as_a_bilibili_domain_cookie() {
        assert!(PLAYER_COOKIE_DOMAIN.starts_with('.'));
        assert!(is_bilibili_domain(PLAYER_COOKIE_DOMAIN));
        for url in [PLAYER_URL, API_URL] {
            let host = Url::parse(url).unwrap().host_str().unwrap().to_owned();
            assert!(host.ends_with(PLAYER_COOKIE_DOMAIN), "{host}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn spells_a_domain_both_ways() {
        let both = [".bilibili.com".to_owned(), "bilibili.com".to_owned()];
        assert_eq!(domain_forms("bilibili.com"), both);
        assert_eq!(domain_forms(".bilibili.com"), both);
        assert_eq!(domain_forms("www.bilibili.com"), [".www.bilibili.com".to_owned(), "www.bilibili.com".to_owned()]);
    }

    #[cfg(windows)]
    #[test]
    fn finds_the_host_only_copies_an_earlier_sync_left() {
        let on = |domain: &str| Cookie::build(("SESSDATA", "fake")).domain(domain.to_owned()).build();
        assert_eq!(stale_domains(&on(".bilibili.com")), ["bilibili.com"]);
        assert_eq!(stale_domains(&on("bilibili.com")), ["bilibili.com"]);
        assert_eq!(stale_domains(&on("www.bilibili.com")), ["bilibili.com", "www.bilibili.com"]);
        assert_eq!(stale_domains(&Cookie::new("SESSDATA", "fake")), ["bilibili.com"]);
    }

    #[cfg(windows)]
    #[test]
    fn takes_the_expiry_from_max_age_first() {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let at = OffsetDateTime::from_unix_timestamp(1_798_761_600).unwrap();
        let max_age = tauri::webview::cookie::time::Duration::seconds(60);
        let both = Cookie::build(("SESSDATA", "fake")).max_age(max_age).expires(at).build();
        assert_eq!(expires_at(&both, now), Some(1_700_000_060));
        assert_eq!(expires_at(&Cookie::build(("SESSDATA", "fake")).expires(at).build(), now), Some(1_798_761_600));
        assert_eq!(expires_at(&Cookie::new("SESSDATA", "fake"), now), None);
    }

    #[test]
    fn removing_a_missing_profile_succeeds() {
        assert!(remove_profile(&std::env::temp_dir().join("amber-no-such-login-profile")).is_ok());
    }
}
