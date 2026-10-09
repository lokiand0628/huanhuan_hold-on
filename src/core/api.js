/**
 * 后端桥接层。所有 invoke / listen 集中在这里，业务代码不直接碰 Tauri API。
 *
 * `?mock=1` 会切到一套内存假后端。这不是为了好玩：
 * 真实窗口行为（置顶、全屏、抢焦点、单实例）只能在打包后的 app 里验，
 * 但界面的排版、状态流转、闸门逻辑用浏览器验快得多 —— 而且能截图对照规范。
 * 两套后端共用一个接口，所以界面代码不需要知道自己在哪一边。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen as tauriListen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { open as openDialog, ask } from '@tauri-apps/plugin-dialog';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { convertFileSrc } from '@tauri-apps/api/core';
import { createMock } from './mock.js';

const params = new URLSearchParams(location.search);
const IS_MOCK = params.get('mock') === '1';

/**
 * 「检查更新」只问这一个仓库，而且**只问、不装**。
 *
 * 原本这里挂的是 tauri-plugin-updater：它要一对 minisign 密钥，而配置里那对
 * 是上游项目的、私钥不在手上 —— 留着它，用户点一下就会被拉去装上游的包。
 * 现在改成查 GitHub 的 latest release，有新版就把人送到仓库页面自己下。
 * 代价是没有静默升级；换来的是不用保管私钥，也不会装错东西。
 */
const REPO = 'lokiand0628/huanhuan_hold-on';

const safe = (fn, fallback = null) =>
  fn().catch(err => {
    console.error('[api]', err);
    return fallback;
  });

/* ============================== 真后端 ============================== */

const real = {
  loadSettings: () => invoke('load_settings'),
  saveSettings: json => invoke('save_settings', { settings: json }),

  syncTasks: tasks => invoke('sync_tasks', { tasks }),
  pauseAll: () => invoke('timer_pause'),
  resumeAll: () => invoke('timer_resume'),
  isPaused: () => invoke('timer_is_paused'),
  pauseTask: taskId => invoke('timer_pause_task', { taskId }),
  resumeTask: taskId => invoke('timer_resume_task', { taskId }),
  resetTask: taskId => invoke('timer_reset_task', { taskId }),
  resetAll: () => invoke('timer_reset_all'),
  snoozeTask: (taskId, minutes) => invoke('timer_snooze_task', { taskId, minutes }),
  countdowns: () => invoke('get_countdowns'),
  peekTriggered: () => invoke('peek_triggered_tasks'),
  ackTriggered: taskId => invoke('ack_triggered_task', { taskId }),
  setLockScreenActive: active => invoke('timer_set_lock_screen_active', { active }),
  // 锁屏期间每秒一次。Rust 靠它判断"渲染锁屏的 webview 还活着"，
  // 断了就重载 webview 把锁屏接回来 —— 绝不静默解锁，见 lib.rs 的看门狗注释。
  lockHeartbeat: () => invoke('lock_heartbeat'),
  setIdleThreshold: seconds => invoke('set_idle_threshold', { seconds }),

  showMain: () => invoke('show_main_window'),
  hideMain: () => invoke('hide_main_window'),
  // 自启时带 `--silent`，手动双击不带 —— 靠这个区分"登录自启"和"用户想看界面"
  wasStartedSilent: () => invoke('was_started_silent'),
  enterReminder: payload => invoke('enter_reminder', { payload }),
  exitReminder: () => invoke('exit_reminder'),
  reminderPayload: () => invoke('get_reminder_payload'),
  enterLock: task => invoke('enter_lock_mode', { task }),
  exitLock: restoreVisible => invoke('exit_lock_mode', { restoreVisible }),

  saveLockState: json => invoke('save_lock_state', { json }),
  clearLockState: () => invoke('clear_lock_state'),
  pendingLock: () => invoke('get_pending_lock'),
  // 副屏用：不做 armed 判定，只要"当前正在进行的这次休息"
  lockStateRaw: () => invoke('get_lock_state_raw'),

  version: () => getVersion(),
  playSound: () => invoke('play_notification_sound', {}),
  testCustomSound: path => invoke('test_custom_sound', { filePath: path }),
  notify: (title, body) => invoke('show_notification', { title, body }),
  pauseMedia: mode => invoke('pause_playing_media_sessions', { mode }),
  updateTrayTooltip: tip => invoke('update_tray_tooltip', { tooltip: tip }),

  autostartEnabled: () => isEnabled(),
  autostartEnable: () => enable(),
  autostartDisable: () => disable(),

  pickFile: (filters, multiple = false) => openDialog({ multiple, filters }),
  // 用插件而不是 window.confirm：WKWebView 下的原生 confirm 行为不一致
  confirm: (message, title) => ask(message, { title, kind: 'warning' }),

  // 抛异常 = 失败；正常返回 = 查到了。两者绝不能混 —— 否则每次点都报错。
  checkUpdate: async () => {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    // tag 是 `v0.0.1` 这种，比版本号时去掉前缀
    return { latest: String(data.tag_name || '').replace(/^v/, ''), url: data.html_url };
  },
  relaunch: () => relaunch(),

  // 指纹 / 开机密码。返回 false 是"没验过"这个正常结果，不抛异常。
  authenticate: reason => invoke('authenticate', { reason }),
  openExternal: url => invoke('open_external_url', { url }),

  listen: (event, handler) => tauriListen(event, handler),
  emit: (event, payload) => emit(event, payload).catch(() => {}),
};

