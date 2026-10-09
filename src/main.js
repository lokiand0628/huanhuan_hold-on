/**
 * 入口与路由。
 *
 *   （默认）          主窗口：提醒 / 设置 两页；**锁屏也在这个窗口里渲染**
 *   ?mode=reminder    居中浮窗（独立小窗）
 *   ?mode=lock_slave  副屏锁屏（Rust 为每块副屏建一个）
 *
 * 主屏锁屏刻意复用 main 窗口，不另开一个：每一个强制原语都硬绑在字面量
 * `"main"` 上（焦点守护、watchdog、close guard、托盘 show），把它们全部
 * 参数化的风险远大于收益，而"强制"恰恰是最不能坏的那部分。所以这里的做法是
 * **不换窗口**，只在同一个窗口里把路由切成锁屏。
 *
 * 三条纪律，都是旧版栽过的地方：
 *   1. 打字类动作不整棵重绘（见 actions.js）。
 *   2. 倒计时只改文本节点。
 *   3. **锁屏在 boot 里必须能被复原** —— 一次 JS 异常不该让锁屏蒸发而
 *      Rust 还在抢焦点。所以每一步都单独兜底，render 是幂等的。
 */
import './design/tokens.css';
import './design/base.css';
import './design/components.css';

import { api } from './core/api.js';
import { state, normalize, toBackendTasks, taskById } from './core/store.js';
import { saveSettings } from './core/persist.js';
import * as lock from './core/lockstate.js';
import { createActions } from './core/actions.js';
import { initCountdowns, subscribeCountdowns, fmt, bestRemaining } from './core/countdown.js';
import { renderApp, renderToasts } from './views/App.js';
import { renderReminder } from './views/Reminder.js';
import { renderLock, tickLock } from './views/Lock.js';
import { mount, delegate, assertHandlers } from './ui/dom.js';
import { S, taskTitle, taskDesc } from './core/strings.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') || 'main';
const IS_SLAVE = MODE === 'lock_slave' || MODE === 'lock';
const root = document.getElementById('app');

// 路由属性要在**任何 await 之前**就落上：它决定 body 是浅色、暗色还是透明，
// 晚一步就会先闪一下错的底色。
//
// 居中浮窗那条路尤其不能省。它的 boot 第一句就是 await，而且它根本不走
// `render()`（render 对 reminder 提前 return），`applyRoute()` 又只在 render 里调 ——
// 所以除这一行之外，没有任何地方会给它设上 `data-route="reminder"`。
// 漏掉的表现是：无边框透明窗口里糊着一整块不透明的浅灰方角（body 的默认底），
// 圆角卡片的阴影和四周留白全没了。
document.body.dataset.route = MODE === 'reminder' ? 'reminder' : 'main';

/* ============================== 提示条 ============================== */

let toastSeq = 0;
function toast(text, tone = 'neutral') {
  if (MODE !== 'main') return;
  const id = ++toastSeq;
  state.toasts = [...state.toasts, { id, text, tone }];
  renderToastsInto();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    renderToastsInto();
  }, 2600);
}

/**
 * 只重画提示条那一块，**不调 `render()`**。
 *
 * `render()` 是整棵重绘，会把页面上所有输入框换掉。而 toast 偏偏是被
 * 「删除任务 / 全部重置 / 检查更新」这类动作触发的 —— 用户完全可能紧接着
 * 就开始打字，于是 2.6 秒后那次整棵重绘会连焦点带没提交的草稿一起吞掉
 * （锁定时长那个输入框的数字只存在 DOM 里，见 actions.js 的 `applyDuration`）。
 * 提示条不在任何输入控件的祖先链上，所以单独重建它是安全的。
 */
function renderToastsInto() {
  const box = root.querySelector('.toasts');
  if (box) mount(box, renderToasts());
}

/* ============================== 渲染 ============================== */

let autostartBusy = false;

