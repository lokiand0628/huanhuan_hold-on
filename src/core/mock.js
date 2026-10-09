/**
 * `?mock=1` 用的假后端。
 *
 * 目的只有一个：让界面能在普通浏览器里跑完整流程，从而能截图对齐规范。
 * 计时引擎是真的（每秒 tick、会真的触发、会真的排进待处理队列），
 * 只有"窗口"和"系统"这两块是假的。
 *
 * `?fast=1` 把一分钟压成一秒，用来快速看到提醒真的弹出来。
 */

const LS_SETTINGS = 'mock.settings';
const LS_LOCK = 'mock.lock';
const LS_REMINDER = 'mock.reminder';

export function createMock(params) {
  const FAST = params.get('fast') === '1';
  const SPEED = FAST ? 60 : 1;

  const listeners = new Map();
  const timers = new Map(); // id -> { remaining, enabled, paused }
  const pending = [];
  let globalPaused = false;
  let popup = null;

  function emitLocal(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler({ event, payload });
      } catch (err) {
        console.error('[mock listener]', event, err);
      }
    }
  }

  function snapshotCountdowns() {
    return [...timers.entries()].map(([id, t]) => ({
      id,
      remaining: Math.max(0, Math.round(t.remaining)),
      enabled: t.enabled,
      task_paused: t.paused,
    }));
  }

  setInterval(() => {
    if (timers.size === 0) return;
    let dirty = false;

    for (const [id, t] of timers) {
      if (!t.enabled || t.paused || globalPaused) continue;
      if (t.remaining <= 0) continue;
      t.remaining = Math.max(0, t.remaining - SPEED);
      dirty = true;
      if (t.remaining === 0) {
        const payload = { id, title: t.title, desc: t.desc, icon: t.icon };
        pending.push(payload);
        emitLocal('task-triggered', payload);
      }
    }

    if (dirty) emitLocal('countdown-update', snapshotCountdowns());
  }, 1000);

  return {
    /* ---- 设置 ---- */
    async loadSettings() {
      return localStorage.getItem(LS_SETTINGS) || '';
    },
    async saveSettings(json) {
      localStorage.setItem(LS_SETTINGS, json);
    },

    /* ---- 计时 ---- */
    async syncTasks(tasks) {
      const seen = new Set();
      for (const task of tasks || []) {
        seen.add(task.id);
        const existing = timers.get(task.id);
        const total = (task.interval || 30) * 60;
        if (!existing) {
          timers.set(task.id, {
            remaining: total,
            interval: total,
            enabled: task.enabled !== false,
            paused: false,
            title: task.title,
            desc: task.desc,
            icon: task.icon,
          });
        } else {
          existing.interval = total;
          existing.enabled = task.enabled !== false;
          existing.title = task.title;
          existing.desc = task.desc;
          existing.icon = task.icon;
        }
      }
      for (const id of [...timers.keys()]) {
        if (!seen.has(id)) timers.delete(id);
      }
      emitLocal('countdown-update', snapshotCountdowns());
    },
    async pauseAll() {
      globalPaused = true;
      emitLocal('pause-state-updated', { paused: true });
    },
    async resumeAll() {
      globalPaused = false;
      emitLocal('pause-state-updated', { paused: false });
    },
    async isPaused() {
      return globalPaused;
    },
    async pauseTask(id) {
      const t = timers.get(id);
      if (t) t.paused = true;
    },
    async resumeTask(id) {
      const t = timers.get(id);
      if (t) t.paused = false;
    },
    async resetTask(id) {
      const t = timers.get(id);
      if (t) t.remaining = t.interval;
      emitLocal('countdown-update', snapshotCountdowns());
    },
    async resetAll() {
      for (const t of timers.values()) t.remaining = t.interval;
      emitLocal('countdown-update', snapshotCountdowns());
    },
    async snoozeTask(id, minutes) {
      const t = timers.get(id);
      if (t) t.remaining = minutes * 60;
      emitLocal('countdown-update', snapshotCountdowns());
    },
    async countdowns() {
      return snapshotCountdowns();
    },
    async peekTriggered() {
      return pending.slice();
    },
    async ackTriggered(id) {
      const i = pending.findIndex(p => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    async setLockScreenActive() {},
    async lockHeartbeat() {},
    async setIdleThreshold() {},

    /* ---- 窗口 ---- */
    async showMain() {},
    async hideMain() {},
    async wasStartedSilent() {
      return false;
    },
    async enterReminder(payload) {
      localStorage.setItem(LS_REMINDER, JSON.stringify(payload));
      // 用一个真弹窗模拟那个无边框小窗，尺寸照着 src-tauri 里的来
      popup = window.open(
        `${location.pathname}?mock=1&mode=reminder`,
        'mock-reminder',
        'width=400,height=300,menubar=no,toolbar=no,location=no,status=no'
      );
    },
    async exitReminder() {
      localStorage.removeItem(LS_REMINDER);
      // 关窗这个动作由小窗自己发起（window.close），这里只兜住"主窗口主动收起"
      if (popup && !popup.closed && popup !== window) popup.close();
      popup = null;
    },
    async reminderPayload() {
      const raw = localStorage.getItem(LS_REMINDER);
      return raw ? JSON.parse(raw) : null;
    },
    // 真实实现里锁屏是**在 main 窗口原地渲染**的（不换窗口、不换 URL），
    // 所以 mock 这两条什么都不用做 —— 界面的路由切换由 main.js 自己完成。
    // 换成 mock 早期那样去改 location.search，反而会把主窗口变成副屏。
    async enterLock() {},
    async exitLock() {},

    /* ---- 落盘状态 ---- */
    async saveLockState(json) {
      localStorage.setItem(LS_LOCK, json);
    },
    async clearLockState() {
      localStorage.removeItem(LS_LOCK);
    },
    async pendingLock() {
      const raw = localStorage.getItem(LS_LOCK);
      if (!raw) return null;
      try {
        return JSON.parse(raw).armed ? raw : null;
      } catch {
        return null;
      }
    },
    async lockStateRaw() {
      return localStorage.getItem(LS_LOCK);
    },

    /* ---- 系统 ---- */
    async version() {
      return '0.0.1 (mock)';
    },
    async playSound() {
      console.log('[mock] 播放提示音');
    },
    async testCustomSound(path) {
      console.log('[mock] 试听', path);
    },
    async notify(title, body) {
      console.log('[mock] 通知', title, body);
    },
    async pauseMedia(mode) {
      console.log('[mock] 暂停媒体', mode);
    },
    async updateTrayTooltip() {},
    async autostartEnabled() {
      return localStorage.getItem('mock.autostart') === '1';
    },
    async autostartEnable() {
      localStorage.setItem('mock.autostart', '1');
    },
    async autostartDisable() {
      localStorage.setItem('mock.autostart', '0');
    },
    async pickFile() {
      // 浏览器里没法开原生文件框，给一个假的路径让流程能走完
      return '/tmp/mock-sound.mp3';
    },
    async confirm(message) {
      return window.confirm(message);
    },
    async checkUpdate() {
      // 故意回一个更高的版本号：浏览器里改文案时，"有新版本"那条分支
      // 才是唯一有界面变化的分支，回"已是最新"就什么都看不见了。
      return {
        latest: '9.9.9',
        url: 'https://github.com/lokiand0628/huanhuan_hold-on/releases',
      };
    },
    async relaunch() {
      location.reload();
    },
    // 浏览器里没有 LAContext，用 confirm 顶替：既能走通"验证通过"，
    // 也能走通"用户取消"—— 后者正是要调的界面对话。
    async authenticate(reason) {
      return window.confirm(`[模拟] 验证身份：${reason}`);
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },

    /* ---- 事件 ---- */
    async listen(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    async emit(event, payload) {
      emitLocal(event, payload);
    },
  };
}
