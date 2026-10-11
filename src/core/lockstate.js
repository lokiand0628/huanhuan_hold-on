/**
 * 强制锁的状态机（计划 §3.4）。
 *
 * 顺序是语义的一部分，不能调换：
 *
 *   1. 先原子写 `armed:false`  →  2. 再启动强制  →  3. 锁屏渲染出来 →  4. 翻 `armed:true`
 *
 * 反过来（先上锁再写文件）会留下一个真实的逃生口：锁一出现就 `kill -9`，
 * 文件还没落盘，重启后干干净净。第 1 步先写 false 则相反 —— 上锁途中死掉，
 * 下次启动读到 `armed:false`，判定为"死在半路"，删掉文件正常启动。这就是防砖闸。
 *
 * 第 4 步之后的每次心跳除了证明"前端还活着"，还把单调检查点往前推，
 * 用来堵住"把系统时钟往回拨"这条唯一能缩短休息的路。
 */
import { api } from './api.js';
import { state } from './store.js';
import { taskTitle, taskDesc } from './strings.js';
import {
  makeLockRecord,
  saveLock,
  clearLock,
  readPendingLock,
  remainingSeconds,
  advanceCheckpoint,
} from './persist.js';

const GATE_LENGTH = 256;
const HEARTBEAT_MS = 1000;
/** 检查点大约每 10 秒落一次盘 —— 心跳是 1 秒，但磁盘不必每秒写 */
const CHECKPOINT_EVERY = 10;
const GATE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz';

let record = null;
let heartbeat = null;
let lastCheckpointAt = 0;
let subscribers = new Set();

/* ============================== 闸门文本 ============================== */

/**
 * 256 个随机小写字母。剔掉了 l / o，其余 24 个字母在等宽字体下不会看错。
 *
 * 用 crypto 而不是 Math.random：闸门文本是可预测的话，"输入超长文本"这道
 * 出口就退化成了走过场 —— 反正内容已知。
 */
export function newGateText(length = GATE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const out = new Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = GATE_ALPHABET[bytes[i] % GATE_ALPHABET.length];
  }
  return out.join('');
}

/* ============================== 订阅 ============================== */

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) {
    try {
      fn();
    } catch (err) {
      console.error('[lockstate]', err);
    }
  }
}

export function current() {
  return record;
}

export function isLocked() {
  return !!record;
}

/** 剩余秒数。每次问都是重新算的 —— 没有内存里的递减计数器可以骗。 */
export function remaining() {
  return record ? remainingSeconds(record) : 0;
}

/** 休息进度 0..1，给表盘弧线用。旧版这里读了一个不存在的字段，弧线永远是 NaN。 */
export function progress() {
  if (!record) return 0;
  const total = record.duration_secs || 1;
  return Math.min(1, Math.max(0, (total - remaining()) / total));
}

/* ============================== 进入 ============================== */

/**
 * 由一次真实触发进入强制锁。
 *
 * @param {object} task     触发它的任务（可能已被删除 —— 所以字段要抄进 record）
 * @param {object} options  durationSecs / bgImage / canSnooze
 *
 * `canSnooze` 由调用方裁决（见 main.js 的 handleTrigger）：锁屏强制的推迟
 * **只给一次**，所以它是 true/false，不是一个"还剩几次"的计数。
 * 从前这里放的是任务的 `maxSnooze` 次数预算，但预算活在 `lock.json` 里、
 * 而推迟会整场结束这次锁并把文件删掉，于是每轮都从满格重新开始 ——
 * 次数显示永远不变，推迟可以无限点。**不留可丢的计数，就没有可丢的东西。**
 */
