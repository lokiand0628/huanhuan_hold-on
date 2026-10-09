/**
 * 256 字符闸门（计划 §3.9）。
 *
 * 「强制」成不成立，取决于**拦不拦得住粘贴**，不取决于 256 这个数字 ——
 * 28 个字符如果能 Ctrl+V 进去，和 2 个没有区别。
 *
 * 所以这里有四层：
 *   1. `paste` 事件 preventDefault
 *   2. `keydown` 里拦 Cmd/Ctrl+V / X（有的输入法不发 paste 事件）
 *   3. `beforeinput` 拦 insertFromPaste
 *   4. **只接受"从头连续对上"的前缀**，多出来的字符当场弹回。
 *      前三层是体验，这一层才是真正兜底的 —— 连"用脚本整段塞进 value"
 *      也只能塞进正确的前缀。
 *
 * 诚实边界：真正的威胁是脚本化逐字符模拟输入，那在这个威胁模型内拦不住。
 */
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { S } from '../core/strings.js';
import { current, gateMatched, gateTotal } from '../core/lockstate.js';

export function renderGate(input) {
  const record = current();
  const target = record?.gate_text || '';
  const matched = gateMatched(input);

  return h(
    'div',
    { class: 'gate', dataset: { role: 'gate' } },
    h('div', { class: 'gate-title' }, S.lockGateTitle),
    h('div', { class: 'gate-hint' }, S.gateHint),
    h('div', { class: 'passage', dataset: { role: 'gate-passage' } }, format(target, matched, input.length)),

    h(
      'textarea',
      {
        class: 'gate-input',
        rows: '4',
        spellcheck: 'false',
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
        placeholder: '在这里一个字一个字打出来',
        value: input,
        dataset: { act: 'gate-input' },
        // 三层拦粘贴。前两层是体验（连"按了没反应"都不该发生），
        // 真正兜底的是 acceptInput —— 它只接受正确的前缀。
        onpaste: event => event.preventDefault(),
        ondrop: event => event.preventDefault(),
        onbeforeinput: event => {
          const type = event.inputType || '';
          if (type.startsWith('insertFromPaste') || type.startsWith('insertFromDrop')) {
            event.preventDefault();
          }
        },
        onkeydown: event => {
          const key = String(event.key || '').toLowerCase();
          // Cmd/Ctrl+V、Cmd/Ctrl+X、Shift+Insert：粘贴的三种走法
          if ((event.metaKey || event.ctrlKey) && (key === 'v' || key === 'x')) {
            event.preventDefault();
            return;
          }
          if (event.shiftKey && key === 'insert') event.preventDefault();
        },
      },
      null
    ),

    h(
      'div',
      { class: 'gate-bar' },
      h('div', { class: 'gate-track' }, h('i', { dataset: { role: 'gate-progress' } })),
      h(
        'div',
        { class: 'gate-status', dataset: { role: 'gate-status' } },
        icon('clock', { size: 15 }),
        h('span', { dataset: { role: 'gate-status-text' } }, S.gateProgress(matched, target.length))
      ),
      h(
        'button',
        { class: 'btn btn-primary btn-sm', dataset: { act: 'gate-submit' }, disabled: true },
        S.gateDone
      )
    )
  );
}

/**
 * 把目标文本切成"已对上 / 光标位置 / 未对上"。
 *
 * 每 4 个字母一空格、每 32 个换行 —— 256 个连着的字母是没法逐字符比对的，
 * 分组之后眼睛能落在组上，错一个字符立刻看得出来。
 */
function format(target, matched, typedLength) {
  const nodes = [];
  for (let i = 0; i < target.length; i += 1) {
    const cls = i < matched ? 'ok' : i === matched && typedLength >= matched ? 'here' : '';
    nodes.push(h('span', { class: cls }, target[i]));
    if ((i + 1) % 4 === 0) nodes.push(h('span', { class: 'gap' }, ' '));
    if ((i + 1) % 32 === 0) nodes.push(h('br'));
  }
  return nodes;
}

/**
 * 校验一次输入，返回"该留在输入框里的值"。
 *
 * 这就是第 4 层：`accepted` 永远只是目标文本的一个正确前缀。
 * 粘贴进去的整段、脚本塞进来的整段，都会在这里被砍回前缀长度。
 */
export function acceptInput(raw) {
  const target = current()?.gate_text || '';
  const typed = String(raw || '').replace(/\s+/g, '');
  let matched = 0;
  while (matched < typed.length && matched < target.length && typed[matched] === target[matched]) {
    matched += 1;
  }
  return {
    value: target.slice(0, matched),
    matched,
    total: target.length || gateTotal(),
    complete: matched >= target.length && target.length > 0,
  };
}

/**
 * 输入过程中的**就地**更新：只改文本节点、进度条宽度和状态文字。
 *
 * 绝不能整棵重绘 —— 那会把 textarea 连同焦点一起换掉，
 * 正在打第 30 个字母的人会被弹回第 1 个。
 */
export function syncGate(gate, input, matched) {
  const target = current()?.gate_text || '';
  const passage = gate.querySelector('[data-role="gate-passage"]');
  if (passage) passage.replaceChildren(...format(target, matched, input.length));

  const bar = gate.querySelector('[data-role="gate-progress"]');
  if (bar) bar.style.width = `${target.length ? (matched / target.length) * 100 : 0}%`;

  const status = gate.querySelector('[data-role="gate-status"]');
  const text = gate.querySelector('[data-role="gate-status-text"]');
  const complete = matched >= target.length && target.length > 0;
  const wrong = input.length > matched;

  if (status) status.dataset.state = complete ? 'ok' : wrong ? 'bad' : 'typing';
  if (text) {
    text.textContent = complete
      ? S.gatePass
      : wrong
        ? S.gateWrong
        : S.gateProgress(matched, target.length);
  }

  const textarea = gate.querySelector('textarea');
  if (textarea) {
    textarea.classList.toggle('ok', complete);
    textarea.classList.toggle('bad', wrong);
  }

  const submit = gate.querySelector('[data-act="gate-submit"]');
  if (submit) submit.disabled = !complete;
}
