/**
 * 锁屏（`?mode=lock`）。全屏、暗色、多屏同步，主屏由 Rust 复用 `main` 窗口。
 *
 * 这里修掉了旧版两个真问题：
 *   - 表盘弧线读 `state.lock.total`，而那个字段从来没被赋过值 → 比例恒为 NaN，
 *     弧线永远不动。现在 total 是 record 里抄下来的 duration_secs。
 *   - 「解锁闸门永远不出现」：没有任何视图输出过触发它的元素。现在闸门是
 *     这个视图的一个真实分支。
 *
 * 渲染是幂等的：任何一次重绘（含 webview 重载）都能从 `lock.json` 复原出
 * 一模一样的界面 —— 锁屏在渲染上不能是"某个 state 的一个分支"，那意味着
 * 一次异常就能让它蒸发而 Rust 还在强制。
 */
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { S } from '../core/strings.js';
import { fmt } from '../core/countdown.js';
import { current, remaining, progress } from '../core/lockstate.js';
import { renderGate } from './Gate.js';

const RADIUS = 116;
const CIRCUM = 2 * Math.PI * RADIUS;

export function renderLock({ gateOpen, gateInput, canSnooze = false, snoozeMinutes = 5, slave = false }) {
  const record = current();
  if (!record) return h('div', { class: 'lock-screen' }, h('div', { class: 'lock-kicker' }, S.lockKicker));

  const left = remaining();

  const screen = h(
    'div',
    { class: 'lock-screen' },
    record.bg_image ? bgLayer(record.bg_image) : null,
    h('div', { class: 'lock-kicker' }, S.lockKicker),
    renderDial(left, record.duration_secs),
    h('div', { class: 'lock-title' }, record.title || S.lockKicker),
    record.desc ? h('div', { class: 'lock-desc' }, record.desc) : null
  );

  // 副屏只负责"把休息这件事铺满每一块屏幕"，按钮和闸门都留在主屏。
  // 副屏上放一个「完成」会造成两块屏幕上两个都能点的出口。
  if (!slave) {
    screen.append(renderActions({ done: left <= 0, canSnooze, snoozeMinutes }));
    screen.append(renderGateArea({ gateOpen, gateInput }));
  }

  return screen;
}

/* ============================== 表盘 ============================== */

function renderDial(left, total) {
  const ratio = total ? Math.min(1, Math.max(0, (total - left) / total)) : 0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 260 260');
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of Object.entries({ cx: 130, cy: 130, r: RADIUS, class: 'track' })) {
    track.setAttribute(k, String(v));
  }

  const value = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of Object.entries({
    cx: 130,
    cy: 130,
    r: RADIUS,
    class: 'value',
    'data-role': 'lock-arc',
    'stroke-dasharray': String(CIRCUM),
    'stroke-dashoffset': String(CIRCUM * (1 - ratio)),
  })) {
    value.setAttribute(k, String(v));
  }

  svg.append(track, value);

  return h(
    'div',
    { class: 'lock-dial' },
    svg,
    h(
      'div',
      { class: 'readout' },
      h('div', { class: 'clock', dataset: { role: 'lock-clock' } }, fmt(left)),
      h('div', { class: 'unit' }, left > 0 ? S.lockRemaining : S.done)
    )
  );
}

function bgLayer(path) {
  return h('div', {
    class: 'lock-bg',
    style: { backgroundImage: `url("${path.replace(/"/g, '%22')}")` },
  });
}

/* ============================== 按钮 ============================== */

function renderActions({ done, canSnooze, snoozeMinutes }) {
  return h(
    'div',
    { class: 'lock-actions' },
    h(
      'button',
      {
        class: 'btn btn-primary btn-block',
        dataset: { act: done ? 'lock-finish' : 'lock-wait' },
        disabled: !done,
      },
      icon('check', { size: 16 }),
      S.lockFinish
    ),
    // 推迟是**一次性的**：只有本次触发之前没用过推迟，才有这个按钮 ——
    // 推迟到点又弹出来的那一次 `canSnooze` 是 false，只剩「完成休息」。
    // 按钮下面那句小字把"仅此一次"说明白；从前写的是"还能推迟 N 次"，
    // 而那是个永远停在初始值的数字（见 lockstate.js 的 startLock）。
    canSnooze
      ? h(
          'div',
          { class: 'lock-snooze' },
          h(
            'button',
            { class: 'btn btn-ghost btn-block', dataset: { act: 'lock-snooze' } },
            S.lockSnooze(snoozeMinutes)
          ),
          h('div', { class: 'lock-snooze-note' }, S.lockSnoozeOnce)
        )
      : null
  );
}

/**
 * 闸门收在一句小字后面。这是一层刻意的摩擦：
 * 它不该是"休息中"界面上伸手就能点到的东西。
 */
function renderGateArea({ gateOpen, gateInput }) {
  const wrap = h('div', { class: 'gate-wrap' });

  if (!gateOpen) {
    wrap.append(
      h(
        'button',
        { class: 'gate-trigger', dataset: { act: 'gate-open' } },
        S.lockEmergency
      )
    );
    return wrap;
  }

  wrap.append(renderGate(gateInput || ''));
  return wrap;
}

/* ============================== 局部更新 ============================== */

/**
 * 每秒只改文本节点和一条 dashoffset。
 * 旧版每秒对每张卡片重写 innerHTML —— 那会把正在打字的输入框一起换掉。
 */
export function tickLock(root) {
  if (!root) return;
  const left = remaining();
  const record = current();
  if (!record) return;

  const clock = root.querySelector('[data-role="lock-clock"]');
  if (clock) {
    const text = fmt(left);
    if (clock.textContent !== text) clock.textContent = text;
  }

  const arc = root.querySelector('[data-role="lock-arc"]');
  if (arc) {
    const ratio = Math.min(1, Math.max(0, progress()));
    arc.setAttribute('stroke-dashoffset', String(CIRCUM * (1 - ratio)));
  }

  // 归零那一刻要把「完成休息」放出来，这是一次结构变更，只能重绘
  return !!(root.querySelector('[data-act="lock-wait"]') && left <= 0);
}
