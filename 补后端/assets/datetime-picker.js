/* ==========================================================
 * 日期／时间选择面板（PC 记录页共用）
 * ----------------------------------------------------------
 * 原生 input[type=date|datetime-local] 的弹出层没有确认按钮：
 * 用户滚动或点选的同时输入框就被改写，并立刻触发 input 事件，
 * 结果“还没确认就被本机草稿保存”。本组件把选择过程收进面板
 * 内部的草稿态，只有点“确定”才写回输入框并派发 input/change；
 * 取消、点遮罩、按 Esc 一律丢弃，不产生任何保存动作。
 *
 * 用法：
 *   FdDateTimePicker.enhance(container)
 *   <input data-picker="date" | "hour" | "minute">
 *     date   仅日期，写回 YYYY-MM-DD
 *     hour   日期 + 整点，写回 YYYY-MM-DD HH:00
 *     minute 日期 + 整点 + 分钟（5 分钟步长），写回 YYYY-MM-DD HH:mm:00
 * 可选属性：
 *   data-picker-after="fwF-startTime"  + data-picker-after-msg="…"
 *   data-picker-before="fwF-endTime"   + data-picker-before-msg="…"
 *   （用于校验开始／结束时间的先后关系，不通过时面板内提示且不关闭）
 * ========================================================== */
