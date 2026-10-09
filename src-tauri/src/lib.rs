use chrono::{Local, Timelike};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use url::form_urlencoded;

// ============= 跨平台空闲检测 =============

/// 获取系统空闲时间（秒）
/// Windows: 使用 GetLastInputInfo
/// macOS: 使用 CGEventSourceSecondsSinceLastEventType
/// Linux: 使用 X11 screensaver extension
fn get_idle_seconds() -> u64 {
    #[cfg(target_os = "windows")]
    {
        get_idle_seconds_windows()
    }

    #[cfg(target_os = "macos")]
    {
        get_idle_seconds_macos()
    }

    #[cfg(target_os = "linux")]
    {
        get_idle_seconds_linux()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        0 // 不支持的平台返回 0
    }
}

#[cfg(target_os = "windows")]
fn get_idle_seconds_windows() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };

        if GetLastInputInfo(&mut lii).as_bool() {
            let current_tick = GetTickCount();
            let idle_ms = current_tick.wrapping_sub(lii.dwTime);
            (idle_ms / 1000) as u64
        } else {
            0
        }
    }
}

#[cfg(target_os = "macos")]
fn get_idle_seconds_macos() -> u64 {
    use std::process::Command;

    // 使用 ioreg 命令获取空闲时间（更可靠的方式）
    let output = Command::new("ioreg").args(["-c", "IOHIDSystem"]).output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // 查找 HIDIdleTime 字段
        for line in stdout.lines() {
            if line.contains("HIDIdleTime") {
                // 格式: "HIDIdleTime" = 1234567890
                if let Some(value) = line.split('=').nth(1) {
                    if let Ok(ns) = value.trim().parse::<u64>() {
                        return ns / 1_000_000_000; // 纳秒转秒
                    }
                }
            }
        }
    }
    0
}

#[cfg(target_os = "linux")]
fn get_idle_seconds_linux() -> u64 {
    use std::ptr;
    use x11::xlib::{XCloseDisplay, XDefaultRootWindow, XOpenDisplay};
    use x11::xss::{XScreenSaverAllocInfo, XScreenSaverQueryInfo};

    unsafe {
        let display = XOpenDisplay(ptr::null());
        if display.is_null() {
            return 0;
        }

        let info = XScreenSaverAllocInfo();
        if info.is_null() {
            XCloseDisplay(display);
            return 0;
        }

        let root = XDefaultRootWindow(display);
        let result = XScreenSaverQueryInfo(display, root, info);

        let idle_ms = if result != 0 { (*info).idle } else { 0 };

        x11::xlib::XFree(info as *mut _);
        XCloseDisplay(display);

        (idle_ms / 1000) as u64
    }
}

struct TrayState(Mutex<Option<TrayIcon>>);

struct LockStateInner {
    windows: Vec<String>,
    args: Option<LockTaskArgs>,
    active: bool,
    generation: u64,
}
struct LockState(Mutex<LockStateInner>);

type MonitorGeometry = (i32, i32, u32, u32);

fn monitor_geometry(monitor: &tauri::Monitor) -> MonitorGeometry {
    (
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
    )
}

/// 两块矩形相交的面积。
fn intersection_area(a: MonitorGeometry, b: MonitorGeometry) -> u64 {
    let a_right = a.0.saturating_add(a.2 as i32);
    let a_bottom = a.1.saturating_add(a.3 as i32);
    let b_right = b.0.saturating_add(b.2 as i32);
    let b_bottom = b.1.saturating_add(b.3 as i32);
    let width = (a_right.min(b_right) - a.0.max(b.0)).max(0) as u64;
    let height = (a_bottom.min(b_bottom) - a.1.max(b.1)).max(0) as u64;
    width * height
}

/// 这块矩形主要落在哪块显示器上。
///
/// **绝对不要退回"窗口左上角 == 显示器原点"这种判定。** 这里以前就是那么比的，
/// 而那是一个必现的 bug 源头：主窗口是**居中**的，在 3024×1964 的内建屏上落在
/// (762, 200) 附近，永远不可能等于 (0, 0)。于是锁屏看门狗每次都判定
/// "没有任何显示器被覆盖"，接着给同一块屏再建一个全屏副屏窗口，下一轮又量不到
/// 它、把它关掉、再建一个 —— 每秒一次。用户看到的是"一个白屏窗口反复冒出来，
/// 然后又切回锁屏"，整台机器没法用。单显示器机器上必然复现。
///
/// 取相交面积最大的那块；完全不相交时（原生全屏下窗口坐标可能整个跑到屏幕外）
/// 退回"中心点最近"的那块。**必须总是能归属到某一块屏幕**：返回 None 就等于
/// "这个窗口哪块屏都不属于"，而那正是把窗口反复关掉重建的起因。
fn monitor_for_rect(
    monitors: &[tauri::Monitor],
    rect: MonitorGeometry,
) -> Option<MonitorGeometry> {
    if monitors.is_empty() {
        return None;
    }

    let mut best: Option<(u64, MonitorGeometry)> = None;
    for monitor in monitors {
        let geometry = monitor_geometry(monitor);
        let area = intersection_area(rect, geometry);
        if area == 0 {
            continue;
        }
        if best.is_none_or(|(best_area, _)| area > best_area) {
            best = Some((area, geometry));
        }
    }
    if let Some((_, geometry)) = best {
        return Some(geometry);
    }

    // 中心点乘 2 是为了用整数比较距离，不必开方
    let rect_cx = rect.0 as i64 * 2 + rect.2 as i64;
    let rect_cy = rect.1 as i64 * 2 + rect.3 as i64;
    monitors
        .iter()
        .map(|monitor| {
            let geometry = monitor_geometry(monitor);
            let dx = (geometry.0 as i64 * 2 + geometry.2 as i64) - rect_cx;
            let dy = (geometry.1 as i64 * 2 + geometry.3 as i64) - rect_cy;
            (dx * dx + dy * dy, geometry)
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, geometry)| geometry)
}

fn window_rect(window: &WebviewWindow) -> Option<MonitorGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some((position.x, position.y, size.width, size.height))
}

struct PauseMenuState(Mutex<Option<MenuItem<tauri::Wry>>>);

// 语言状态管理
struct LanguageState(Mutex<String>);

// 多语言文本
fn get_tray_text(key: &str, lang: &str) -> &'static str {
    match (key, lang) {
        ("quit", "en-US") => "Quit",
        ("quit", _) => "退出",
        ("show", "en-US") => "Show Main Window",
        ("show", _) => "显示主窗口",
        ("reset", "en-US") => "Reset All Tasks",
        ("reset", _) => "重置所有任务",
        ("pause", "en-US") => "Pause",
        ("pause", _) => "暂停",
        ("resume", "en-US") => "Resume",
        ("resume", _) => "继续",
        ("tooltip", "en-US") => "Hold On",
        ("tooltip", _) => "缓缓",
        ("reset_submenu", "en-US") => "Reset Single Task",
        ("reset_submenu", _) => "重置单个任务",
        ("reset_prefix", "en-US") => "Reset: ",
        ("reset_prefix", _) => "重置: ",
        ("restart", "en-US") => "Restart",
        ("restart", _) => "重启软件",
        // 默认任务标题翻译
        ("task_sit", "en-US") => "Stand Up Reminder",
        ("task_sit", _) => "久坐提醒",
        ("task_water", "en-US") => "Drink Water Reminder",
        ("task_water", _) => "喝水提醒",
        ("task_eye", "en-US") => "Eye Rest Reminder",
        ("task_eye", _) => "护眼提醒",
        _ => "",
    }
}

// 获取任务显示标题（默认任务使用翻译，自定义任务使用原标题）
fn get_task_display_title<'a>(
    task_id: &str,
    original_title: &'a str,
    lang: &str,
) -> std::borrow::Cow<'a, str> {
    match task_id {
        "sit" => std::borrow::Cow::Borrowed(get_tray_text("task_sit", lang)),
        "water" => std::borrow::Cow::Borrowed(get_tray_text("task_water", lang)),
        "eye" => std::borrow::Cow::Borrowed(get_tray_text("task_eye", lang)),
        _ => std::borrow::Cow::Borrowed(original_title),
    }
}

// ============= 后端定时器系统 =============

fn default_schedule_type() -> String {
    "interval".to_string()
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct TaskConfig {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub interval: u64, // 分钟
    pub enabled: bool,
    pub icon: String,
    #[serde(default)]
    pub auto_reset_on_idle: bool, // 空闲时自动重置
    #[serde(default = "default_schedule_type")]
    pub schedule_type: String,
    #[serde(default)]
    pub daily_times: Vec<String>,
}

#[derive(Clone, Debug)]
struct TaskTimer {
    config: TaskConfig,
    reset_time: Instant,
    triggered: bool,              // 本轮是否已触发
    disabled_at: Option<Instant>, // 禁用时的时间点，用于计算暂停时长
    snoozed: bool,                // 是否处于推迟状态
    snooze_count: u32,            // 当前已推迟次数
    daily_last_trigger_key: Option<String>,
    frozen_remaining: Option<u64>,
    frozen_total: Option<u64>,
    reset_during_lock: bool,
}

struct TimerState {
    tasks: HashMap<String, TaskTimer>,
    pending_triggers: Vec<TaskTriggeredPayload>,
    paused: bool,
    pause_start: Option<Instant>,
    system_locked: bool,
    lock_screen_active: bool,
    lock_screen_start: Option<Instant>, // 锁屏开始时间，用于补偿
    // 空闲检测相关
    idle_threshold_seconds: u64, // 空闲阈值（秒），默认 300 秒 = 5 分钟
    is_idle: bool,               // 当前是否处于空闲状态
    idle_start: Option<Instant>, // 进入空闲状态的时间点
    idle_start_timestamp: Option<i64>, // Unix 时间戳（毫秒）
}

impl TimerState {
    fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            pending_triggers: Vec::new(),
            paused: false,
            pause_start: None,
            system_locked: false,
            lock_screen_active: false,
            lock_screen_start: None,
            idle_threshold_seconds: 300, // 默认 5 分钟
            is_idle: false,
            idle_start: None,
            idle_start_timestamp: None,
        }
    }
}

static TIMER_STATE: std::sync::OnceLock<Mutex<TimerState>> = std::sync::OnceLock::new();

fn get_timer_state() -> &'static Mutex<TimerState> {
    TIMER_STATE.get_or_init(|| Mutex::new(TimerState::new()))
}

/// 强制锁是否正在进行。退出拦截用它决定要不要放行。
///
/// 两个标志位都要看：`LockState.active` 由 `enter_lock_mode` 置位（同时启动焦点守护），
/// `TimerState.lock_screen_active` 由前端 `timer_set_lock_screen_active` 置位（同时启用
/// watchdog 的显示器 heal）。正常锁屏期间两者都为真，但崩溃恢复等路径下可能只有其一，
/// 任一为真就说明"用户此刻被锁着"，不许退出。
///
/// 注意：两个锁**依次**获取，不嵌套持有，避免与 watchdog 线程里的加锁顺序互相咬住。
fn is_lock_active(app: &tauri::AppHandle) -> bool {
    if app.state::<LockState>().0.lock().unwrap().active {
        return true;
    }
    get_timer_state().lock().unwrap().lock_screen_active
}

fn enqueue_pending_trigger(state: &mut TimerState, payload: &TaskTriggeredPayload) {
    if !state
        .pending_triggers
        .iter()
        .any(|pending| pending.id == payload.id)
    {
        state.pending_triggers.push(payload.clone());
    }
}

fn clear_pending_trigger(state: &mut TimerState, task_id: &str) {
    state
        .pending_triggers
        .retain(|pending| pending.id != task_id);
}