/**
 * 重绘。
 *
 * 主窗口在锁定期间渲染的是锁屏 —— 这就是"主屏锁屏复用 main 窗口"的落地方式。
 * 整棵重绘只在**结构真的变了**的时候发生（切页签、展开卡片、锁屏开始/结束）；
 * 每秒的倒计时走 `updateStrip()` 和 `tickLock()`，只碰文本节点。
 */
function render() {
  if (MODE === 'reminder') return;

  applyRoute();

  const previous = root.querySelector('.page');
  const top = previous ? previous.scrollTop : 0;

  if (state.lock) {
    root.replaceChildren(
      renderLock({
        gateOpen: !!state.lock.gateOpen,
        gateInput: state.lock.gateInput || '',
        snoozeLeft: state.lock.snoozeLeft ?? 0,
        snoozeMinutes: state.lock.snoozeMinutes ?? 5,
        slave: IS_SLAVE,
      })
    );
    startLockTicker();
  } else if (IS_SLAVE) {
    // 副屏没有锁可显示 —— 保持空白比显示一个假的倒计时好
    root.replaceChildren();
  } else {
    mount(root, renderApp({ autostartBusy }));
    const next = root.querySelector('.page');
    if (next) next.scrollTop = top;
  }

  assertHandlers(root, actions);
}

/** 锁屏要暗色全屏，主界面要浅色，居中浮窗要透明 —— 靠这个属性切换 */
function applyRoute() {
  document.body.dataset.route =
    MODE === 'reminder' ? 'reminder' : state.lock || IS_SLAVE ? 'lock' : 'main';
}

const actions = createActions({
  render,
  toast,
  backendTasks: toBackendTasks,
  autostart: {
    setBusy(value) {
      autostartBusy = value;
    },
  },
  onGateInput(value) {
    if (state.lock) state.lock.gateInput = value;
  },
  lock: {
    isLocked: () => lock.isLocked(),
    // 闸门进度落盘（重启后不用重打）。调用点做了节流，见 actions.js。
    rememberGate: matched => lock.rememberGate(matched),
    finish: async () => {
      const record = state.lock;
      await lock.finishLock();
      const task = record?.task_id ? taskById(record.task_id) : null;
      if (task) await api.resetTask(task.id);
      state.lock = null;
      render();
    },
    snooze: async () => {
      const record = state.lock;
      if (!record) return;
      await lock.finishLock();
      const task = record.task_id ? taskById(record.task_id) : null;
      if (task) await api.snoozeTask(task.id, task.snoozeMinutes || 5);
      state.lock = null;
      render();
    },
  },
  reminder: {
    async finish() {
      const payload = state.focus;
      await api.exitReminder();
      if (payload?.id) {
        await api.ackTriggered(payload.id);
        const task = taskById(payload.id);
        if (task) await api.resetTask(task.id);
      }
      state.focus = null;
      window.close();
    },
    async snooze() {
      const payload = state.focus;
      await api.exitReminder();
      if (payload?.id) {
        await api.ackTriggered(payload.id);
        await api.snoozeTask(payload.id, payload.snoozeMinutes || 5);
      }
      state.focus = null;
      window.close();
    },
  },
});

/* ============================== 触发投递 ============================== */

/**
 * 同一个触发有两条路会送到（Rust 的 `task-triggered` 事件 + 1 秒轮询
 * `peek_triggered_tasks` 兜底），所以必须去重，否则弹窗会弹两次。
 */
const inFlight = new Set();

async function handleTrigger(payload) {
  const id = payload?.id;
  if (!id || inFlight.has(id)) return;
  if (lock.isLocked()) return; // 休息中不叠新的提醒

  inFlight.add(id);
  setTimeout(() => inFlight.delete(id), 4000);

  const task = taskById(id);

  if (task && task.reminderMode === 'lock') {
    await api.ackTriggered(id);
    await startLockUI(task);
    return;
  }

  // 居中浮窗：交给那个独立小窗，主窗口不弹任何东西。
  // 触发在这里就 ack 掉 —— 小窗关掉之后没有人会再来 ack 它。
  await api.ackTriggered(id);
  await api.enterReminder({
    id,
    title: taskTitle(task) || payload.title,
    desc: taskDesc(task) || payload.desc,
    icon: task?.icon || payload.icon || 'sparkles',
    snoozeMinutes: task?.snoozeMinutes ?? 5,
    maxSnooze: task?.maxSnooze ?? 3,
  });
}

