/**
 * 微型 DOM 工具：h() 建元素 + 一个事件委托入口
 *
 * 为什么用真实元素而不是字符串拼 innerHTML（旧版就是拼字符串）：
 *   1. 任务名、定点时间是用户输入的。拼字符串要么手工转义（漏一处就是注入），
 *      要么就得信任输入，两条路都不好。
 *   2. innerHTML 重建子树会连输入框一起换掉 —— 焦点和光标位置全丢，
 *      正在打字时任何一次重绘都会把字打断。
 *
 * 单一 data-act 驱动的分发是刻意的：旧版最严重的一类 bug 就是视图吐
 * `data-field`、处理器读 `dataset.act`，两边永远对不上而且不报错。
 * 这里点击/输入/变更三种事件全部从**同一个** data-act 派生键名，
 * 想对不上都难。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;

      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'value') el.value = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }

  append(el, children);
  return el;
}

/** 建一个 SVG 元素。图标是内置的可信标记，可以直接吃 innerHTML。 */
export function svg(markup, { size = 24, cls = '', fill = 'none', stroke = 'currentColor' } = {}) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', fill);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = markup;
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** 整棵替换，但保持滚动位置（切换页签时不该跳回顶部） */
export function mount(root, node) {
  const top = root.scrollTop;
  root.replaceChildren(node);
  root.scrollTop = top;
}

/**
 * 事件委托。三种事件的键名都从同一个 data-act 派生：
 *   点击 → `act`，输入 → `act:input`，变更 → `act:change`
 */
export function delegate(root, handlers) {
  const dispatch = suffix => event => {
    const el = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!el || !root.contains(el)) return;
    const handler = handlers[el.dataset.act + suffix];
    if (!handler) return;
    handler(el, event);
  };

  root.addEventListener('click', dispatch(''));
  root.addEventListener('input', dispatch(':input'));
  root.addEventListener('change', dispatch(':change'));

  // 键盘可达性靠原生控件：带 `data-act` 的元素**全部**是 `<button>` 或 `<input>`，
  // 前者本来就响应空格与回车，并派发一个真正的 click —— 走上面那条委托，不必另接。
  // 给后来的人：**别把带 `data-act` 的元素写成 div** —— 那样会真的丢掉键盘操作。
  //
  // keydown 只服务"在输入框里敲回车等于点旁边那个按钮"这一类补充动作，
  // 按 `键:keydown` 注册，没注册的控件完全不受影响。
  // （这里曾有个只为旧版 `<div class="switch">` 补键盘的 keydown 监听；
  // 开关换成 `<button role="switch">` 之后它就空转了，已经删掉。
  // 现在这条是重新加的，用途不同。）
  root.addEventListener('keydown', dispatch(':keydown'));
}

/**
 * 开发期断言：扫描 DOM 上所有 data-act，报告没有注册处理器的。
 *
 * 这一条直接消灭本项目最严重的一类 bug —— 旧版「解锁闸门永远不出现」
 * 的根因就是没有任何视图输出过 `data-act="lock-gate"`，而处理器干等着。
 * 那种错误编译不报、运行不报，只是功能静默消失。
 */
export function assertHandlers(root, handlers) {
  const missing = new Set();
  root.querySelectorAll('[data-act]').forEach(el => {
    const act = el.dataset.act;
    if (handlers[act] || handlers[`${act}:input`] || handlers[`${act}:change`]) return;
    // 纯展示用的磁贴（分段控件里由父级接管）允许显式标注豁免
    if (el.dataset.actOptional !== undefined) return;
    missing.add(act);
  });
  if (missing.size) {
    console.warn('[dom] 这些 data-act 没有任何处理器，点了不会有反应：', [...missing]);
  }
}