/* ============================== 对外接口 ============================== */

const backend = IS_MOCK ? createMock(params) : real;

/** 把 openDialog 的返回值归一成"一个路径字符串或空串" */
async function pickPath(filters, multiple = false) {
  const picked = await safe(() => backend.pickFile(filters, multiple), null);
  if (!picked) return '';
  if (Array.isArray(picked)) return picked[0] || '';
  return typeof picked === 'string' ? picked : picked?.path || '';
}

export const api = {
  isMock: IS_MOCK,

  convertFileSrc: path => (IS_MOCK ? path : convertFileSrc(path)),

  loadSettings: () => safe(() => backend.loadSettings(), ''),
  saveSettings: json => safe(() => backend.saveSettings(json)),

  syncTasks: tasks => safe(() => backend.syncTasks(tasks)),
  pauseAll: () => safe(() => backend.pauseAll()),
  resumeAll: () => safe(() => backend.resumeAll()),
  isPaused: () => safe(() => backend.isPaused(), false),
  pauseTask: id => safe(() => backend.pauseTask(id)),
  resumeTask: id => safe(() => backend.resumeTask(id)),
  resetTask: id => safe(() => backend.resetTask(id)),
  resetAll: () => safe(() => backend.resetAll()),
  snoozeTask: (id, minutes) => safe(() => backend.snoozeTask(id, minutes)),
  countdowns: () => safe(() => backend.countdowns(), []),
  peekTriggered: () => safe(() => backend.peekTriggered(), []),
  ackTriggered: id => safe(() => backend.ackTriggered(id)),
  setLockScreenActive: active => safe(() => backend.setLockScreenActive(active)),
  lockHeartbeat: () => safe(() => backend.lockHeartbeat()),
  setIdleThreshold: seconds => safe(() => backend.setIdleThreshold(seconds)),

  showMain: () => safe(() => backend.showMain()),
  hideMain: () => safe(() => backend.hideMain()),
  wasStartedSilent: () => safe(() => backend.wasStartedSilent(), false),
  enterReminder: payload => safe(() => backend.enterReminder(payload)),
  exitReminder: () => safe(() => backend.exitReminder()),
  reminderPayload: () => safe(() => backend.reminderPayload(), null),
  enterLock: task => safe(() => backend.enterLock(task)),
  exitLock: restoreVisible => safe(() => backend.exitLock(restoreVisible)),

  saveLockState: json => safe(() => backend.saveLockState(json)),
  clearLockState: () => safe(() => backend.clearLockState()),
  pendingLock: () => safe(() => backend.pendingLock(), null),
  lockStateRaw: () => safe(() => backend.lockStateRaw(), null),

  version: () => safe(() => backend.version(), '—'),
  playSound: () => safe(() => backend.playSound()),
  testCustomSound: path => safe(() => backend.testCustomSound(path)),
  notify: (title, body) => safe(() => backend.notify(title, body)),
  pauseMedia: mode => safe(() => backend.pauseMedia(mode)),
  updateTrayTooltip: tip => safe(() => backend.updateTrayTooltip(tip)),

  autostartEnabled: () => safe(() => backend.autostartEnabled(), false),
  autostartEnable: () => safe(() => backend.autostartEnable()),
  autostartDisable: () => safe(() => backend.autostartDisable()),

  pickFile: pickPath,
  confirm: (message, title) => safe(() => backend.confirm(message, title), false),
  async checkUpdate() {
    try {
      const { latest, url } = await backend.checkUpdate();
      return { status: 'ok', latest, url };
    } catch (err) {
      console.error('[api] checkUpdate', err);
      return { status: 'error' };
    }
  },
  relaunch: () => safe(() => backend.relaunch()),

  // 验证通过 = true。出错（超时、内部异常）按"没验过"处理，绝不能变成放行。
  authenticate: reason => safe(() => backend.authenticate(reason), false),
  openExternal: url => safe(() => backend.openExternal(url)),

  listen: (event, handler) => safe(() => backend.listen(event, handler), () => {}),
  emit: (event, payload) => safe(() => backend.emit(event, payload)),
};