/** 进锁 → 渲染 → 回报 ready（这一步才把 armed 翻成 true）→ 起心跳 */
async function startLockUI(task, options) {
  await lock.startLock(task, options);
  render();
  await lock.armAfterRender();
}

function wireTriggerDelivery() {
  api.listen('task-triggered', event => handleTrigger(event.payload));

  // 兜底：事件在某些情况下会漏（窗口还没建好、webview 刚重载）。
  // 每秒问一次待处理队列，代价只是一次本地 IPC。
  setInterval(async () => {
    const pending = await api.peekTriggered();
    for (const item of pending || []) await handleTrigger(item);
  }, 1000);
}

/* ============================== 启动 ============================== */

async function boot() {
  if (MODE === 'reminder') return bootReminder();
  if (IS_SLAVE) return bootSlave();

  state.version = await api.version();
  await loadSettings();

  // 冷启动恢复：Rust 在 setup() 里已经把 `lock_screen_active` 置好了
  // （必须早于计时线程开跑，否则任务会被建成"未冻结"而在锁屏背后触发），
  // 这里负责把界面接回去。
  const restored = await lock.restorePendingLock();

  await api.syncTasks(toBackendTasks());
  await api.setIdleThreshold(state.settings.idleThreshold);
  initCountdowns(await api.countdowns());
  state.isPaused = !!(await api.isPaused());

  subscribeCountdowns(() => {
    if (!state.lock) updateStrip();
  });

  // 空闲状态：后端在 `is_idle` 翻转时推一次（低 5 秒、状态变了才推），
  // 前端此前**从来没订阅过**这个事件 —— 于是 `state.isIdle` 永远是 false，
  // 「你离开了，计时先停着」那句话永远不会出现。这里接上。
  //
  // 收到后只动顶部那一条：它既要换文案（`updateStrip`）也要换 `data-idle`
  // 的样式，但空闲翻转是低频事件，且整棵重绘会吃掉正在输入的内容，不值得。
  api.listen('idle-status-changed', event => {
    const idle = !!event?.payload?.is_idle;
    if (state.isIdle === idle) return;
    state.isIdle = idle;
    if (state.lock) return; // 锁屏时顶部那一条根本不在
    const strip = root.querySelector('.countdown-strip');
    if (strip) strip.dataset.idle = String(idle || state.isPaused);
    updateStrip();
  });

  // 退出前再落一次盘（检查点 + 闸门进度）。心跳约每秒一次、检查点约每 10 秒
  // 一次，所以正常关窗最多丢 10 秒的检查点。`pagehide` 里发 IPC 是**尽力而为**，
  // 不保证送达 —— 送了总比不送强，而且这条路平时没人依赖。
  window.addEventListener('pagehide', () => {
    lock.persistBeforeExit().catch(err => console.error('[lock] 退出前落盘失败', err));
  });

  wireTriggerDelivery();
  render();

  if (restored) {
    await lock.armAfterRender();
    startLockTicker();
  }

  // 主窗口在 tauri.conf.json 里是 `visible: false` 起的 —— 先不显示、等首屏
  // 画出来再 show，否则会先闪一下白底。**这一句不能省**：漏了的话窗口永远不
  // 出现，表现就是"双击了 app 但什么都没有"。
  //
  // 两个例外：
  //   - 自启带 `--silent` → 只留托盘，是用户要的行为
  //   - 恢复出来的锁 → 必须显示。否则就成了最坏的一种状态：强制在生效、
  //     界面却看不见，用户连休息完都点不了
  if (restored || !(await api.wasStartedSilent())) await api.showMain();

  // 从托盘回到前台时可能已经过了很久，倒计时重新问一次后端
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || state.lock) return;
    initCountdowns(await api.countdowns());
    render();
  });
}