fn is_daily_task(task: &TaskConfig) -> bool {
    task.schedule_type == "daily" && !task.daily_times.is_empty()
}

fn parse_daily_time(value: &str) -> Option<(u32, u32)> {
    let trimmed = value.trim();
    let mut parts = trimmed.split(':');
    let hour = parts.next()?.parse::<u32>().ok()?;
    let minute = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

fn current_daily_trigger_key(task: &TaskConfig) -> Option<String> {
    if !is_daily_task(task) {
        return None;
    }

    let now = Local::now();
    for value in &task.daily_times {
        if let Some((hour, minute)) = parse_daily_time(value) {
            if now.hour() == hour && now.minute() == minute {
                return Some(format!(
                    "{}:{:02}:{:02}",
                    now.format("%Y-%m-%d"),
                    hour,
                    minute
                ));
            }
        }
    }
    None
}

fn daily_remaining_seconds(task: &TaskConfig) -> u64 {
    let now = Local::now();
    let now_secs = now.hour() * 3600 + now.minute() * 60 + now.second();
    let mut best: Option<u32> = None;

    for value in &task.daily_times {
        if let Some((hour, minute)) = parse_daily_time(value) {
            let target_secs = hour * 3600 + minute * 60;
            let remaining = if target_secs >= now_secs {
                target_secs - now_secs
            } else {
                24 * 3600 - now_secs + target_secs
            };
            best = Some(best.map_or(remaining, |current| current.min(remaining)));
        }
    }

    best.unwrap_or(task.interval.saturating_mul(60) as u32) as u64
}

fn calculate_timer_countdown(
    timer: &TaskTimer,
    effective_now: Instant,
    live_daily: bool,
) -> (u64, u64, u64) {
    let is_daily = is_daily_task(&timer.config);
    let mut total_secs = if is_daily {
        24 * 60 * 60
    } else {
        timer.config.interval * 60
    };

    let remaining = if timer.snoozed {
        total_secs = timer
            .reset_time
            .checked_duration_since(effective_now)
            .map(|duration| duration.as_secs().max(1))
            .unwrap_or(1);
        timer
            .reset_time
            .checked_duration_since(effective_now)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    } else if is_daily {
        if live_daily {
            daily_remaining_seconds(&timer.config)
        } else {
            timer
                .reset_time
                .checked_duration_since(effective_now)
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
        }
    } else if timer.reset_time > effective_now {
        let wait_time = timer.reset_time.duration_since(effective_now).as_secs();
        total_secs + wait_time
    } else {
        let elapsed = effective_now
            .saturating_duration_since(timer.reset_time)
            .as_secs();
        total_secs.saturating_sub(elapsed)
    };

    let snooze_remaining = if timer.reset_time > effective_now {
        timer.reset_time.duration_since(effective_now).as_secs()
    } else {
        0
    };

    (remaining, total_secs, snooze_remaining)
}

fn freeze_timer_countdown(timer: &mut TaskTimer, now: Instant) {
    if !timer.config.enabled {
        return;
    }

    if timer.disabled_at.is_none() && !timer.snoozed && is_daily_task(&timer.config) {
        timer.reset_time = now + Duration::from_secs(daily_remaining_seconds(&timer.config));
    }

    let effective_now = timer.disabled_at.unwrap_or(now);
    let (remaining, total, _) = calculate_timer_countdown(timer, effective_now, false);
    timer.frozen_remaining = Some(remaining);
    timer.frozen_total = Some(total);
}

fn clear_timer_freeze(timer: &mut TaskTimer) {
    timer.frozen_remaining = None;
    timer.frozen_total = None;
}

fn freeze_active_timers(state: &mut TimerState, now: Instant) {
    for timer in state.tasks.values_mut() {
        freeze_timer_countdown(timer, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interval_timer(interval: u64, reset_time: Instant) -> TaskTimer {
        TaskTimer {
            config: TaskConfig {
                id: "sit".to_string(),
                title: "Stand Up".to_string(),
                desc: String::new(),
                interval,
                enabled: true,
                icon: "clock".to_string(),
                auto_reset_on_idle: true,
                schedule_type: "interval".to_string(),
                daily_times: Vec::new(),
            },
            reset_time,
            triggered: false,
            disabled_at: None,
            snoozed: false,
            snooze_count: 0,
            daily_last_trigger_key: None,
            frozen_remaining: None,
            frozen_total: None,
            reset_during_lock: false,
        }
    }

    #[test]
    fn frozen_interval_remaining_does_not_drift() {
        let now = Instant::now();
        let mut timer = interval_timer(45, now - Duration::from_secs(60));

        freeze_timer_countdown(&mut timer, now);
        timer.disabled_at = Some(now);

        let frozen_remaining = timer.frozen_remaining.unwrap();
        let later = now + Duration::from_secs(300);
        let reported_remaining = timer
            .frozen_remaining
            .unwrap_or_else(|| calculate_timer_countdown(&timer, later, false).0);

        assert_eq!(frozen_remaining, 44 * 60);
        assert_eq!(reported_remaining, frozen_remaining);
    }

    #[test]
    fn idle_reset_freezes_full_interval() {
        let now = Instant::now();
        let mut timer = interval_timer(45, now);

        freeze_timer_countdown(&mut timer, now);

        assert_eq!(timer.frozen_remaining, Some(45 * 60));
        assert_eq!(timer.frozen_total, Some(45 * 60));
    }

    #[test]
    fn lock_exit_does_not_compensate_a_task_reset_during_lock() {
        let lock_start = Instant::now();
        let mut state = TimerState::new();
        state.tasks.insert(
            "before-lock".to_string(),
            interval_timer(20, lock_start - Duration::from_secs(5)),
        );
        let mut during_lock = interval_timer(20, lock_start + Duration::from_secs(1));
        during_lock.reset_during_lock = true;
        state.tasks.insert("during-lock".to_string(), during_lock);

        compensate_lock_screen_timers(&mut state, Duration::from_secs(60), false);

        assert_eq!(
            state.tasks["before-lock"].reset_time,
            lock_start - Duration::from_secs(5) + Duration::from_secs(60)
        );
        assert_eq!(
            state.tasks["during-lock"].reset_time,
            lock_start + Duration::from_secs(1)
        );
    }

    #[test]
    fn pending_triggers_are_deduplicated_and_acknowledged_by_task() {
        let mut state = TimerState::new();
        let sit_payload = TaskTriggeredPayload {
            id: "sit".to_string(),
            title: "Stand Up".to_string(),
            desc: String::new(),
            icon: "clock".to_string(),
        };
        let eye_payload = TaskTriggeredPayload {
            id: "eye".to_string(),
            title: "Eye Rest".to_string(),
            desc: String::new(),
            icon: "eye".to_string(),
        };

        enqueue_pending_trigger(&mut state, &sit_payload);
        enqueue_pending_trigger(&mut state, &sit_payload);
        enqueue_pending_trigger(&mut state, &eye_payload);

        assert_eq!(state.pending_triggers.len(), 2);

        clear_pending_trigger(&mut state, "sit");

        assert_eq!(state.pending_triggers.len(), 1);
        assert_eq!(state.pending_triggers[0].id, "eye");
    }

    #[test]
    fn media_pause_mode_defaults_to_none() {
        assert_eq!(parse_media_pause_mode(None), MediaPauseMode::None);
        assert_eq!(
            parse_media_pause_mode(Some("unexpected")),
            MediaPauseMode::None
        );
    }

    #[test]
    fn media_pause_mode_all_requires_explicit_value() {
        assert_eq!(parse_media_pause_mode(Some("all")), MediaPauseMode::All);
    }

    #[test]
    fn media_pause_mode_video_requires_explicit_value() {
        assert_eq!(parse_media_pause_mode(Some("video")), MediaPauseMode::Video);
    }
}

#[cfg(target_os = "windows")]
static SYSTEM_LOCKED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
fn start_session_monitor(app_handle: tauri::AppHandle) {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage,
        CS_HREDRAW, CS_VREDRAW, MSG, WINDOW_EX_STYLE, WM_WTSSESSION_CHANGE, WNDCLASSW,
        WS_OVERLAPPED,
    };

    const WTS_SESSION_LOCK: u32 = 0x7;
    const WTS_SESSION_UNLOCK: u32 = 0x8;

    std::thread::spawn(move || unsafe {
        let class_name = w!("DeskReminderSessionMonitor");

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(session_wnd_proc),
            hInstance: std::mem::zeroed(),
            lpszClassName: class_name,
            ..std::mem::zeroed()
        };

        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            PCWSTR::null(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            HWND::default(),
            None,
            None,
            None,
        )
        .unwrap_or(HWND::default());

        if !hwnd.0.is_null() {
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                if msg.message == WM_WTSSESSION_CHANGE {
                    let wparam = msg.wParam.0 as u32;
                    if wparam == WTS_SESSION_LOCK {
                        SYSTEM_LOCKED.store(true, Ordering::SeqCst);
                        let _ = app_handle.emit("system-locked", ());
                    } else if wparam == WTS_SESSION_UNLOCK {
                        SYSTEM_LOCKED.store(false, Ordering::SeqCst);
                        let _ = app_handle.emit("system-unlocked", ());
                    }
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    });
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn session_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::DefWindowProcW;
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
struct LockTaskArgs {
    title: String,
    desc: String,
    duration: i32,
    icon: String,
    // Slave context
    strict_mode: bool,
    allow_strict_snooze: bool,
    max_snooze_count: u32,
    snooze_minutes: u32,
    current_snooze_count: u32,
    #[serde(default)]
    bg_image: String,
}

// ============= 定时器命令 =============

#[derive(Clone, serde::Serialize)]
struct CountdownInfo {
    id: String,
    remaining: u64, // 剩余秒数
    total: u64,     // 总秒数
    enabled: bool,
    task_paused: bool,
    snoozed: bool,         // 是否推迟中
    snooze_remaining: u64, // 推迟剩余时间
    snooze_count: u32,     // 当前已推迟次数
}

#[derive(Clone, serde::Serialize)]
struct TaskTriggeredPayload {
    id: String,
    title: String,
    desc: String,
    icon: String,
}

fn rebuild_tray_menu(app: &AppHandle) {
    let state = get_timer_state().lock().unwrap();
    let is_paused = state.paused;
    let mut tasks: Vec<TaskConfig> = state.tasks.values().map(|t| t.config.clone()).collect();
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    drop(state);

    // 获取当前语言
    let lang = app.state::<LanguageState>().0.lock().unwrap().clone();

    let quit = MenuItem::with_id(
        app,
        "quit",
        get_tray_text("quit", &lang),
        true,
        None::<&str>,
    )
    .unwrap();
    let restart = MenuItem::with_id(
        app,
        "restart",
        get_tray_text("restart", &lang),
        true,
        None::<&str>,
    )
    .unwrap();
    let show = MenuItem::with_id(
        app,
        "show",
        get_tray_text("show", &lang),
        true,
        None::<&str>,
    )
    .unwrap();
    let reset_all = MenuItem::with_id(
        app,
        "reset",
        get_tray_text("reset", &lang),
        true,
        None::<&str>,
    )
    .unwrap();
    let pause_text = if is_paused {
        get_tray_text("resume", &lang)
    } else {
        get_tray_text("pause", &lang)
    };
    let pause = MenuItem::with_id(app, "pause", pause_text, true, None::<&str>).unwrap();

    let reset_prefix = get_tray_text("reset_prefix", &lang);
    let mut reset_items = Vec::new();
    for task in tasks {
        let id = format!("reset_task_{}", task.id);
        let display_title = get_task_display_title(&task.id, &task.title, &lang);
        let title = format!("{}{}", reset_prefix, display_title);
        let item = MenuItem::with_id(app, &id, &title, true, None::<&str>).unwrap();
        reset_items.push(item);
    }

    let reset_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = reset_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let reset_submenu = Submenu::with_items(
        app,
        get_tray_text("reset_submenu", &lang),
        true,
        &reset_refs,
    )
    .unwrap();

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &pause,
            &reset_all,
            &reset_submenu,
            &restart,
            &quit,
        ],
    )
    .unwrap();

    let tray_state = app.state::<TrayState>();
    let guard = tray_state.0.lock().unwrap();
    if let Some(tray) = guard.as_ref() {
        let _ = tray.set_menu(Some(menu));
    }

    let pause_state = app.state::<PauseMenuState>();
    *pause_state.0.lock().unwrap() = Some(pause);
}

#[tauri::command]
fn sync_tasks(app: tauri::AppHandle, tasks: Vec<TaskConfig>) {
    {
        let mut state = get_timer_state().lock().unwrap();
        let now = Instant::now();
        let should_freeze_new_state =
            state.paused || state.system_locked || state.lock_screen_active || state.is_idle;

        // 保留现有任务的计时状态，只更新配置
        let mut new_tasks: HashMap<String, TaskTimer> = HashMap::new();

        for task in tasks {
            if let Some(existing) = state.tasks.get(&task.id) {
                // 任务已存在
                let interval_changed = existing.config.interval != task.interval
                    || existing.config.schedule_type != task.schedule_type
                    || existing.config.daily_times != task.daily_times;
                let was_disabled = !existing.config.enabled;
                let is_now_enabled = task.enabled;
                let was_enabled = existing.config.enabled;
                let is_now_disabled = !task.enabled;

                if interval_changed {
                    // interval 变了，重置计时
                    let task_id = task.id.clone();
                    let mut new_timer = TaskTimer {
                        config: task,
                        reset_time: now,
                        triggered: false,
                        disabled_at: None,
                        snoozed: false,
                        snooze_count: 0,
                        daily_last_trigger_key: None,
                        frozen_remaining: None,
                        frozen_total: None,
                        reset_during_lock: false,
                    };
                    if should_freeze_new_state {
                        freeze_timer_countdown(&mut new_timer, now);
                    }
                    new_tasks.insert(task_id, new_timer);
                } else if was_disabled && is_now_enabled {
                    // 从禁用变为启用，补偿禁用期间的时间
                    let mut new_reset_time = existing.reset_time;
                    if let Some(disabled_at) = existing.disabled_at {
                        let disabled_duration = now.duration_since(disabled_at);
                        new_reset_time += disabled_duration;
                    }
                    let task_id = task.id.clone();
                    let mut new_timer = TaskTimer {
                        config: task,
                        reset_time: new_reset_time,
                        triggered: existing.triggered,
                        disabled_at: None,
                        snoozed: existing.snoozed,
                        snooze_count: existing.snooze_count,
                        daily_last_trigger_key: existing.daily_last_trigger_key.clone(),
                        frozen_remaining: None,
                        frozen_total: None,
                        reset_during_lock: existing.reset_during_lock,
                    };
                    if should_freeze_new_state {
                        freeze_timer_countdown(&mut new_timer, now);
                    }
                    new_tasks.insert(task_id, new_timer);
                } else if was_enabled && is_now_disabled {
                    // 从启用变为禁用，记录禁用时间点
                    let task_id = task.id.clone();
                    let mut new_timer = TaskTimer {
                        config: task,
                        reset_time: existing.reset_time,
                        triggered: existing.triggered,
                        disabled_at: Some(now),
                        snoozed: existing.snoozed,
                        snooze_count: existing.snooze_count,
                        daily_last_trigger_key: existing.daily_last_trigger_key.clone(),
                        frozen_remaining: existing.frozen_remaining,
                        frozen_total: existing.frozen_total,
                        reset_during_lock: existing.reset_during_lock,
                    };
                    freeze_timer_countdown(&mut new_timer, now);
                    new_tasks.insert(task_id, new_timer);
                } else {
                    // 状态没变，保留
                    new_tasks.insert(
                        task.id.clone(),
                        TaskTimer {
                            config: task,
                            reset_time: existing.reset_time,
                            triggered: existing.triggered,
                            disabled_at: existing.disabled_at,
                            snoozed: existing.snoozed,
                            snooze_count: existing.snooze_count,
                            daily_last_trigger_key: existing.daily_last_trigger_key.clone(),
                            frozen_remaining: existing.frozen_remaining,
                            frozen_total: existing.frozen_total,
                            reset_during_lock: existing.reset_during_lock,
                        },
                    );
                }
            } else {
                // 新任务
                let task_id = task.id.clone();
                let mut new_timer = TaskTimer {
                    config: task.clone(),
                    reset_time: now,
                    triggered: false,
                    disabled_at: if task.enabled { None } else { Some(now) },
                    snoozed: false,
                    snooze_count: 0,
                    daily_last_trigger_key: None,
                    frozen_remaining: None,
                    frozen_total: None,
                    reset_during_lock: false,
                };
                if should_freeze_new_state {
                    freeze_timer_countdown(&mut new_timer, now);
                }
                new_tasks.insert(task_id, new_timer);
            }
        }

        state.tasks = new_tasks;
        let active_task_ids: HashSet<String> = state
            .tasks
            .iter()
            .filter(|(_, timer)| timer.config.enabled)
            .map(|(id, _)| id.clone())
            .collect();
        state
            .pending_triggers
            .retain(|pending| active_task_ids.contains(&pending.id));
    } // drop lock

    rebuild_tray_menu(&app);
}

#[tauri::command]
fn timer_pause() {
    let mut state = get_timer_state().lock().unwrap();
    if !state.paused {
        let now = Instant::now();
        freeze_active_timers(&mut state, now);
        state.paused = true;
        state.pause_start = Some(now);
    }
}

#[tauri::command]
fn timer_resume() {
    let mut state = get_timer_state().lock().unwrap();
    if state.paused {
        if let Some(pause_start) = state.pause_start {
            let pause_duration = pause_start.elapsed();
            let keep_frozen = state.system_locked || state.lock_screen_active || state.is_idle;
            // 补偿暂停时间
            for timer in state.tasks.values_mut() {
                timer.reset_time += pause_duration;
                // 如果任务被禁用，也需要同步更新 disabled_at，保持相对时间不变
                if let Some(ref mut disabled_at) = timer.disabled_at {
                    *disabled_at += pause_duration;
                } else if keep_frozen {
                    freeze_timer_countdown(timer, Instant::now());
                } else {
                    clear_timer_freeze(timer);
                }
            }
        }
        state.paused = false;
        state.pause_start = None;
    }
}

#[tauri::command]
fn timer_is_paused() -> bool {
    get_timer_state().lock().unwrap().paused
}

#[tauri::command]
fn timer_pause_task(task_id: String) {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    if let Some(timer) = state.tasks.get_mut(&task_id) {
        if timer.config.enabled && timer.disabled_at.is_none() {
            freeze_timer_countdown(timer, now);
            timer.disabled_at = Some(now);
        }
    }
}

#[tauri::command]
fn timer_resume_task(task_id: String) {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    let keep_frozen =
        state.paused || state.system_locked || state.lock_screen_active || state.is_idle;
    if let Some(timer) = state.tasks.get_mut(&task_id) {
        if timer.config.enabled {
            if let Some(disabled_at) = timer.disabled_at {
                let disabled_duration = now.duration_since(disabled_at);
                timer.reset_time += disabled_duration;
                timer.disabled_at = None;
                if keep_frozen {
                    freeze_timer_countdown(timer, now);
                } else {
                    clear_timer_freeze(timer);
                }
            }
        }
    }
}

#[tauri::command]
fn timer_reset_task(task_id: String) {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    let reset_during_lock = state.lock_screen_active;
    let should_freeze =
        state.paused || state.system_locked || state.lock_screen_active || state.is_idle;
    if let Some(timer) = state.tasks.get_mut(&task_id) {
        timer.reset_time = now;
        timer.reset_during_lock = reset_during_lock;
        timer.triggered = false;
        timer.snoozed = false;
        timer.snooze_count = 0;
        // 如果任务禁用，也更新 disabled_at
        if timer.disabled_at.is_some() {
            timer.disabled_at = Some(now);
            freeze_timer_countdown(timer, now);
        } else if should_freeze {
            freeze_timer_countdown(timer, now);
        } else {
            clear_timer_freeze(timer);
        }
    }
    clear_pending_trigger(&mut state, &task_id);
}

#[tauri::command]
fn timer_reset_all() {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    let reset_during_lock = state.lock_screen_active;
    let should_freeze =
        state.paused || state.system_locked || state.lock_screen_active || state.is_idle;
    for timer in state.tasks.values_mut() {
        timer.reset_time = now;
        timer.reset_during_lock = reset_during_lock;
        timer.triggered = false;
        timer.snoozed = false;
        timer.snooze_count = 0;
        // 如果任务禁用，也更新 disabled_at
        if timer.disabled_at.is_some() {
            timer.disabled_at = Some(now);
            freeze_timer_countdown(timer, now);
        } else if should_freeze {
            freeze_timer_countdown(timer, now);
        } else {
            clear_timer_freeze(timer);
        }
    }
    state.pending_triggers.clear();
}

#[tauri::command]
fn timer_snooze_task(task_id: String, minutes: u64) {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    let should_freeze =
        state.paused || state.system_locked || state.lock_screen_active || state.is_idle;
    if let Some(timer) = state.tasks.get_mut(&task_id) {
        let snooze_duration = Duration::from_secs(minutes * 60);
        timer.reset_time = now + snooze_duration;
        timer.reset_during_lock = false;

        timer.triggered = false;
        timer.snoozed = true;
        timer.snooze_count += 1;
        if should_freeze {
            freeze_timer_countdown(timer, now);
        } else {
            clear_timer_freeze(timer);
        }
    }
    clear_pending_trigger(&mut state, &task_id);
}

#[tauri::command]
fn get_countdowns() -> Vec<CountdownInfo> {
    let state = get_timer_state().lock().unwrap();
    let now = Instant::now();
    let frozen_now = if state.paused || state.system_locked {
        state.pause_start.unwrap_or(now)
    } else if state.lock_screen_active {
        state.lock_screen_start.unwrap_or(now)
    } else if state.is_idle {
        state.idle_start.unwrap_or(now)
    } else {
        now
    };
    let globally_frozen =
        state.paused || state.system_locked || state.lock_screen_active || state.is_idle;

    state
        .tasks
        .values()
        .map(|timer| {
            // 如果任务被禁用，使用禁用时间点计算 elapsed，这样时间就"冻结"了
            let effective_now = if let Some(disabled_at) = timer.disabled_at {
                disabled_at
            } else {
                frozen_now
            };

            let timer_frozen = globally_frozen || timer.disabled_at.is_some();
            let (remaining, total_secs, snooze_remaining) = if timer_frozen {
                if let (Some(remaining), Some(total)) = (timer.frozen_remaining, timer.frozen_total)
                {
                    let snooze_remaining = if timer.snoozed {
                        remaining
                    } else {
                        timer
                            .reset_time
                            .checked_duration_since(effective_now)
                            .map(|duration| duration.as_secs())
                            .unwrap_or(0)
                    };
                    (remaining, total, snooze_remaining)
                } else {
                    calculate_timer_countdown(timer, effective_now, false)
                }
            } else {
                calculate_timer_countdown(timer, effective_now, true)
            };

            CountdownInfo {
                id: timer.config.id.clone(),
                remaining,
                total: total_secs,
                enabled: timer.config.enabled,
                task_paused: timer.config.enabled && timer.disabled_at.is_some(),
                snoozed: timer.snoozed,
                snooze_remaining,
                snooze_count: timer.snooze_count,
            }
        })
        .collect()
}

#[tauri::command]
fn peek_triggered_tasks() -> Vec<TaskTriggeredPayload> {
    let state = get_timer_state().lock().unwrap();
    state.pending_triggers.clone()
}

#[tauri::command]
fn ack_triggered_task(task_id: String) {
    let mut state = get_timer_state().lock().unwrap();
    clear_pending_trigger(&mut state, &task_id);
}

#[tauri::command]
fn timer_set_system_locked(locked: bool) {
    let mut state = get_timer_state().lock().unwrap();
    let now = Instant::now();

    if locked && !state.system_locked {
        // 刚锁屏，记录暂停时间
        freeze_active_timers(&mut state, now);
        state.system_locked = true;
        if state.pause_start.is_none() {
            state.pause_start = Some(now);
        }
    } else if !locked && state.system_locked {
        // 解锁
        let pause_duration = state.pause_start.map(|s| s.elapsed());
        let keep_frozen = state.paused || state.lock_screen_active || state.is_idle;

        for timer in state.tasks.values_mut() {
            if timer.config.auto_reset_on_idle {
                // 勾选了"空闲重置"，直接重置为初始值
                timer.reset_time = now;
                timer.triggered = false;
                // 如果任务被禁用，也更新 disabled_at
                if timer.disabled_at.is_some() {
                    timer.disabled_at = Some(now);
                    freeze_timer_countdown(timer, now);
                } else if keep_frozen {
                    freeze_timer_countdown(timer, now);
                } else {
                    clear_timer_freeze(timer);
                }
            } else if let Some(duration) = pause_duration {
                // 没有勾选，补偿暂停时间
                timer.reset_time += duration;
                // 如果任务被禁用，也需要同步更新 disabled_at，保持相对时间不变
                if let Some(ref mut disabled_at) = timer.disabled_at {
                    *disabled_at += duration;
                } else if keep_frozen {
                    freeze_timer_countdown(timer, now);
                } else {
                    clear_timer_freeze(timer);
                }
            }
        }

        state.system_locked = false;
        if !state.paused {
            state.pause_start = None;
        }
    }
}

fn compensate_lock_screen_timers(
    state: &mut TimerState,
    lock_duration: Duration,
    keep_frozen: bool,
) {
    for timer in state.tasks.values_mut() {
        if timer.snoozed {
            continue;
        }
        // A task reset while the lock screen is active already has a reset
        // time relative to the end of the rest. Compensating it here would
        // add the rest duration to its next interval a second time.
        if !timer.reset_during_lock {
            timer.reset_time += lock_duration;
            if let Some(ref mut disabled_at) = timer.disabled_at {
                *disabled_at += lock_duration;
            }
        } else if let Some(ref mut disabled_at) = timer.disabled_at {
            // A disabled task reset during the lock keeps the reset point.
            *disabled_at = timer.reset_time;
        }
        timer.reset_during_lock = false;
        if timer.disabled_at.is_none() && keep_frozen {
            freeze_timer_countdown(timer, Instant::now());
        } else if timer.disabled_at.is_none() {
            clear_timer_freeze(timer);
        }
    }
}

// ============= 前端心跳看门狗（计划 §3.4 第 4 条） =============
//
// 前端在锁屏期间每秒调一次 `lock_heartbeat`。这只钟存在的唯一理由，是让 Rust
// 能发现"锁还在强制、渲染它的 webview 却已经死了"这种状态 —— 那时屏幕上没有
// 锁屏、没有闸门，而焦点守护还在抢焦点、lock.json 还写着 armed:true，
// 重启之后恢复出来的会是一个**没有任何出口**的锁。
//
// 关键取舍：发现心跳断了，**绝不静默解锁**（那等于"杀掉 webview 就逃掉了"）。
// 做法是重载 webview，让它走 boot → `get_pending_lock` → 恢复锁屏那条路
// 把自己接回来；这条路径是幂等的，冷启动恢复用的就是它。
//
// 用 `Instant` 而不是墙上时钟：这只钟只回答"多久没动静了"，往回拨系统时间骗不了它。
// （休息时长本身用的是墙上时钟，那是另一只钟，见 §3.3。）
/// 心跳状态。故意只用**一把**锁把两个字段装在一起：
/// 分成两把就得操心加锁顺序，而这段代码跑在每秒一次的热路径上，
/// 死锁在这里的代价是"强制还在、界面永远好不了"。
struct HeartbeatState {
    /// `None` = 本次强制还没收到过任何报活。处于这个状态时看门狗不判定。
    last: Option<Instant>,
    /// 本次强制已经重载过几次 webview，用来做退避
    reloads: u32,
}

static LOCK_HEARTBEAT: std::sync::OnceLock<Mutex<HeartbeatState>> = std::sync::OnceLock::new();

fn lock_heartbeat_state() -> &'static Mutex<HeartbeatState> {
    LOCK_HEARTBEAT.get_or_init(|| Mutex::new(HeartbeatState { last: None, reloads: 0 }))
}

/// 心跳超过这么久没来，就判定 webview 已死。
///
/// 前端是每秒一次，这里给 20 次机会。刻意给得很宽，是因为**误判的代价是自我放大的**：
/// 重载会重新走一遍 `enter_lock_mode`，也就是重来一次原生全屏的 Space 切换，
/// 而那次切换本身又会掐住 JS 好几秒。一次误判就能变成"白屏 ↔ 界面"来回切。
/// 宁可晚 20 秒才救一个真死的 webview（这期间锁照样在生效），
/// 也不要因为一次 Space 切换或一次页面冷启动就开枪。
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(20);
/// 重载之后的基础宽限。dev 模式下 vite 重新编译、webview 冷启动，
/// 都可能要几秒才开始报活，这段静默不能被误判成又一次死亡。
const HEARTBEAT_RELOAD_GRACE: Duration = Duration::from_secs(20);
/// 退避上限。webview 要是彻底回不来了（比如前端资源没了），
/// 就按上限的节奏一直重试 —— 重试很便宜，而"放弃"等于把用户锁在一个白屏上。
const HEARTBEAT_RETRY_CEILING: Duration = Duration::from_secs(60);

#[tauri::command]
fn lock_heartbeat() {
    lock_heartbeat_state().lock().unwrap().last = Some(Instant::now());
}

#[tauri::command]
fn timer_set_lock_screen_active(active: bool) {
    // 每次强制开始/结束都把心跳清空：`last: None` 的含义是"还没收到过报活"，
    // 处于这个状态时看门狗**不判定** —— 上锁途中前端还没开始心跳，
    // 那时动手会误伤（尤其是冷启动恢复，要读完 lock.json 才轮得到报活）。
    //
    // 反过来，上锁途中真死了也不会漏：`armed` 还是 false，
    // 下次启动读到它就走"死于半路"那条放行路径。
    {
        let mut hb = lock_heartbeat_state().lock().unwrap();
        hb.last = None;
        hb.reloads = 0;
    }

    let mut state = get_timer_state().lock().unwrap();
    if active && !state.lock_screen_active {
        // 刚进入锁屏模式，记录开始时间
        let now = Instant::now();
        freeze_active_timers(&mut state, now);
        state.lock_screen_active = true;
        state.lock_screen_start = Some(now);
    } else if !active && state.lock_screen_active {
        // 退出锁屏模式，补偿锁屏期间的时间
        let keep_frozen = state.paused || state.system_locked || state.is_idle;
        if let Some(lock_start) = state.lock_screen_start {
            let lock_duration = lock_start.elapsed();
            compensate_lock_screen_timers(&mut state, lock_duration, keep_frozen);
        }
        state.lock_screen_active = false;
        state.lock_screen_start = None;
    }
}

#[cfg(target_os = "windows")]
fn pause_playing_media_sessions_with_gsmtc(mode: MediaPauseMode) -> Result<bool, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Media::MediaPlaybackType;

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("failed to request media session manager: {e}"))?
        .get()
        .map_err(|e| format!("failed to get media session manager: {e}"))?;
    let sessions = manager
        .GetSessions()
        .map_err(|e| format!("failed to get media sessions: {e}"))?;
    let count = sessions
        .Size()
        .map_err(|e| format!("failed to count media sessions: {e}"))?;
    let mut paused_any = false;

    for index in 0..count {
        let Ok(session) = sessions.GetAt(index) else {
            continue;
        };
        let Ok(playback_info) = session.GetPlaybackInfo() else {
            continue;
        };
        if playback_info.PlaybackStatus().ok()
            != Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        {
            continue;
        }
        if mode == MediaPauseMode::Video {
            let playback_type = session
                .TryGetMediaPropertiesAsync()
                .and_then(|op| op.get())
                .and_then(|properties| properties.PlaybackType())
                .and_then(|playback_type| playback_type.Value())
                .ok();
            if playback_type != Some(MediaPlaybackType::Video) {
                continue;
            }
        }
        let pause_enabled = playback_info
            .Controls()
            .and_then(|controls| controls.IsPauseEnabled())
            .unwrap_or(true);
        if pause_enabled
            && session
                .TryPauseAsync()
                .and_then(|op| op.get())
                .unwrap_or(false)
        {
            paused_any = true;
        }
    }

    Ok(paused_any)
}