export async function startLock(task, options = {}) {
  const durationSecs = Math.max(
    5,
    Math.round(options.durationSecs ?? task?.lockDuration ?? state.settings.lockDuration ?? 60)
  );

  const built = makeLockRecord({
    taskId: task?.id ?? null,
    title: taskTitle(task),
    desc: taskDesc(task),
    icon: task?.icon || 'sparkles',
    bgImage: options.bgImage ?? state.settings.lockScreenBgImage ?? '',
    durationSecs,
    strict: true,
    startedAtEpoch: Math.floor(Date.now() / 1000),
    elapsedAtCheckpoint: 0,
    gateText: newGateText(),
    gateMatched: 0,
    // 推迟的出口资格也一并落盘：恢复出来的锁不该凭空多出一次推迟机会，
    // 也不该因为"任务已经被删了"就变成完全不能推迟。
    extra: {
      snooze_minutes: task?.snoozeMinutes ?? 5,
      max_snooze: options.canSnooze ? 1 : 0,
    },
  });

  // 第 1 步：先落盘 armed:false。这一步失败也要继续 —— 只是失去了跨重启强制，
  // 不该因此连本次休息都不做了。
  await saveLock(built);

  record = built;
  state.lock = makeViewState(built);

  await engage(built);
  notify();
}

/**
 * 第 4 步：锁屏真的渲染出来了，这时才把 `armed` 翻成 true 并开始心跳。
 * 由锁屏视图在首次绘制完成后调用。**注意它同时也是"冷启动恢复"的入口。**
 */
export async function armAfterRender() {
  if (!record) return;

  // 先报活，再落盘 armed:true —— 顺序不能反。
  //
  // 反过来的话，这两步之间那一瞬死掉，会留下一个最难处理的组合：
  // 文件说 `armed:true`，而 Rust 从没收到过任何报活。看门狗没有基线就不判定，
  // 于是锁屏永久空白、强制还在——正是 §3.4 要堵的那种砖。
  await api.lockHeartbeat();

  // `armed` 的翻转只做一次。冷启动恢复出来的锁本来就是 true
  // （`restorePendingLock` 判过 `armed !== true` 就不认）。
  if (!record.armed) {
    record.armed = true;
    await saveLock(record);
  }

  // 心跳无论如何都要起，不能跟着上面那个 if 一起被跳过。
  //
  // 这是恢复路径上很容易漏的一格：恢复了锁、`armed` 已是 true，于是
  // 上面整段跳过、心跳也一并没起。而 Rust 那边 `engage()` 刚调过
  // `setLockScreenActive(true)`，它把看门狗基线清成了 `last: None` ——
  // 之后再没有任何报活，看门狗就永远不判定。这时候杀掉 webview 得到的是
  // 一块砖：窗口空白、强制还在、闸门看不见。**看门狗守住的正是恢复出来的锁。**
  //
  // `startHeartbeat()` 自己先 `stopHeartbeat()`，所以重复调用是安全的。
  startHeartbeat();
  notify();
}

/**
 * 冷启动：读挂起的锁。返回是否恢复成功（失败一律放行，不锁死）。
 *
 * @param {object} options
 *   `allowUnarmed` 给副屏用。副屏是在 `enter_lock_mode` 里同步建出来的，
 *   那一刻 `armed` 还是 false（主屏前端还没渲染完），按主屏那套判定它们会
 *   集体看不到锁 → 一整排副屏全黑。副屏要的只是"把这次休息画出来"。
 */
export async function restorePendingLock({ allowUnarmed = false, engage: shouldEngage = true } = {}) {
  const raw = allowUnarmed ? await api.lockStateRaw() : await readPendingLock();
  if (!raw) return false;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[lock] lock.json 解析失败，按未上锁处理');
    await clearLock();
    return false;
  }

  if (parsed?.schema_version !== 1 || (!allowUnarmed && parsed?.armed !== true)) {
    if (!allowUnarmed) await clearLock();
    return false;
  }

  // 休息时间早就够了（比如关机放了一夜）—— 不必把人再关回去一次。
  // 副屏没有删文件的权限：那个决定只能由主屏来做。
  if (remainingSeconds(parsed) <= 0) {
    if (!allowUnarmed) await clearLock();
    return false;
  }

  record = parsed;
  state.lock = makeViewState(parsed);

  // 走和"新触发"完全相同的强制路径：两个循环各要一个标志位，缺一不可。
  //
  // 副屏**绝不能**走这一步：`enter_lock_mode` 会再枚举一次显示器并再建一批
  // 副屏窗口，副屏调它等于递归生窗口。
  if (shouldEngage) await engage(parsed);

  notify();
  return true;
}