(function () {
  'use strict';
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  // 旁站等场景仍需分钟精度，按 5 分钟一档降低误选与操作成本
  const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
  const pad = n => String(n).padStart(2, '0');
  let mask = null, panel = null, target = null, mode = 'date', draft = null, view = null;
  let placeHandler = null, keyHandler = null;

  /* 兼容 "2026-10-30 14:00"、"2026-10-30T14:00:00"、"2026-10-30" 三类写法 */
  function parse(value) {
    const m = String(value == null ? '' : value).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    const out = { y: +m[1], m: +m[2], d: +m[3], h: m[4] == null ? null : +m[4], mi: m[5] == null ? null : +m[5], s: m[6] == null ? null : +m[6] };
    const probe = new Date(Date.UTC(out.y, out.m - 1, out.d));
    if (probe.getUTCFullYear() !== out.y || probe.getUTCMonth() !== out.m - 1 || probe.getUTCDate() !== out.d) return null;
    if (out.h != null && (out.h > 23 || (out.mi != null && out.mi > 59) || (out.s != null && out.s > 59))) return null;
    return out;
  }
  const ymd = d => d.y + '-' + pad(d.m) + '-' + pad(d.d);
  const hm = d => pad(d.h == null ? 0 : d.h) + ':' + pad(d.mi == null ? 0 : d.mi);
  /* 先后关系比较用纯数字序号，避免带秒和不带秒的字符串直接比大小作弊 */
  const ordinal = d => Number(String(d.y) + pad(d.m) + pad(d.d) + pad(d.h == null ? 0 : d.h) + pad(d.mi == null ? 0 : d.mi));

  function build() {
    mask = document.createElement('div');
    mask.className = 'fd-dtp-mask';
    mask.hidden = true;
    panel = document.createElement('div');
    panel.className = 'fd-dtp';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '选择日期时间');
    panel.innerHTML = '<div class="fd-dtp-head">'
      + '<button type="button" class="fd-dtp-nav" data-nav="-1" aria-label="上个月">‹</button>'
      + '<strong data-title></strong>'
      + '<button type="button" class="fd-dtp-nav" data-nav="1" aria-label="下个月">›</button>'
      + '</div>'
      + '<div class="fd-dtp-week" aria-hidden="true">' + WEEK.map(w => '<span>' + w + '</span>').join('') + '</div>'
      + '<div class="fd-dtp-days" data-days></div>'
      + '<div class="fd-dtp-hours" data-hours hidden><span class="fd-dtp-hours-label">整点</span><div class="fd-dtp-hour-list"></div></div>'
      + '<div class="fd-dtp-hours" data-minutes hidden><span class="fd-dtp-hours-label">分钟（5 分钟一档）</span><div class="fd-dtp-hour-list fd-dtp-minute-list"></div></div>'
      + '<p class="fd-dtp-error" data-error role="alert"></p>'
      + '<div class="fd-dtp-foot">'
      + '<span class="fd-dtp-preview" data-preview></span>'
      + '<button type="button" class="fd-dtp-btn" data-clear>清除</button>'
      + '<button type="button" class="fd-dtp-btn" data-cancel>取消</button>'
      + '<button type="button" class="fd-dtp-btn fd-dtp-ok" data-ok>确定</button>'
      + '</div>';
    document.body.appendChild(mask);
    document.body.appendChild(panel);
    mask.addEventListener('click', () => close());
    panel.addEventListener('click', onClick);
    placeHandler = () => { if (target && !panel.hidden) place(); };
    keyHandler = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
  }

  function onClick(event) {
    const nav = event.target.closest('[data-nav]');
    if (nav) { moveMonth(Number(nav.dataset.nav)); return; }
    const day = event.target.closest('[data-day]');
    if (day) { draft.y = view.y; draft.m = view.m; draft.d = Number(day.dataset.day); draft.touched = true; error(''); render(); return; }
    const hour = event.target.closest('[data-hour]');
    if (hour) { draft.h = Number(hour.dataset.hour); draft.touched = true; error(''); render(); return; }
    const minute = event.target.closest('[data-minute]');
    if (minute) { draft.mi = Number(minute.dataset.minute); draft.touched = true; error(''); render(); return; }
    if (event.target.closest('[data-cancel]')) { close(); return; }
    if (event.target.closest('[data-ok]')) { apply(); return; }
    if (event.target.closest('[data-clear]')) { apply(true); return; }
  }

  function moveMonth(delta) {
    let y = view.y, m = view.m + delta;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    view = { y, m };
    render();
  }

  function error(message) { panel.querySelector('[data-error]').textContent = message || ''; }

  function render() {
    panel.querySelector('[data-title]').textContent = view.y + '年' + view.m + '月';
    const showHours = mode === 'hour' || mode === 'minute';
    panel.querySelector('[data-hours]').hidden = !showHours;
    panel.querySelector('[data-minutes]').hidden = mode !== 'minute';
    const lead = new Date(view.y, view.m - 1, 1).getDay();
    const total = new Date(view.y, view.m, 0).getDate();
    const now = new Date();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="fd-dtp-day is-blank"></span>');
    for (let d = 1; d <= total; d++) {
      const on = draft.y === view.y && draft.m === view.m && draft.d === d;
      const isToday = now.getFullYear() === view.y && now.getMonth() === view.m - 1 && now.getDate() === d;
      cells.push('<button type="button" class="fd-dtp-day' + (on ? ' is-on' : '') + (isToday ? ' is-today' : '')
        + '" data-day="' + d + '" aria-pressed="' + on + '">' + d + '</button>');
    }
    for (let i = lead + total; i % 7 !== 0; i++) cells.push('<span class="fd-dtp-day is-blank"></span>');
    panel.querySelector('[data-days]').innerHTML = cells.join('');
    panel.querySelector('[data-hours] .fd-dtp-hour-list').innerHTML = showHours ? Array.from({ length: 24 }, (_, h) =>
      '<button type="button" class="fd-dtp-hour' + (draft.h === h ? ' is-on' : '') + '" data-hour="' + h
      + '" aria-pressed="' + (draft.h === h) + '">' + pad(h) + '</button>').join('') : '';
    panel.querySelector('[data-minutes] .fd-dtp-minute-list').innerHTML = mode === 'minute' ? MINUTES.map(mi =>
      '<button type="button" class="fd-dtp-hour' + (draft.mi === mi ? ' is-on' : '') + '" data-minute="' + mi
      + '" aria-pressed="' + (draft.mi === mi) + '">' + pad(mi) + '</button>').join('') : '';
    panel.querySelector('[data-preview]').textContent = currentValue();
  }

  function currentValue() {
    if (mode === 'date') return ymd(draft);
    // 分钟模式仍补齐秒，保持与后端 YYYY-MM-DDTHH:mm:ss 一致
    return ymd(draft) + ' ' + hm(draft) + (mode === 'minute' ? ':00' : '');
  }

  /* 空值时的默认值：结束时间优先取开始时间 +1 小时，其余取当天/当前整点 */
  function seed(input, now) {
    const afterId = input.dataset.pickerAfter;
    const base = afterId ? document.getElementById(afterId) : null;
    const start = base && parse(base.value);
    if (start && start.h != null) {
      const clock = new Date(start.y, start.m - 1, start.d, start.h + 1, start.mi == null ? 0 : start.mi);
      return { y: clock.getFullYear(), m: clock.getMonth() + 1, d: clock.getDate(), h: clock.getHours(), mi: clock.getMinutes(), touched: false };
    }
    // 无参考值时默认到整点，分钟由用户按 5 分钟一档选择，避免出现 26 分这类非档位默认值
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: 0, touched: false };
  }

  function relationMessage(value) {
    const current = parse(value);
    if (!current) return '';
    const afterId = target.dataset.pickerAfter, beforeId = target.dataset.pickerBefore;
    const after = afterId ? document.getElementById(afterId) : null;
    const before = beforeId ? document.getElementById(beforeId) : null;
    if (after && after.value) {
      const start = parse(after.value);
      if (start && start.h != null && ordinal(current) <= ordinal(start)) {
        return target.dataset.pickerAfterMsg || '结束时间须晚于开始时间';
      }
    }
    if (before && before.value) {
      const end = parse(before.value);
      if (end && end.h != null && ordinal(current) >= ordinal(end)) {
        return target.dataset.pickerBeforeMsg || '开始时间须早于结束时间';
      }
    }
    return '';
  }

  function apply(clear) {
    if (clear) { commit(''); return; }
    if (!draft.touched && target.value) { close(); return; }
    const value = currentValue();
    const message = mode === 'date' ? '' : relationMessage(value);
    if (message) { error(message); return; }
    commit(value);
  }

  function commit(value) {
    const input = target;
    close();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function place() {
    if (window.innerWidth <= 480) { panel.style.left = panel.style.top = ''; return; }
    const rect = target.getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function open(input) {
    if (!panel) build();
    if (target) close();
    target = input;
    const kind = input.dataset.picker;
    mode = kind === 'minute' ? 'minute' : kind === 'hour' ? 'hour' : 'date';
    const now = new Date();
    const parsed = parse(input.value);
    draft = parsed
      ? { y: parsed.y, m: parsed.m, d: parsed.d, h: parsed.h == null ? now.getHours() : parsed.h,
        mi: parsed.mi == null ? 0 : parsed.mi, touched: false }
      : seed(input, now);
    view = { y: draft.y, m: draft.m };
    error('');
    render();
    mask.hidden = false;
    panel.hidden = false;
    place();
    window.addEventListener('resize', placeHandler);
    window.addEventListener('scroll', placeHandler, true);
    document.addEventListener('keydown', keyHandler);
    const ok = panel.querySelector('[data-ok]');
    if (ok) ok.focus({ preventScroll: true });
  }

  function close() {
    if (panel) { panel.hidden = true; error(''); }
    if (mask) mask.hidden = true;
    if (placeHandler) { window.removeEventListener('resize', placeHandler); window.removeEventListener('scroll', placeHandler, true); }
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    const opener = target;
    target = null;
    if (opener && document.body.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  }

  function enhance(container) {
    if (!container) return;
    container.querySelectorAll('input[data-picker]').forEach(input => {
      if (input.dataset.pickerBound === '1') return;
      input.dataset.pickerBound = '1';
      input.addEventListener('click', () => { if (!input.disabled) open(input); });
      input.addEventListener('keydown', event => {
        if (input.disabled) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') { event.preventDefault(); open(input); }
      });
    });
  }

  window.FdDateTimePicker = { enhance, close: () => { if (panel && !panel.hidden) close(); } };
})();