#[cfg(target_os = "windows")]
fn send_media_pause_app_command_to_window(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<bool, String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_APPCOMMAND,
    };

    const APPCOMMAND_MEDIA_PAUSE: isize = 47;
    const APPCOMMAND_LPARAM_SHIFT: usize = 16;

    let command = LPARAM(APPCOMMAND_MEDIA_PAUSE << APPCOMMAND_LPARAM_SHIFT);
    let mut result = 0usize;
    let sent = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_APPCOMMAND,
            WPARAM(0),
            command,
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut result),
        )
    };

    if sent.0 == 0 {
        Err("failed to send media pause app command".to_string())
    } else {
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
fn active_audio_process_ids() -> Result<HashSet<u32>, String> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    const RPC_E_CHANGED_MODE: i32 = 0x80010106u32 as i32;
    const ACTIVE_AUDIO_PEAK_THRESHOLD: f32 = 0.0001;

    let coinit = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let should_uninitialize = coinit.is_ok();
    if coinit.is_err() && coinit.0 != RPC_E_CHANGED_MODE {
        return Err(format!(
            "failed to initialize COM for audio sessions: {coinit:?}"
        ));
    }

    let result = unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("failed to create audio device enumerator: {e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("failed to get default audio endpoint: {e}"))?;
        let session_manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("failed to activate audio session manager: {e}"))?;
        let sessions = session_manager
            .GetSessionEnumerator()
            .map_err(|e| format!("failed to enumerate audio sessions: {e}"))?;
        let count = sessions
            .GetCount()
            .map_err(|e| format!("failed to count audio sessions: {e}"))?;
        let mut process_ids = HashSet::new();

        for index in 0..count {
            let Ok(session) = sessions.GetSession(index) else {
                continue;
            };
            if session.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let peak = session
                .cast::<IAudioMeterInformation>()
                .and_then(|meter| meter.GetPeakValue())
                .unwrap_or(0.0);
            if peak <= ACTIVE_AUDIO_PEAK_THRESHOLD {
                continue;
            }
            let Ok(session2) = session.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(process_id) = session2.GetProcessId() else {
                continue;
            };
            if process_id != 0 {
                process_ids.insert(process_id);
            }
        }

        Ok::<_, String>(process_ids)
    };

    if should_uninitialize {
        unsafe {
            CoUninitialize();
        }
    }

    result
}