/**
 * 每秒把主窗口顶部那一行倒计时刷新一次。
 *
 * **只改文本节点**。旧版 `patchLive()` 每秒对每张卡片重写 `innerHTML`，
 * 于是正在打字的人会被下面这一秒的重绘打断。
 */
function updateStrip() {
  // 空闲时显示的是「计时停着」，不是剩余时间 —— 必须和 renderCountdown 的
  // 判断一致。少了 `state.isIdle` 这一项，首帧画的是 `--:--`，一秒后就被
  // 这里覆盖成一个真实数字（后端把计时冻结了，`bestRemaining` 照样有值）。
  const best = state.isPaused || state.isIdle ? null : bestRemaining();
  const time = root.querySelector('[data-role="strip-time"]');
  if (time) {
    const next = state.isPaused ? '--:--' : best ? fmt(best.left) : '--:--';
    if (time.textContent !== next) time.textContent = next;
  }
  const text = root.querySelector('.cs-text');
  if (text) {
    const next = state.isPaused
      ? S.paused
      : state.isIdle
        ? S.idle
        : best
          ? `${S.nextPrefix}：${taskTitle(best.task)}`
          : S.notScheduled;
    if (text.textContent !== next) text.textContent = next;
  }
}

/* ============================== 居中浮窗 ============================== */

async function bootReminder() {
  const payload = (await api.reminderPayload()) || {};
  state.focus = payload;

  root.replaceChildren(
    renderReminder(payload, {
      snoozeMinutes: payload.snoozeMinutes || 5,
      snoozeLeft: payload.maxSnooze ?? 3,
    })
  );
  assertHandlers(root, actions);

  // 无边框透明窗：把焦点抢过来，别让用户看不见它就已经被忽略了
  root.focus();
}

/* ============================== 锁屏副屏 ============================== */

async function bootSlave() {
  // allowUnarmed：副屏建出来时主屏还没把 armed 翻成 true
  // engage:false：副屏调 enter_lock_mode 会递归再建一批副屏窗口
  const restored = await lock.restorePendingLock({ allowUnarmed: true, engage: false });
  if (!restored) {
    // 没有挂起的锁却进了这个路由：什么都不显示，也不报错。
    // Rust 会在退出锁屏时把这些窗口一起关掉。
    root.replaceChildren();
    return;
  }
  render();
}

/* ============================== 锁屏心跳 ============================== */

let lockTicker = null;
function startLockTicker() {
  if (lockTicker) return;
  lockTicker = setInterval(() => {
    if (!state.lock) {
      clearInterval(lockTicker);
      lockTicker = null;
      return;
    }
    // 归零那一刻要做一次结构变更（把「完成休息」放出来），其余时刻只改文本
    if (tickLock(root)) render();
  }, 1000);
}

/* ============================== 配置 ============================== */

async function loadSettings() {
  const raw = await api.loadSettings();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[boot] settings.json 解析失败，用默认值启动', err);
    }
  }
  state.settings = normalize(parsed);
  // 迁移过就立刻写回去，免得被丢掉的旧键一直躺在文件里
  if (parsed) saveSettings();
}

/* ============================== 起步 ============================== */

delegate(root, actions);

boot().catch(err => {
  console.error(`[boot] ${MODE} 启动失败`, err);
  // 锁屏启动失败是最危险的一种：Rust 还在强制，界面却白了。
  // 尽力把已经拿到的状态画出来 —— 每多成功一步，砖的风险就小一分。
  if (MODE === 'main') {
    try {
      render();
    } catch (inner) {
      console.error('[boot] 兜底渲染也失败了', inner);
    }
  }
});
