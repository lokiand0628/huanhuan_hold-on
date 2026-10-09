/**
 * 动作注册表。
 *
 * 键名就是视图吐出来的 `data-act` —— 点击用 `键`，输入用 `键:input`，
 * 变更用 `键:change`。三层键名从同一个字符串派生，所以"视图和处理器对不上"
 * 这种旧版最严重的 bug（`data-field` vs `dataset.act`、`lock-gate` 没有元素）
 * 在结构上就不可能发生；真有对不上的，`assertHandlers` 会在启动时喊出来。
 *
 * 两条纪律：
 *   1. **打字类动作绝不整棵重绘** —— 那会把输入框连同焦点一起换掉。
 *      这类动作只改 store + 落盘，DOM 上的值本来就是用户自己敲进去的。
 *   2. **点一下就变结构的动作才重绘**（展开、切页签、加任务）。
 */
import { api } from './api.js';
import {
  state,
  taskById,
  newTask,
  normalizeTimes,
  clampInt,
  DURATION_MIN,
  DURATION_MAX,
  DURATION_UNITS,
} from './store.js';
import { saveSettings } from './persist.js';
import { S, taskTitle } from './strings.js';
import { acceptInput, syncGate } from '../views/Gate.js';

const SWITCHES = {
  'toggle-sound': 'soundEnabled',
  'toggle-reset-idle': 'resetOnIdle',
  'toggle-silent': 'silentAutoStart',
};

// lockDuration 不在这里：它有自己的输入口（数值 + 单位 + 指纹闸门），
// 见下面 applyDuration。
const TASK_STEPS = {
  interval: [1, 1440],
  preNotificationSeconds: [0, 300],
  snoozeMinutes: [1, 120],
  maxSnooze: [0, 10],
};

/**
 * 休息时长超过这条线、且是**往大改**时，要先验指纹或开机密码。
 *
 * 这是整个应用里唯一一处"改设置要授权"。用户的原话是"超过 10 分钟的话
 * 就要设置，往大了改也需要，改小不用"—— 把 2 小时改成 5 分钟是"我今天
 * 想轻松点"，不该被自己的工具拦；把 30 秒改成 2 小时才是需要停下来
 * 想一秒的动作。所以判据是**方向**加**结果**，不是单看结果。
 */
const DURATION_AUTH_THRESHOLD = 10 * 60;