#[cfg(target_os = "windows")]
fn lower_process_name(process_id: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), process_id) }.ok()?;
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    let query_result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if query_result.is_err() || len == 0 {
        return None;
    }

    let image_path = String::from_utf16_lossy(&buffer[..len as usize]);
    PathBuf::from(image_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
}

#[cfg(target_os = "windows")]
fn lower_window_text(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};

    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }

    let mut buffer = vec![0u16; len as usize + 1];
    let read = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if read <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..read as usize]).to_lowercase()
    }
}

#[cfg(target_os = "windows")]
fn lower_window_class(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buffer = vec![0u16; 256];
    let read = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if read <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..read as usize]).to_lowercase()
    }
}

#[cfg(target_os = "windows")]
fn looks_like_local_player(process_name: &str, title: &str, class_name: &str) -> bool {
    const PLAYER_PROCESS_MARKERS: &[&str] = &[
        "vlc",
        "potplayer",
        "mpv",
        "mpc-hc",
        "mpc-be",
        "wmplayer",
        "foobar2000",
        "musicbee",
        "aimp",
        "cloudmusic",
        "qqmusic",
        "yesplaymusic",
        "video.ui",
        "microsoft.media.player",
    ];
    const PLAYER_WINDOW_MARKERS: &[&str] = &[
        "vlc",
        "potplayer",
        "mpv",
        "media player",
        "windows media player",
        "foobar2000",
        "musicbee",
        "aimp",
        "网易云音乐",
        "qqmusic",
    ];

    PLAYER_PROCESS_MARKERS
        .iter()
        .any(|marker| process_name.contains(marker))
        || PLAYER_WINDOW_MARKERS
            .iter()
            .any(|marker| title.contains(marker) || class_name.contains(marker))
}