/** 视图用的那份。闸门输入和"展开着没有"是纯界面状态，不进 lock.json。 */
function makeViewState(record_) {
  return {
    ...record_,
    total: record_.duration_secs,
    gateOpen: false,
    gateInput: '',
    // `max_snooze` 落盘时是 0/1，这里就照它译成"给不给推迟出口"。
    // 用布尔而不是数字，是为了让视图不可能再把它当成"还剩几次"去显示。
    canSnooze: (record_.max_snooze ?? 0) > 0,
    snoozeMinutes: record_.snooze_minutes ?? 5,
  };
}

/**
 * 启动强制。两个循环各要一个标志位：
 *   - `setLockScreenActive(true)` 打开 Rust 的锁屏 watchdog（冻结任务计时器 + 补副屏）
 *   - `enterLock` 打开焦点守护（并把主窗口拉成全屏）
 * 缺任何一个，"强制"都不成立。
 *
 * `enter_lock_mode` 的参数形状必须与 Rust 的 `LockTaskArgs` 完全一致，
 * 少一个字段整个命令就反序列化失败 —— 失败的是 enterLock，但后果是
 * 一个没有强制循环的锁屏，看起来像锁、实际点一下就没了。
 */
async function engage(built) {
  await api.setLockScreenActive(true);
  await api.enterLock({
    title: built.title,
    desc: built.desc,
    duration: built.duration_secs,
    icon: built.icon,
    strict_mode: true,
    // `max_snooze` 现在是 0/1 的"给不给推迟出口"（见 startLock），照形映射。
    // 这两个字段只进副屏窗口的 URL（Rust 的 create_slave_window），副屏不画
    // 按钮 —— 形状对得上 `LockTaskArgs` 就行。
    allow_strict_snooze: (built.max_snooze ?? 0) > 0,
    max_snooze_count: built.max_snooze ?? 0,
    snooze_minutes: built.snooze_minutes ?? 5,
    current_snooze_count: 0,
    bg_image: built.bg_image || '',
  });
}

/* ============================== 心跳 ============================== */

function startHeartbeat() {
  stopHeartbeat();
  lastCheckpointAt = Date.now();
  heartbeat = setInterval(async () => {
    if (!record) return;

    // 每秒报活一次。Rust 用它判断渲染锁屏的 webview 还活着没有；断了就重载
    // webview（不静默解锁）。**只有主窗口发这个信号** —— 副屏要是也发，
    // 就会把"主屏 webview 已死"整个盖住，看门狗永远不触发。
    await api.lockHeartbeat();

    // 休息已经够了：不再刷新检查点（刷了也没用，remaining 已经是 0）
    if (remaining() <= 0) return;
    if (Date.now() - lastCheckpointAt < CHECKPOINT_EVERY * 1000) return;
    lastCheckpointAt = Date.now();
    if (advanceCheckpoint(record)) await saveLock(record);
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/* ============================== 闸门 ============================== */

/** 逐字符校验：只有从头连续对上的长度算数，错一个字符不重置也不放行。 */
export function gateMatched(input) {
  if (!record?.gate_text) return 0;
  const target = record.gate_text;
  const typed = String(input || '').replace(/\s+/g, '');
  let i = 0;
  while (i < typed.length && i < target.length && typed[i] === target[i]) i += 1;
  return i;
}

export function gateTotal() {
  return record?.gate_text?.length || GATE_LENGTH;
}

/** 输入过程中落一次进度，重启后不用重打。 */
export async function rememberGate(matched) {
  if (!record) return;
  if (matched === record.gate_matched) return;
  record.gate_matched = matched;
  if (state.lock) state.lock.gateMatched = matched;
  await saveLock(record);
}

/* ============================== 结束 ============================== */

/**
 * 正常完成。只有这条路径会清掉 lock.json ——
 * `kill -9` 和重启都会把它留下，那正是目的。
 */
export async function finishLock() {
  stopHeartbeat();
  record = null;

  // 先解锁屏冻结，再删文件：两个循环都停下来之后，文件才没有意义
  await api.setLockScreenActive(false);
  await api.exitLock(true);
  await clearLock();

  state.lock = null;
  notify();
}

/** 退出前把闸门进度和最不利的检查点存下来 */
export async function persistBeforeExit() {
  if (!record) return;
  advanceCheckpoint(record);
  await saveLock(record);
}