export function createActions(ctx) {
  const { render, toast, onGateInput, autostart, lock } = ctx;

  /** 改完配置统一走这里：落盘 + 把新任务表推给后端 */
  async function commit({ resync = true } = {}) {
    await saveSettings();
    if (resync) await api.syncTasks(ctx.backendTasks());
  }

  function applyIdleThreshold(el, minutes) {
    state.settings.idleThreshold = minutes * 60;
    // 空闲检测在后端，改完要立刻告诉它 —— 它有缓存
    api.setIdleThreshold(state.settings.idleThreshold);
    const input = el.parentElement.querySelector('input');
    if (input) input.value = String(minutes);
    scheduleCommit(commit);
  }

  /**
   * 休息时长的**唯一**提交口 —— 改数字、换单位都走这里，
   * 所以指纹闸门只需要写一遍，也不可能被某条支路绕过去。
   *
   * 验证失败时什么都不改并重绘，输入框弹回原值。刻意让"没验过"在界面上
   * 看得见，而不是留下一个未经授权的数字等着被悄悄落盘。
   */
  async function applyDuration(task, seconds, unit = null) {
    const next = clampInt(seconds, DURATION_MIN, DURATION_MAX, task.lockDuration);

    if (next > DURATION_AUTH_THRESHOLD && next > task.lockDuration) {
      const ok = await api.authenticate(S.authReason);
      if (!ok) {
        toast(S.authFail, 'warning');
        render();
        return;
      }
    }

    task.lockDuration = next;
    // 单位只在提交成功后才跟着走 —— 否则验证失败时重绘会用新单位
    // 去除旧秒数，屏幕上是 "0 小时" 这种鬼东西。
    if (unit) task.durationUnit = unit;
    await commit({ resync: false });
    render();
  }

  const handlers = {
    /* ============================== 外壳 ============================== */

    tab(el) {
      state.tab = el.dataset.value;
      state.expandedTaskId = null;
      render();
    },

    /* ============================== 提醒页 ============================== */

    async 'pause-all'() {
      if (state.isPaused) {
        await api.resumeAll();
        state.isPaused = false;
      } else {
        await api.pauseAll();
        state.isPaused = true;
      }
      render();
    },

    async 'reset-all'() {
      await api.resetAll();
      toast(S.resetAll, 'success');
    },

    async 'toggle-task'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.enabled = !task.enabled;
      await commit();
      render();
    },

    'expand-task'(el) {
      const id = el.dataset.id;
      state.expandedTaskId = state.expandedTaskId === id ? null : id;
      render();
    },

    async 'set-interval'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.interval = clampInt(el.dataset.value, 1, 1440, task.interval);
      // 改间隔等于重新排期：不重置的话，新的间隔要等下一轮才生效
      await commit();
      await api.resetTask(task.id);
      render();
    },

    async 'set-icon'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.icon = el.dataset.value;
      await commit({ resync: false });
      render();
    },

    async 'set-schedule'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      const next = el.dataset.value;
      if (next === 'daily' && !task.dailyTimes.length) {
        task.dailyTimes = ['09:00'];
      }
      task.scheduleType = next;
      await commit();
      await api.resetTask(task.id);
      render();
    },

    async 'set-mode'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.reminderMode = el.dataset.value;
      // 提醒方式纯粹是前端的事，后端不需要知道 —— 同步一下只是为了让
      // 任务表保持一致，不发也行
      await commit();
      render();
    },

    /** 打字：只改 store，不重绘（重绘会把光标弹走） */
    'task-title:input'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.title = el.value;
      scheduleCommit(commit);
    },

    'time-draft:input'(el) {
      state.timeDrafts[el.dataset.id] = el.value;
    },

    async 'add-time'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      const input = el.parentElement.querySelector('[data-act="time-draft"]');
      const raw = state.timeDrafts[task.id] ?? input?.value ?? '';
      const times = normalizeTimes(raw);
      if (!times.length) {
        toast(S.toastBadTime, 'warning');
        return;
      }
      if (task.dailyTimes.includes(times[0])) {
        toast(S.toastDupeTime, 'warning');
        return;
      }
      task.dailyTimes = normalizeTimes([...task.dailyTimes, times[0]]);
      state.timeDrafts[task.id] = '';
      await commit();
      await api.resetTask(task.id);
      render();
    },

    async 'quick-time'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.dailyTimes = normalizeTimes([...task.dailyTimes, el.dataset.value]);
      await commit();
      await api.resetTask(task.id);
      render();
    },

    async 'drop-time'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      task.dailyTimes = task.dailyTimes.filter(t => t !== el.dataset.value);
      await commit();
      await api.resetTask(task.id);
      render();
    },

    async 'add-task'() {
      const task = newTask();
      state.settings.tasks.push(task);
      state.expandedTaskId = task.id;
      await commit();
      render();
    },

    async 'delete-task'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      const yes = await api.confirm(S.deleteTaskConfirm(taskTitle(task)), S.deleteTask);
      if (!yes) return;
      state.settings.tasks = state.settings.tasks.filter(t => t.id !== task.id);
      if (state.expandedTaskId === task.id) state.expandedTaskId = null;
      await commit();
      toast(S.toastDeleted, 'success');
      render();
    },

    /* ---- 休息时长：数字框、单位按钮，两条路都汇进 applyDuration ---- */

    // 键入过程中**不**动 store：往大改超过 10 分钟要验指纹，逐键提交等于
    // 敲 "180" 就弹三次指纹。数字本来就在 DOM 里，不必往 store 抄一份。
    // 注册这个空处理器只是为了让 assertHandlers 闭嘴（它按 data-act 找键）。
    'lock-duration:input'() {},

    async 'lock-duration:change'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      const per = DURATION_UNITS[task.durationUnit] || DURATION_UNITS.min;
      const shown = clampInt(el.value, 1, Math.floor(DURATION_MAX / per), 1);
      await applyDuration(task, shown * per);
    },

    /**
     * 换单位改的是**那个数字的含义**，不做换算：框里是 1，点「小时」就是 1 小时。
     * 想成"我要休息 1 小时"比"我要休息 60 秒、换算成小时是多少"自然得多。
     * 副作用是这个动作可能让时长变大 —— 那它会和其他加码一样要验证，这是对的。
     */
    async 'set-duration-unit'(el) {
      const task = taskById(el.dataset.id);
      if (!task) return;
      const unit = el.dataset.value;
      const per = DURATION_UNITS[unit];
      if (!per) return;
      const shown = clampInt(
        el.closest('.duration-row')?.querySelector('input')?.value,
        1,
        Math.floor(DURATION_MAX / per),
        1
      );
      await applyDuration(task, shown * per, unit);
    },

    /* ---- 步进器：加减按钮和输入框共用同一个 data-act，各占一个键 ---- */

    ...Object.fromEntries(
      Object.entries(TASK_STEPS).flatMap(([field, [min, max]]) => [
        [
          field,
          el => {
            const task = taskById(el.dataset.id);
            if (!task) return;
            const next = clampInt(task[field] + Number(el.dataset.delta), min, max, task[field]);
            task[field] = next;
            // 只改这个控件自己的值。整棵重绘会把这行以下的 DOM 全部重建，
            // 顺带把展开区里正在编辑的东西弹掉。
            const input = el.parentElement.querySelector('input');
            if (input) input.value = String(next);
            // 改了间隔等于改了排期，得让后端重排
            if (field === 'interval') api.resetTask(task.id);
            scheduleCommit(commit);
          },
        ],
        [
          `${field}:input`,
          el => {
            const task = taskById(el.dataset.id);
            if (!task) return;
            task[field] = clampInt(el.value, min, max, task[field]);
            scheduleCommit(commit);
          },
        ],
      ])
    ),

    /* ============================== 设置页 ============================== */

    ...Object.fromEntries(
      Object.entries(SWITCHES).map(([act, key]) => [
        act,
        async () => {
          state.settings[key] = !state.settings[key];
          await commit({ resync: false });
          render();
        },
      ])
    ),

    async 'toggle-autostart'() {
      const next = !state.settings.autoStart;
      autostart.setBusy(true);
      try {
        if (next) await api.autostartEnable();
        else await api.autostartDisable();
        state.settings.autoStart = next;
        await commit({ resync: false });
      } finally {
        autostart.setBusy(false);
        render();
      }
    },

    async 'set-media'(el) {
      state.settings.lockMediaMode = el.dataset.value;
      await commit({ resync: false });
      render();
    },

    'idle-threshold'(el) {
      const current = Math.round(state.settings.idleThreshold / 60);
      const next = clampInt(current + Number(el.dataset.delta), 1, 60, current);
      applyIdleThreshold(el, next);
    },

    'idle-threshold:input'(el) {
      applyIdleThreshold(el, clampInt(el.value, 1, 60, Math.round(state.settings.idleThreshold / 60)));
    },

    async 'pick-sound'() {
      const path = await api.pickFile([
        { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] },
      ]);
      if (!path) return;
      state.settings.customSoundPath = path;
      await commit({ resync: false });
      render();
    },

    'test-sound'() {
      api.testCustomSound(state.settings.customSoundPath);
    },

    async 'clear-sound'() {
      state.settings.customSoundPath = '';
      await commit({ resync: false });
      render();
    },

    async 'pick-image'() {
      const path = await api.pickFile([
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] },
      ]);
      if (!path) return;
      state.settings.lockScreenBgImage = api.convertFileSrc(path);
      await commit({ resync: false });
      render();
    },

    async 'clear-image'() {
      state.settings.lockScreenBgImage = '';
      await commit({ resync: false });
      render();
    },

    /**
     * 检查更新：只问 GitHub 上有没有更新的 tag，**不下载、不安装**。
     *
     * 上一版是 updater 插件的 downloadAndInstall，那需要一对签名密钥，
     * 而配置里那对属于上游项目。现在有新版就把人送到 release 页自己下。
     * 少了一点省事，换来的是不用保管私钥，也不会装成别人的包。
     */
    async 'check-update'() {
      const result = await api.checkUpdate();
      if (result.status !== 'ok') {
        toast(S.updateFail, 'error');
      } else if (isNewer(result.latest, state.version)) {
        // 先出提示再开浏览器：外链是异步的，提示不上屏的话用户会以为没反应
        toast(S.updateAvailable(result.latest));
        api.openExternal(result.url);
      } else {
        toast(S.updateLatest, 'success');
      }
      render();
    },

    /* ============================== 居中浮窗 ============================== */

    async 'reminder-confirm'() {
      await ctx.reminder.finish();
    },

    async 'reminder-snooze'() {
      await ctx.reminder.snooze();
    },

    /* ============================== 锁屏 ============================== */

    async 'lock-finish'() {
      await lock.finish();
    },

    'lock-wait'() {
      toast(S.gateWaiting, 'warning');
    },

    async 'lock-snooze'() {
      await lock.snooze();
    },

    'gate-open'() {
      state.lock.gateOpen = true;
      render();
    },

    /** 闸门输入：就地更新，绝不重绘 */
    'gate-input:input'(el) {
      const { value, matched } = acceptInput(el.value);
      if (el.value !== value) {
        // 弹回多余字符，并把光标放在末尾
        const at = Math.min(matched, value.length);
        el.value = value;
        el.setSelectionRange(at, at);
      }
      onGateInput(value);
      syncGate(el.closest('.gate'), value, matched);
      scheduleGateCommit(matched);
    },

    async 'gate-submit'() {
      await lock.finish();
    },
  };

  return handlers;
}