#[cfg(target_os = "windows")]
struct PlayerWindowSearch {
    active_process_ids: HashSet<u32>,
    windows: Vec<windows::Win32::Foundation::HWND>,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_active_local_player_windows(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindowVisible};

    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    let search = &mut *(lparam.0 as *mut PlayerWindowSearch);
    if !search.active_process_ids.contains(&process_id) {
        return BOOL(1);
    }

    let process_name = lower_process_name(process_id).unwrap_or_default();
    let title = lower_window_text(hwnd);
    let class_name = lower_window_class(hwnd);
    if looks_like_local_player(&process_name, &title, &class_name) {
        search.windows.push(hwnd);
    }

    BOOL(1)
}

#[cfg(target_os = "windows")]
fn find_active_local_player_windows(
    active_process_ids: HashSet<u32>,
) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    if active_process_ids.is_empty() {
        return Vec::new();
    }

    let mut search = PlayerWindowSearch {
        active_process_ids,
        windows: Vec::new(),
    };
    let _ = unsafe {
        EnumWindows(
            Some(enum_active_local_player_windows),
            LPARAM(&mut search as *mut PlayerWindowSearch as isize),
        )
    };
    search.windows
}

#[cfg(target_os = "windows")]
fn pause_active_local_player_windows() -> Result<bool, String> {
    let active_process_ids = active_audio_process_ids()?;
    let windows = find_active_local_player_windows(active_process_ids);
    let mut paused_any = false;

    for hwnd in windows {
        if send_media_pause_app_command_to_window(hwnd).unwrap_or(false) {
            paused_any = true;
        }
    }

    Ok(paused_any)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaPauseMode {
    None,
    Video,
    All,
}

fn parse_media_pause_mode(mode: Option<&str>) -> MediaPauseMode {
    match mode {
        Some("video") => MediaPauseMode::Video,
        Some("all") => MediaPauseMode::All,
        _ => MediaPauseMode::None,
    }
}

#[cfg(target_os = "windows")]
fn pause_playing_media_sessions_impl(mode: MediaPauseMode) -> Result<bool, String> {
    if mode == MediaPauseMode::None {
        return Ok(false);
    }

    let gsmtc_result = pause_playing_media_sessions_with_gsmtc(mode);
    if mode == MediaPauseMode::Video {
        return gsmtc_result;
    }

    let player_fallback_result = pause_active_local_player_windows();

    let paused_any = gsmtc_result.as_ref().copied().unwrap_or(false)
        || player_fallback_result.as_ref().copied().unwrap_or(false);

    if paused_any {
        Ok(true)
    } else {
        let errors: Vec<String> = [gsmtc_result.err(), player_fallback_result.err()]
            .into_iter()
            .flatten()
            .collect();
        if errors.is_empty() {
            Ok(false)
        } else {
            Err(errors.join("; "))
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn pause_playing_media_sessions_impl(_mode: MediaPauseMode) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn pause_playing_media_sessions(mode: Option<String>) -> Result<bool, String> {
    let mode = parse_media_pause_mode(mode.as_deref());
    pause_playing_media_sessions_impl(mode)
}

#[tauri::command]
fn set_idle_threshold(seconds: u64) {
    let mut state = get_timer_state().lock().unwrap();
    state.idle_threshold_seconds = seconds;
}

#[tauri::command]
fn get_idle_threshold() -> u64 {
    let state = get_timer_state().lock().unwrap();
    state.idle_threshold_seconds
}

// ============= 指纹 / 开机密码验证 =============

/// 验证机主身份：Touch ID，失败或不可用时系统自己给出「输入密码」的回退。
///
/// 只服务于一个场景 —— 把某个提醒的休息时长**往大改、且改完超过 10 分钟**。
/// 用 `LAPolicy::DeviceOwnerAuthentication` 而不是 `...WithBiometrics`：
/// 后者只认指纹、不给密码回退，对没有 Touch ID 的机器（外接键盘的 iMac、
/// 台式机）等于把设置项锁死。需求原话是「指纹或者电脑密码」，正是前者。
///
/// `Ok(false)` = 用户取消或验证失败，这是**正常结果**、不是错误，前端保持原值；
/// `Err` 只在压根拿不到结果时出现。
///
/// 非 macOS 直接 `Ok(true)`。这一版只发 macOS，别的平台没有对应原生 API，
/// 在那里把设置项锁死没有意义 —— 这是一处**刻意**的 fail-open，不是漏写。
#[cfg(target_os = "macos")]
#[tauri::command]
async fn authenticate(reason: String) -> Result<bool, String> {
    // 这一步会一直阻塞到用户在系统弹窗上作答，不能占着异步运行时的工作线程
    tauri::async_runtime::spawn_blocking(move || authenticate_macos(&reason))
        .await
        .map_err(|e| format!("验证任务异常: {e}"))?
}

#[cfg(target_os = "macos")]
fn authenticate_macos(reason: &str) -> Result<bool, String> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2::{msg_send, ClassType};
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<bool>();

    // `ctx` 必须在整个验证期间活着：提前析构会直接取消这次验证。
    // extern_class! 不生成 `new()`，所以走 msg_send。
    let ctx: Retained<LAContext> = unsafe { msg_send![LAContext::class(), new] };
    let reason = NSString::from_str(reason);

    // 取消失败都落进同一个回调，统一回 false —— 调用方不需要区分。
    let reply = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
        let _ = tx.send(ok.as_bool());
    });

    unsafe {
        ctx.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &reason,
            &reply,
        );
    }

    // 弹窗是异步回的。菜单栏「验证」没人理时不能把这个命令永久挂住 ——
    // 120 秒足够输完一次密码，超时按"没验证过"处理。
    rx.recv_timeout(Duration::from_secs(120))
        .map_err(|_| "等待验证结果超时".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn authenticate(_reason: String) -> Result<bool, String> {
    Ok(true)
}

/// 用系统默认浏览器打开一个链接。只服务于「检查更新发现新版」这一处。
///
/// 刻意不走 shell 插件：那要多开一份 `shell:allow-open` 权限，而这里只需要
/// 一个由前端拼好的 https 地址。入参来自前端，所以**必须**卡住协议 ——
/// 否则这个命令就等于一个"执行任意程序"的入口。
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开 http(s) 链接".to_string());
    }

    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";

    std::process::Command::new(opener)
        .arg(&url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打不开浏览器: {e}"))
}

#[derive(Clone, serde::Serialize)]
struct IdleStatus {
    is_idle: bool,
    idle_seconds: u64,
    threshold: u64,
    idle_start_timestamp: Option<i64>, // 空闲开始时间戳
}

fn enforce_main_lock_window(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    let _ = window.unminimize();
    if !window.is_focused().unwrap_or(false) {
        let _ = window.set_focus();
    }
    let _ = window.set_always_on_top(true);

    #[cfg(target_os = "linux")]
    {
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
    }
}

fn enforce_lock_slave_window(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    if !window.is_focused().unwrap_or(false) {
        let _ = window.set_focus();
    }
    let _ = window.set_always_on_top(true);

    #[cfg(target_os = "linux")]
    {
        let _ = window.set_fullscreen(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
    }
}

fn enforce_main_lock_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

fn run_lock_watchdog_on_main_thread(app: &AppHandle, heal_windows: bool) {
    let is_locked = get_timer_state().lock().unwrap().lock_screen_active;
    if !is_locked {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        enforce_main_lock_window(&window);
    }

    let (windows, args, generation, active) = {
        let lock_state = app.state::<LockState>();
        let guard = lock_state.0.lock().unwrap();
        (
            guard.windows.clone(),
            guard.args.clone(),
            guard.generation,
            guard.active,
        )
    };

    if !active {
        return;
    }

    for label in &windows {
        if let Some(window) = app.get_webview_window(label) {
            enforce_lock_slave_window(&window);
        }
    }

    if !heal_windows {
        return;
    }

    let Ok(monitors) = app.available_monitors() else {
        return;
    };

    // 只有一块（去重后）显示器时，整套副屏逻辑都不该跑 —— 一块屏不需要副屏，
    // 主窗口自己就盖满了。跑下去只会在同一块屏上再叠一个全屏窗口，
    // 两个 always_on_top 的全屏窗口互相抢焦点，用户看到的就是界面来回跳。
    //
    // 去重是必须的：镜像/复制屏会报告成多块几何完全相同的显示器。
    let mut distinct_geometries: Vec<MonitorGeometry> = Vec::new();
    for monitor in &monitors {
        let geometry = monitor_geometry(monitor);
        if !distinct_geometries.contains(&geometry) {
            distinct_geometries.push(geometry);
        }
    }

    if distinct_geometries.len() <= 1 {
        // 顺手清掉可能残留的副屏（比如之前插着副屏上过锁，现在拔了）
        if !windows.is_empty() {
            eprintln!("[lock] 只剩一块屏，清理 {} 个残留副屏窗口", windows.len());
            for label in &windows {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.close();
                }
            }
            let lock_state = app.state::<LockState>();
            let mut guard = lock_state.0.lock().unwrap();
            if guard.active && guard.generation == generation {
                guard.windows.clear();
            }
        }
        return;
    }

    let mut covered_geometries: HashSet<MonitorGeometry> = HashSet::new();

    if let Some(main_win) = app.get_webview_window("main") {
        if let Some(rect) = window_rect(&main_win) {
            if let Some(geometry) = monitor_for_rect(&monitors, rect) {
                covered_geometries.insert(geometry);
            }
        }
    }

    let mut retained_windows = Vec::new();
    for label in &windows {
        let Some(slave) = app.get_webview_window(label) else {
            continue;
        };

        // 量不到就**保留**。以前这里量不到就 close()，而 close 掉的下一轮
        // 又会被下面的创建循环建回来 —— 那就是每秒一次的建/关振荡，
        // 屏幕上表现为一个白窗口反复冒出来。宁可多留一个窗口，绝不振荡。
        let Some(rect) = window_rect(&slave) else {
            retained_windows.push(label.clone());
            continue;
        };
        let Some(geometry) = monitor_for_rect(&monitors, rect) else {
            retained_windows.push(label.clone());
            continue;
        };

        if covered_geometries.insert(geometry) {
            retained_windows.push(label.clone());
        } else {
            // 这块屏已经有窗口（通常是主窗口）覆盖了，这个副屏是多余的
            eprintln!("[lock] 关闭多余的副屏窗口 {label}（该屏已被其它窗口覆盖）");
            let _ = slave.close();
        }
    }

    let mut seen_geometries: HashSet<MonitorGeometry> = HashSet::new();
    for (i, monitor) in monitors.iter().enumerate() {
        let geometry = monitor_geometry(monitor);
        if !seen_geometries.insert(geometry) {
            continue;
        }

        if covered_geometries.contains(&geometry) {
            continue;
        }

        let label = format!("lock-slave-{}", i);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_position(*monitor.position());
            let _ = win.set_size(tauri::Size::Physical(*monitor.size()));
            let _ = win.set_fullscreen(true);
            if !retained_windows.contains(&label) {
                retained_windows.push(label);
            }
            covered_geometries.insert(geometry);
        } else if let Some(new_label) = create_slave_window(app, monitor, args.as_ref(), i) {
            // 单显示器机器上这一行**永远不该出现**。出现就说明又有人在给
            // 同一块屏叠窗口了 —— 那正是"白屏窗口反复冒出来"那个 bug 的形状。
            eprintln!("[lock] 为第 {i} 块屏创建副屏窗口 {new_label}");
            retained_windows.push(new_label);
            covered_geometries.insert(geometry);
        }
    }

    let lock_state = app.state::<LockState>();
    let mut guard = lock_state.0.lock().unwrap();
    if guard.active && guard.generation == generation {
        guard.windows = retained_windows;
    }
}

