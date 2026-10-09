/**
 * `?mock=1` 用的假后端。
 *
 * 目的只有一个：让界面能在普通浏览器里跑完整流程，从而能截图对齐规范。
 * 计时引擎是真的（每秒 tick、会真的触发、会真的排进待处理队列），
 * 只有"窗口"和"系统"这两块是假的。
 *
 * `?fast=1` 把一分钟压成一秒，用来快速看到提醒真的弹出来。
 */
import { LINKS } from './links.js';

const LS_SETTINGS = 'mock.settings';
const LS_LOCK = 'mock.lock';
const LS_REMINDER = 'mock.reminder';
const LS_OPS = 'mock.ops';

/**
 * 跨窗口的操作转交。
 *
 * 计时器只活在**主窗口**那一份 mock 实例里（`syncTasks` 是在那儿调的）。
 * 居中浮窗是另一个窗口，它那份实例的 `timers` 是空的 —— 于是在小窗里点
 * 「知道了」或「稍后再说」，直接改本地 timers 等于什么都没发生，弹窗关了
 * 但任务不会被重置也不会被推迟。真后端里这些都是全局的 Tauri 命令，不存在
 * 这个问题；mock 得用 localStorage 把自己补成"全局的"。
 *
 * 只有还没 `syncTasks` 过的实例（也就是小窗）才会转交；主窗口自己直接执行。
 */
function relay(op, args) {
  const list = JSON.parse(localStorage.getItem(LS_OPS) || '[]');
  list.push({ op, args });
  localStorage.setItem(LS_OPS, JSON.stringify(list));
}

function drainOps() {
  const raw = localStorage.getItem(LS_OPS);
  if (!raw) return [];
  localStorage.removeItem(LS_OPS);
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

export function createMock(params) {
  const FAST = params.get('fast') === '1';
  const SPEED = FAST ? 60 : 1;

  const listeners = new Map();
  const timers = new Map(); // id -> { remaining, enabled, paused }
  const pending = [];
  let globalPaused = false;
  let popup = null;
  /** 这个实例有没有接手过计时器。没有 = 它是小窗那份，写操作要转交出去。 */
  let hasSynced = false;

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
      snoozed: t.snoozed,
    }));
  }

  /* ---- 真正的执行体。api 上的那几个命令要么直接调它，要么转交给主窗口 ---- */

  function doResetTask(id) {
    const t = timers.get(id);
    if (t) {
      t.remaining = t.interval;
      t.snoozed = false;
    }
    emitLocal('countdown-update', snapshotCountdowns());
  }

  function doResetAll() {
    for (const t of timers.values()) {
      t.remaining = t.interval;
      t.snoozed = false;
    }
    emitLocal('countdown-update', snapshotCountdowns());
  }

  function doSnoozeTask(id, minutes) {
    const t = timers.get(id);
    if (t) {
      t.remaining = minutes * 60;
      t.snoozed = true;
    }
    emitLocal('countdown-update', snapshotCountdowns());
  }

  function doAckTriggered(id) {
    const i = pending.findIndex(p => p.id === id);
    if (i >= 0) pending.splice(i, 1);
  }

  function applyOp(op, args) {
    if (op === 'resetTask') doResetTask(args[0]);
    else if (op === 'resetAll') doResetAll();
    else if (op === 'snoozeTask') doSnoozeTask(args[0], args[1]);
    else if (op === 'ackTriggered') doAckTriggered(args[0]);
  }

  setInterval(() => {
    // 先领走别的窗口转交过来的操作（小窗里的「知道了」「稍后再说」）。
    // 必须放在下面那个 `timers.size === 0` 的提前返回**之前** ——
    // 主窗口在没有任务时也会 early return。
    for (const { op, args } of drainOps()) applyOp(op, args);

    if (timers.size === 0) return;
    let dirty = false;

    for (const [id, t] of timers) {
      if (!t.enabled || t.paused || globalPaused) continue;
      if (t.remaining <= 0) continue;
      t.remaining = Math.max(0, t.remaining - SPEED);
      dirty = true;
      if (t.remaining === 0) {
        // `from_snooze` 要跟真后端一样带上（见 lib.rs 的 TaskTriggeredPayload）：
        // 浮窗靠它兑现"软提醒只推迟一次"。清标志要放在发出去之前。
        const payload = { id, title: t.title, desc: t.desc, icon: t.icon, from_snooze: t.snoozed };
        t.snoozed = false;
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
      // 从这一刻起，这个实例就是"拥有计时器的那一份"。主窗口 boot 时必调，
      // 小窗（bootReminder）永远不调 —— 这就是两者唯一的区别。
      hasSynced = true;
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
            snoozed: false,
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
      if (!hasSynced) return relay('resetTask', [id]);
      doResetTask(id);
    },
    async resetAll() {
      if (!hasSynced) return relay('resetAll', []);
      doResetAll();
    },
    async snoozeTask(id, minutes) {
      if (!hasSynced) return relay('snoozeTask', [id, minutes]);
      doSnoozeTask(id, minutes);
    },
    async countdowns() {
      return snapshotCountdowns();
    },
    async peekTriggered() {
      return pending.slice();
    },
    async ackTriggered(id) {
      if (!hasSynced) return relay('ackTriggered', [id]);
      doAckTriggered(id);
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
      return '0.0.2 (mock)';
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
        url: LINKS.releases,
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