/**
 * 打字类动作的落盘节流。
 *
 * 每敲一个字母就写一次盘，是在用磁盘寿命换"最后三个字母没存上"这种
 * 完全不重要的东西。250ms 足够覆盖"停下想一想"的间隔。
 */
let commitTimer = null;
function scheduleCommit(commit) {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => commit({ resync: false }), 250);
}

/**
 * 闸门进度的落盘节流。
 *
 * `lock.json` 里一直有个 `gate_matched` 字段，锁屏上那句"重启后不用重打"
 * 也一直这么写着 —— 但在此之前**没有任何地方更新它**，它停在锁开始时的 0，
 * 重启就得从头敲 256 个字符。每敲一个字符写一次盘又太狠，所以和打字共用
 * 同一套节流思路，只是间隔更稀：闸门进度丢几百毫秒无关紧要。
 */
let gateCommitTimer = null;
function scheduleGateCommit(matched) {
  clearTimeout(gateCommitTimer);
  gateCommitTimer = setTimeout(() => {
    lock.rememberGate(matched).catch(err => console.error('[gate] 进度落盘失败', err));
  }, 400);
}

/**
 * 版本号比较。只比数字段 —— 我们的 tag 就是 `v0.0.1` 这种，没有预发布后缀，
 * 不值得为它引一个 semver 库。
 *
 * 比的是"仓库里那个是不是比我新"，不是"是不是不一样"：本地开发构建
 * （版本号已经往前挪过）不该被提示说有新版本。
 */
function isNewer(candidate, current) {
  const parse = v =>
    String(v || '')
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