fn schedule_lock_watchdog_on_main_thread(
    app: &AppHandle,
    heal_windows: bool,
    pending: &Arc<AtomicBool>,
    heal_requested: &Arc<AtomicBool>,
) {
    if heal_windows {
        heal_requested.store(true, Ordering::SeqCst);
    }

    if pending.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_for_main = app.clone();
    let pending_for_main = Arc::clone(pending);
    let heal_requested_for_main = Arc::clone(heal_requested);
    if app
        .run_on_main_thread(move || {
            let should_heal_windows = heal_requested_for_main.swap(false, Ordering::SeqCst);
            run_lock_watchdog_on_main_thread(&app_for_main, should_heal_windows);
            pending_for_main.store(false, Ordering::SeqCst);
        })
        .is_err()
    {
        pending.store(false, Ordering::SeqCst);
    }
}

/// 锁屏期间前端每秒报活。这里检查"报活断了没有"，断了就重载 webview。
///
/// **绝不静默解锁。** 静默解锁等于宣布"杀掉 webview 就自由了" —— 那是逃生口，
/// 不是防砖。重载走的是和冷启动恢复**完全同一条**路径
/// （boot → `get_pending_lock` → 恢复锁屏 → 重新报活），所以是幂等的。
///
/// 一个诚实的边界：webview 彻底回不来时（比如前端资源没了），这里会按退避节奏
/// 一直重试，屏幕就停在空白锁屏上。这是刻意的 —— 宁可卡住也不能放行。
/// 出口是墙上时钟：休息时间一到，下一次成功的重载就会把锁清掉；
/// 实在不行重启一次，`armed:true` + `remaining<=0` 也会走放行路径。
///
/// 从计时线程调用，窗口操作转到主线程做，和 watchdog 保持一致。
fn maybe_heal_dead_webview(app: &AppHandle) {
    let now = Instant::now();

    let reloads = {
        let mut hb = lock_heartbeat_state().lock().unwrap();

        // 还没报过活 = 正在上锁途中，不判定。
        // 这时真死了也不会漏：`armed` 还是 false，下次启动就放行。
        let Some(last) = hb.last else {
            return;
        };

        // 第一次判定给 5 秒；之后按"重载次数 × 20 秒"退避，封顶 60 秒。
        // 退避是必须的：webview 起不来时若还按 5 秒一次重载，
        // 就是每 5 秒重建一次整个页面，自己把自己拖死。
        let grace = if hb.reloads == 0 {
            HEARTBEAT_TIMEOUT
        } else {
            HEARTBEAT_RELOAD_GRACE
                .checked_mul(hb.reloads)
                .unwrap_or(HEARTBEAT_RETRY_CEILING)
                .min(HEARTBEAT_RETRY_CEILING)
        };

        if now.duration_since(last) < grace {
            return;
        }

        // 先把时钟往前拨再动手：重载要花时间，期间不能反复触发。
        hb.last = Some(now);
        hb.reloads = hb.reloads.saturating_add(1);
        hb.reloads
    };

    eprintln!("[lock] 前端心跳中断，重载 webview 以恢复锁屏（第 {reloads} 次）");

    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_main.get_webview_window("main") {
            let _ = window.reload();
        }
    });
}

fn start_timer_thread(app_handle: AppHandle) {
    thread::spawn(move || {
        let lock_watchdog_pending = Arc::new(AtomicBool::new(false));
        let lock_watchdog_heal_requested = Arc::new(AtomicBool::new(false));

        // Linux uses shorter interval for better lock screen enforcement
        #[cfg(target_os = "linux")]
        let base_interval = Duration::from_millis(200);
        #[cfg(not(target_os = "linux"))]
        let base_interval = Duration::from_secs(1);

        #[cfg(target_os = "linux")]
        let mut tick_counter: u32 = 0;

        loop {
            thread::sleep(base_interval);

            #[cfg(target_os = "linux")]
            {
                tick_counter += 1;
            }

            // Check if we should run the full timer logic (every 1 second)
            #[cfg(target_os = "linux")]
            let should_run_timer_logic = tick_counter >= 5; // 200ms * 5 = 1 second
            #[cfg(not(target_os = "linux"))]
            let should_run_timer_logic = true;

            // Always check lock screen watchdog on Linux (every 200ms)
            // On other platforms, check every 1 second
            let is_locked = get_timer_state().lock().unwrap().lock_screen_active;
            if is_locked {
                schedule_lock_watchdog_on_main_thread(
                    &app_handle,
                    should_run_timer_logic,
                    &lock_watchdog_pending,
                    &lock_watchdog_heal_requested,
                );
                // 锁屏渲染者（webview）是不是还活着。这是"强制"和"能看见的出口"
                // 之间唯一的联系 —— 断了就重载，见函数注释。
                maybe_heal_dead_webview(&app_handle);
            }

            // Reset counter and run timer logic
            #[cfg(target_os = "linux")]
            if should_run_timer_logic {
                tick_counter = 0;
            }

            if !should_run_timer_logic {
                continue; // Skip the rest of the loop on Linux intermediate ticks
            }

            let mut tasks_to_trigger: Vec<TaskTriggeredPayload> = Vec::new();
            let mut idle_status_changed = false;
            let current_idle_status;

            {
                let mut state = get_timer_state().lock().unwrap();

                // 如果暂停、系统锁屏或锁屏模式激活，跳过检查
                if state.paused || state.system_locked || state.lock_screen_active {
                    continue;
                }

                let now = Instant::now();
                let idle_seconds = get_idle_seconds();
                let threshold = state.idle_threshold_seconds;
                let was_idle = state.is_idle;
                let is_now_idle = idle_seconds >= threshold;

                // 检测空闲状态变化
                if is_now_idle && !was_idle {
                    // 刚进入空闲状态
                    state.is_idle = true;
                    state.idle_start = Some(now);
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as i64;
                    state.idle_start_timestamp = Some(timestamp);
                    idle_status_changed = true;

                    // 重置所有勾选了「空闲重置」的任务
                    for timer in state.tasks.values_mut() {
                        if timer.config.enabled {
                            if timer.config.auto_reset_on_idle {
                                timer.reset_time = now;
                                timer.triggered = false;
                            }
                            freeze_timer_countdown(timer, now);
                        }
                    }
                } else if !is_now_idle && was_idle {
                    // 刚从空闲状态恢复
                    state.is_idle = false;

                    // 重新开始倒计时（从头开始）
                    for timer in state.tasks.values_mut() {
                        if timer.config.auto_reset_on_idle && timer.config.enabled {
                            timer.reset_time = now;
                            timer.triggered = false;
                            if timer.disabled_at.is_some() {
                                timer.disabled_at = Some(now);
                                freeze_timer_countdown(timer, now);
                            }
                        }
                        if timer.disabled_at.is_none() {
                            clear_timer_freeze(timer);
                        }
                    }

                    state.idle_start = None;
                    state.idle_start_timestamp = None;
                    idle_status_changed = true;
                }

                current_idle_status = IdleStatus {
                    is_idle: state.is_idle,
                    idle_seconds,
                    threshold,
                    idle_start_timestamp: state.idle_start_timestamp,
                };

                // 如果处于空闲状态，不检查任务触发（计时暂停）
                if state.is_idle {
                    // 空闲时不触发任何任务，但仍然发送倒计时更新
                } else {
                    // 正常检查任务触发
                    for timer in state.tasks.values_mut() {
                        if !timer.config.enabled {
                            continue;
                        }
                        if timer.disabled_at.is_some() {
                            continue;
                        }

                        if timer.snoozed {
                            if now >= timer.reset_time {
                                tasks_to_trigger.push(TaskTriggeredPayload {
                                    id: timer.config.id.clone(),
                                    title: timer.config.title.clone(),
                                    desc: timer.config.desc.clone(),
                                    icon: timer.config.icon.clone(),
                                });
                                timer.triggered = true;
                                timer.snoozed = false;
                            }
                            continue;
                        }

                        if is_daily_task(&timer.config) {
                            if let Some(key) = current_daily_trigger_key(&timer.config) {
                                if timer.daily_last_trigger_key.as_deref() != Some(&key) {
                                    tasks_to_trigger.push(TaskTriggeredPayload {
                                        id: timer.config.id.clone(),
                                        title: timer.config.title.clone(),
                                        desc: timer.config.desc.clone(),
                                        icon: timer.config.icon.clone(),
                                    });
                                    timer.daily_last_trigger_key = Some(key);
                                    timer.triggered = true;
                                }
                            }
                        } else if !timer.triggered {
                            let elapsed = now.saturating_duration_since(timer.reset_time).as_secs();
                            let total_secs = timer.config.interval * 60;

                            if elapsed >= total_secs {
                                // 触发提醒
                                tasks_to_trigger.push(TaskTriggeredPayload {
                                    id: timer.config.id.clone(),
                                    title: timer.config.title.clone(),
                                    desc: timer.config.desc.clone(),
                                    icon: timer.config.icon.clone(),
                                });

                                // 标记为已触发，等待用户操作（重置或推迟）
                                timer.triggered = true;
                            }
                        }
                    }
                }
            }

            if !tasks_to_trigger.is_empty() {
                let mut state = get_timer_state().lock().unwrap();
                for task in &tasks_to_trigger {
                    enqueue_pending_trigger(&mut state, task);
                }
            }

            // 触发投递只有一条路：事件 + 前端 1 秒轮询兜底。
            // （原先还有一条 `window.eval("__HEALTH_REMINDER_HANDLE_TRIGGER__…")`，
            // 但前端从来没定义过那个全局函数，是条死路径 —— 已删。）
            for task in tasks_to_trigger {
                let _ = app_handle.emit("task-triggered", task);
            }

            // 发送空闲状态更新（只在状态变化时发送，或每 5 秒发送一次状态）
            if idle_status_changed {
                let _ = app_handle.emit("idle-status-changed", current_idle_status.clone());
            }

            // 发送倒计时更新
            let countdowns = get_countdowns();
            let _ = app_handle.emit("countdown-update", countdowns);
        }
    });
}

/// 配置目录。跟着应用的名字走（缓缓 → `huanhuan`）。
///
/// 第一次访问时顺手搬一次家，见 `migrate_legacy_config`。用 `Once` 保证
/// 无论从哪条命令先进来，搬家都已经做过了 —— 这几个入口（`load_settings`、
/// `get_pending_lock`）在启动期是并发的，靠"在 setup 里先跑一遍"来排序不可靠。
fn config_dir() -> PathBuf {
    static MIGRATED: Once = Once::new();
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("huanhuan");
    MIGRATED.call_once(|| migrate_legacy_config(&dir));
    dir
}

/// 把早期版本写在 `desk-reminder/` 下的配置搬过来。
///
/// 用**复制**而不是移动：老目录留着当兜底（用户看不见它），而这里搬的是
/// 全部任务配置和可能正在生效的强制锁状态 —— 迁完就删的话，这段代码本身
/// 出一点错就是不可逆的。复制失败的后果只是回到默认配置，不是丢文件。
fn migrate_legacy_config(new_dir: &Path) {
    if new_dir.exists() {
        return;
    }
    let legacy = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("desk-reminder");
    if !legacy.is_dir() {
        return;
    }
    if fs::create_dir_all(new_dir).is_err() {
        return;
    }
    for name in ["settings.json", "lock.json"] {
        let src = legacy.join(name);
        if src.is_file() {
            let _ = fs::copy(&src, new_dir.join(name));
        }
    }
}

fn get_settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

#[tauri::command]
fn load_settings() -> String {
    let path = get_settings_path();
    fs::read_to_string(path).unwrap_or_default()
}

#[tauri::command]
fn save_settings(settings: String) -> Result<(), String> {
    let path = get_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, settings).map_err(|e| e.to_string())
}

// ============= 强制锁的落盘状态 =============

const LOCK_SCHEMA_VERSION: u64 = 1;

fn get_lock_state_path() -> PathBuf {
    config_dir().join("lock.json")
}

/// 原子写：先写同目录临时文件并 fsync，再 rename 覆盖。
///
/// 不用 `fs::write` —— 断电会留下截断的 JSON，而截断的文件解析失败就是一次砖。
/// （`save_settings` 用的就是裸 write，这里别照抄它。）
///
/// 调用顺序是**语义的一部分**，前端必须遵守：
///   1. 上锁**之前**先写 `armed:false`
///   2. 锁屏渲染出来、握手成功之后翻成 `armed:true`
/// 反过来的话，锁一出现就 `kill -9` 能赶在写文件之前逃掉。
#[tauri::command]
fn save_lock_state(json: String) -> Result<(), String> {
    let path = get_lock_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_lock_state() {
    let _ = fs::remove_file(get_lock_state_path());
}

fn read_lock_state_raw() -> Option<String> {
    fs::read_to_string(get_lock_state_path())
        .ok()
        .filter(|raw| !raw.trim().is_empty())
}

/// 启动时裁决：文件里是不是一个**没走完**的强制锁。
///
/// 只认 `armed == true`，且 schema 版本认识。其余一律**放行并删文件**：
/// - `armed:false` → 上次死在"正在上锁"的半途（前端先写 false 再启动强制），
///   此时把用户锁在门外等于我们自己造砖。
/// - 解析失败 / schema 不认识 → 文件本来就可以手工编辑，为"健壮性"锁死没有意义。
///
/// 副作用（删除文件）是刻意的：这样随后的 `get_pending_lock` 也会看到"没有挂起的锁"。
fn resolve_pending_lock() -> bool {
    let Some(raw) = read_lock_state_raw() else {
        return false;
    };

    let verdict = serde_json::from_str::<serde_json::Value>(&raw).ok().map(|value| {
        let schema_ok =
            value.get("schema_version").and_then(|v| v.as_u64()) == Some(LOCK_SCHEMA_VERSION);
        let armed = value
            .get("armed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        schema_ok && armed
    });

    match verdict {
        Some(true) => true,
        Some(false) => {
            let _ = fs::remove_file(get_lock_state_path());
            false
        }
        None => {
            eprintln!("[lock] lock.json 无法解析，按未上锁处理并删除");
            let _ = fs::remove_file(get_lock_state_path());
            false
        }
    }
}

/// 前端 boot 时问"有没有挂起的锁"。
///
/// 返回**原始 JSON 字符串**，语义（剩余时长、闸门进度、时钟单调性）全部由前端算 ——
/// 后端只负责存和取，不解析内容，跟 settings 一样当字符串透传。
#[tauri::command]
fn get_pending_lock() -> Option<String> {
    if !resolve_pending_lock() {
        return None;
    }
    read_lock_state_raw()
}

/// 原样读 `lock.json`，**不做 armed 判定**。
///
/// 副屏用。副屏窗口是在 `enter_lock_mode` 里同步建出来的，那一刻主屏前端
/// 刚写完 `armed:false` 还没来得及翻 true —— 用 `get_pending_lock` 它们会
/// 集体看到"没有锁"，于是一整排副屏全黑。这里要的只是"把正在进行的这次
/// 休息画出来"，armed 与否是主屏判断的事。
#[tauri::command]
fn get_lock_state_raw() -> Option<String> {
    read_lock_state_raw()
}

// ============= 居中浮窗（?mode=reminder） =============

/// 当前要展示的提醒内容。后端只当它是 JSON 透传，不解析语义 ——
/// 内容由前端在触发时给出（它本来就有完整的 task 对象）。
struct ReminderState(Mutex<Option<serde_json::Value>>);

#[tauri::command]
fn enter_reminder(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    // 先落 payload 再建窗口：窗口 boot 之后调 get_reminder_payload 读它，
    // 所以不存在"窗口已加载但内容还没到"的竞态。
    *app.state::<ReminderState>().0.lock().unwrap() = Some(payload);

    if let Some(window) = app.get_webview_window("reminder") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // 窗口标志沿用已删除的浮窗实现：无边框 + 置顶 + 不进任务栏。
    // 不设 closable(false) —— macOS 无边框窗口本来就没有关闭按钮，真正的
    // 拦截在 on_window_event 的 close guard 里（Cmd+W 也得挡住）。
    //
    // 同步命令（非 async）刻意为之：Tauri 里非 async 的命令跑在主线程上，
    // 建窗口不需要跨线程派发。
    WebviewWindowBuilder::new(
        &app,
        "reminder",
        WebviewUrl::App(PathBuf::from("index.html?mode=reminder")),
    )
    .title("Reminder")
    .inner_size(400.0, 300.0)
    .resizable(false)
    .decorations(false)
    // 透明底：卡片是圆角的，窗口不透明的话圆角外面会是一块白。
    // macOS 上这还要求 tauri.conf.json 里的 macOSPrivateApi = true。
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_reminder_payload(state: State<'_, ReminderState>) -> Option<serde_json::Value> {
    state.0.lock().unwrap().clone()
}

/// 关掉提醒窗。走 `destroy` 而不是 `close` —— `close` 会触发 CloseRequested，
/// 而那个事件被 close guard 挡着（Cmd+W 关不掉提醒是刻意的，只有这里的
/// 「确认」按钮能关）。
#[tauri::command]
fn exit_reminder(app: AppHandle) {
    if let Some(window) = app.get_webview_window("reminder") {
        let _ = window.destroy();
    }
    *app.state::<ReminderState>().0.lock().unwrap() = None;
}

#[tauri::command]
fn was_started_silent() -> bool {
    std::env::args().any(|arg| arg == "--silent")
}

fn play_custom_audio_file(file_path: &str) -> Result<(), String> {
    use rodio::{Decoder, OutputStreamBuilder, Sink};
    use std::fs::File;

    let stream_handle = OutputStreamBuilder::open_default_stream()
        .map_err(|e| format!("Failed to create audio output stream: {}", e))?;
    let sink = Sink::connect_new(stream_handle.mixer());
    let file = File::open(file_path).map_err(|e| format!("Failed to open audio file: {}", e))?;
    let source = Decoder::try_from(BufReader::new(file))
        .map_err(|e| format!("Failed to decode audio file: {}", e))?;

    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

fn play_custom_audio_async(file_path: String) {
    thread::spawn(move || {
        let _ = play_custom_audio_file(&file_path);
    });
}

fn play_system_notification_sound() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Add-Type -AssemblyName System.Sound; [System.Media.SystemSounds]::Beep.Play();",
            ])
            .creation_flags(0x08000000)
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("afplay")
            .args(["/System/Library/Sounds/Glass.aiff"])
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        // 尝试多种 Linux 系统声音命令
        if Command::new("paplay")
            .args(["/usr/share/sounds/alsa/Front_Left.wav"])
            .output()
            .is_ok()
        {
            return;
        }

        if Command::new("aplay")
            .args(["/usr/share/sounds/alsa/Front_Left.wav"])
            .output()
            .is_ok()
        {
            return;
        }

        // 最后尝试系统提示音
        let _ = Command::new("echo").args(["\u{0007}"]).output();
    }
}

#[tauri::command]
fn play_notification_sound(custom_sound_path: Option<String>) -> Result<(), String> {
    if let Some(path) = custom_sound_path {
        if !path.trim().is_empty() && std::path::Path::new(&path).exists() {
            play_custom_audio_async(path);
            return Ok(());
        }
    }

    play_system_notification_sound();
    Ok(())
}

#[tauri::command]
fn test_custom_sound(file_path: String) -> Result<(), String> {
    if file_path.trim().is_empty() {
        return Err("No sound file selected".to_string());
    }

    if !std::path::Path::new(&file_path).exists() {
        return Err("Sound file does not exist".to_string());
    }

    play_custom_audio_async(file_path);
    Ok(())
}

#[tauri::command]
fn show_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_main_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn is_main_window_visible(window: tauri::Window) -> bool {
    window.is_visible().unwrap_or(false)
}

#[tauri::command]
fn update_tray_tooltip(state: State<TrayState>, tooltip: String) {
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[tauri::command]
fn update_pause_menu(state: State<PauseMenuState>, lang_state: State<LanguageState>, paused: bool) {
    if let Some(menu_item) = state.0.lock().unwrap().as_ref() {
        let lang = lang_state.0.lock().unwrap();
        let text = if paused {
            get_tray_text("resume", &lang)
        } else {
            get_tray_text("pause", &lang)
        };
        let _ = menu_item.set_text(text);
    }
}

#[tauri::command]
fn update_tray_language(app: AppHandle, lang_state: State<LanguageState>, language: String) {
    // 更新语言状态
    *lang_state.0.lock().unwrap() = language.clone();

    // 重新构建托盘菜单以应用新语言
    rebuild_tray_menu(&app);

    // 更新托盘提示文本
    let tray_state = app.state::<TrayState>();
    let guard = tray_state.0.lock().unwrap();
    if let Some(tray) = guard.as_ref() {
        let _ = tray.set_tooltip(Some(get_tray_text("tooltip", &language)));
    }
}

fn create_slave_window(
    app: &AppHandle,
    monitor: &tauri::Monitor,
    task: Option<&LockTaskArgs>,
    index: usize,
) -> Option<String> {
    let label = format!("lock-slave-{}", index);

    let mut url_str = String::from("index.html?mode=lock_slave");
    if let Some(t) = task {
        let encoded: String = form_urlencoded::Serializer::new(String::new())
            .append_pair("title", &t.title)
            .append_pair("desc", &t.desc)
            .append_pair("duration", &t.duration.to_string())
            .append_pair("icon", &t.icon)
            .append_pair("strict_mode", &t.strict_mode.to_string())
            .append_pair("allow_strict_snooze", &t.allow_strict_snooze.to_string())
            .append_pair("max_snooze_count", &t.max_snooze_count.to_string())
            .append_pair("snooze_minutes", &t.snooze_minutes.to_string())
            .append_pair("current_snooze_count", &t.current_snooze_count.to_string())
            .append_pair("bg_image", &t.bg_image)
            .finish();
        url_str = format!("index.html?mode=lock_slave&{}", encoded);
    }

    if let Ok(slave) =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(PathBuf::from(url_str)))
            .title("Lock Screen")
            .always_on_top(true)
            .closable(false)
            .minimizable(false)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .focused(true)
            .build()
    {
        let _ = slave.set_position(*monitor.position());
        let _ = slave.set_size(tauri::Size::Physical(*monitor.size()));
        let _ = slave.show();
        let _ = slave.set_focus();
        let _ = slave.set_fullscreen(true);

        // Additional focus and z-order enforcement for Linux
        #[cfg(target_os = "linux")]
        {
            // Request focus again after fullscreen
            let _ = slave.set_focus();
            // On Linux, we may need to ensure the window is always on top multiple times
            let _ = slave.set_always_on_top(true);
        }

        Some(label)
    } else {
        None
    }
}

fn start_lock_focus_watch(app: tauri::AppHandle, generation: u64) {
    let focus_pending = Arc::new(AtomicBool::new(false));

    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(650));

        let should_continue = {
            let state = app.state::<LockState>();
            let guard = state.0.lock().unwrap();
            guard.active && guard.generation == generation
        };

        if !should_continue {
            return;
        }

        if focus_pending.swap(true, Ordering::SeqCst) {
            continue;
        }

        let app_for_main = app.clone();
        let pending_for_main = Arc::clone(&focus_pending);
        if app
            .run_on_main_thread(move || {
                let should_continue = {
                    let state = app_for_main.state::<LockState>();
                    let guard = state.0.lock().unwrap();
                    guard.active && guard.generation == generation
                };

                if should_continue {
                    enforce_main_lock_focus(&app_for_main);
                }

                pending_for_main.store(false, Ordering::SeqCst);
            })
            .is_err()
        {
            focus_pending.store(false, Ordering::SeqCst);
            return;
        }
    });
}

#[tauri::command]
async fn enter_lock_mode(
    app: tauri::AppHandle,
    state: State<'_, LockState>,
    task: Option<LockTaskArgs>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_fullscreen(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_closable(false);
    let _ = window.set_minimizable(false);
    let _ = window.set_focus();

    let monitors = window.available_monitors().unwrap_or_default();
    let current_monitor = window.current_monitor().unwrap_or(None);

    let mut created_windows = Vec::new();
    let mut seen_geometries: HashSet<MonitorGeometry> = HashSet::new();
    // `current_monitor()` 是可靠的；量不到时才退回几何判定，而那个判定
    // 必须用 `monitor_for_rect`（相交面积），不能用"左上角是否相等"——
    // 后者永远认不出居中的主窗口，于是会给主屏再建一个副屏窗口。
    let current_geometry = current_monitor
        .as_ref()
        .map(monitor_geometry)
        .or_else(|| window_rect(&window).and_then(|rect| monitor_for_rect(&monitors, rect)));

    for (i, m) in monitors.iter().enumerate() {
        let geometry = monitor_geometry(m);
        if !seen_geometries.insert(geometry) {
            continue;
        }

        if current_geometry == Some(geometry) {
            continue;
        }

        if let Some(label) = create_slave_window(&app, m, task.as_ref(), i) {
            created_windows.push(label);
        }
    }

    // Additional focus enforcement for Linux after all windows are created
    #[cfg(target_os = "linux")]
    {
        // Re-focus all slave windows to ensure they stay on top
        for label in created_windows.iter() {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.set_focus();
                let _ = w.set_always_on_top(true);
            }
        }
        // Re-focus main window
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
    }

    let mut state_guard = state.0.lock().unwrap();
    state_guard.windows.extend(created_windows);
    state_guard.args = task;
    state_guard.active = true;
    state_guard.generation = state_guard.generation.wrapping_add(1);
    let generation = state_guard.generation;
    drop(state_guard);

    start_lock_focus_watch(app.clone(), generation);

    Ok(())
}

#[tauri::command]
fn exit_lock_mode(app: tauri::AppHandle, state: State<LockState>, restore_visible: Option<bool>) {
    let restore_visible = restore_visible.unwrap_or(false);
    let window = app.get_webview_window("main");

    if let Some(window) = window {
        if !restore_visible {
            let _ = window.hide();
        }

        let _ = window.set_fullscreen(false);
        let _ = window.set_always_on_top(false);
        let _ = window.set_closable(true);
        let _ = window.set_minimizable(true);

        if restore_visible {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    let mut state_guard = state.0.lock().unwrap();
    state_guard.active = false;
    state_guard.generation = state_guard.generation.wrapping_add(1);
    for label in state_guard.windows.iter() {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
    state_guard.windows.clear();
    state_guard.args = None;
    drop(state_guard);

    // 走到这里说明这次强制休息**正常完成了**（前端只在 finishLock 里调本命令）。
    // 落盘状态必须一起清掉，否则下次启动会把一个已经结束的锁恢复出来。
    // `kill -9` 和断电不会经过这里 —— 那正是 `lock.json` 存在的意义。
    let _ = fs::remove_file(get_lock_state_path());
}

pub fn run() {
    tauri::Builder::default()
        // 必须第一个注册：单实例插件需要在其它 setup 跑起来之前就拦下第二个进程。
        // 回调在**已在运行的第一实例**里执行，第二个进程自己退出 ——
        // 否则自启 + 手动启动会同时跑两套计时器、两个锁。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 自启传 `--silent`；手动双击不带。靠这个区分
            //「登录自启撞上已在运行的实例」和「用户主动点开」。
            let silent = argv.iter().any(|arg| arg == "--silent");

            if is_lock_active(app) {
                // 锁着的时候不做任何可见动作：main 就是锁面，把它 unminimize/show
                // 只是把强制重新顶到前面，但不能有任何"新窗口"的观感。
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return;
            }

            if silent {
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // 这里原本是 tauri_plugin_updater。移除了：它的"检查更新"必须验签，
        // 而签名私钥在上游手里，留着公钥等于把用户引去拉原项目的包。
        // 现在"检查更新"是前端直接问 GitHub API，有新版就开 release 页。
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ))
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            was_started_silent,
            play_notification_sound,
            test_custom_sound,
            show_notification,
            show_main_window,
            hide_main_window,
            is_main_window_visible,
            update_tray_tooltip,
            update_pause_menu,
            update_tray_language,
            enter_lock_mode,
            exit_lock_mode,
            save_lock_state,
            clear_lock_state,
            get_pending_lock,
            get_lock_state_raw,
            enter_reminder,
            exit_reminder,
            get_reminder_payload,
            pause_playing_media_sessions,
            sync_tasks,
            timer_pause,
            timer_resume,
            timer_is_paused,
            timer_pause_task,
            timer_resume_task,
            timer_reset_task,
            timer_reset_all,
            timer_snooze_task,
            get_countdowns,
            peek_triggered_tasks,
            ack_triggered_task,
            timer_set_system_locked,
            timer_set_lock_screen_active,
            lock_heartbeat,
            set_idle_threshold,
            get_idle_threshold,
            authenticate,
            open_external_url,
        ])
        .manage(TrayState(Mutex::new(None)))
        .manage(LockState(Mutex::new(LockStateInner {
            windows: Vec::new(),
            args: None,
            active: false,
            generation: 0,
        })))
        .manage(ReminderState(Mutex::new(None)))
        .manage(PauseMenuState(Mutex::new(None)))
        .manage(LanguageState(Mutex::new("zh-CN".to_string())))
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset", "重置所有任务", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启软件", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &reset, &restart, &quit])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("缓缓")
                .on_menu_event(|app, event| {
                    let id_str = event.id.as_ref();
                    // 退出/重启走 `app.exit(0)` 与 `app.restart()`，**不经过**
                    // `RunEvent::ExitRequested`，所以必须在这里单独拦一次，
                    // 否则锁定期间一次托盘点击就能把强制锁解掉。
                    if id_str == "quit" {
                        if is_lock_active(app) {
                            let _ = app.emit("exit-blocked", ());
                        } else {
                            app.exit(0);
                        }
                    } else if id_str == "restart" {
                        if is_lock_active(app) {
                            let _ = app.emit("exit-blocked", ());
                        } else {
                            app.restart();
                        }
                    } else if id_str == "show" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    } else if id_str == "reset" {
                        let _ = app.emit("reset-all-tasks", ());
                    } else if id_str == "pause" {
                        let _ = app.emit("toggle-pause", ());
                    } else if id_str.starts_with("reset_task_") {
                        let task_id = id_str.trim_start_matches("reset_task_");
                        let mut state = get_timer_state().lock().unwrap();
                        let now = Instant::now();
                        let reset_during_lock = state.lock_screen_active;
                        if let Some(timer) = state.tasks.get_mut(task_id) {
                            timer.reset_time = now;
                            timer.reset_during_lock = reset_during_lock;
                            timer.triggered = false;
                            timer.snoozed = false;
                            timer.snooze_count = 0;
                            if timer.disabled_at.is_some() {
                                timer.disabled_at = Some(now);
                            }
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            *app.state::<TrayState>().0.lock().unwrap() = Some(tray);
            *app.state::<PauseMenuState>().0.lock().unwrap() = Some(pause);

            // 冷启动恢复：上次要是被强杀/断电打断的强制锁，必须在计时线程开始
            // tick **之前**就把 `lock_screen_active` 置真。
            //
            // 理由：`sync_tasks` 会读这个标志决定任务是否冻结，而 `sync_tasks`
            // 在前端 boot 里立刻就被调用。晚一步，任务会被建成"未冻结"，于是在
            // 恢复出来的锁屏背后冒出一个提醒。
            //
            // 这里只裁决、不删（armed:true 时保留文件）—— 前端 boot 会调
            // `get_pending_lock` 拿原始 JSON 继续恢复锁屏。
            if resolve_pending_lock() {
                timer_set_lock_screen_active(true);
            }

            // 启动后端定时器线程
            start_timer_thread(app.handle().clone());

            #[cfg(target_os = "windows")]
            start_session_monitor(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // If the window is a lock slave, just close it (don't prevent close)
                // The label check: main window has label "main" (default).
                // Slave windows have "lock-slave-X".
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == "reminder" {
                    // 居中浮窗也要挡住反射性的 Cmd+W —— 否则"必须点确认才消失"
                    // 就是一句空话。`closable(false)` 管不到键盘快捷键，这里才行。
                    // 真正的关闭只走 `exit_reminder` 的 `destroy()`（绕过本事件）。
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match &event {
                // 强制锁期间不许退出。macOS 上 Cmd+Q 走 NSApplication 的
                // applicationShouldTerminate → 这里，是默认应用菜单给的路径，
                // 不拦的话一个反射性 Cmd+Q 就把锁解了。
                // 托盘菜单的退出/重启走 app.exit(0)/app.restart()，绕过本事件，另行拦截。
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if is_lock_active(app_handle) {
                        api.prevent_exit();
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        });
}
