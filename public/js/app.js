/* 命运麦当劳 Web 前端 —— 原生 JS，无框架 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let currentTab = 'destiny';
  let lastDestiny = null; // 存最近一次天选结果，供分享卡片用

  /* ---------- tab 切换 ---------- */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      $('#btnText').textContent = currentTab === 'destiny' ? '🎲 抽我的今日天选' : '🗓 看未来七天的运势';
      $('#result').hidden = true;
      $('#status').hidden = true;
    });
  });

  /* ---------- 健康检查，显示数据模式 ---------- */
  fetch('./api/health')
    .then((r) => r.json())
    .then((d) => {
      const badge = $('#modeBadge');
      badge.hidden = false;
      if (d.mode === 'live') {
        badge.textContent = '● 实时数据';
        badge.className = 'badge live';
      } else {
        badge.textContent = '● 演示数据（未配置 Token）';
        badge.className = 'badge snapshot';
      }
    })
    .catch(() => {});

  /* ---------- 提交 ---------- */
  $('#form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    runDraw();
  });

  /**
   * 执行一次抽签（submit 与"再抽一次"共用）。
   * @param {object} extra 额外请求参数，如 { reroll: true }
   */
  async function runDraw(extra = {}) {
    const body = {
      city: $('#city').value.trim(),
      keyword: $('#keyword').value.trim(),
      taste: $('#taste').value,
      budget: $('#budget').value.trim() || undefined,
      ...extra,
    };

    const btn = $('#submitBtn');
    btn.disabled = true;
    const status = $('#status');
    status.hidden = true;
    $('#result').hidden = true;

    // 抽签动画：轮播玄学文案
    const rolling = $('#rolling');
    rolling.hidden = false;
    const rollLines =
      currentTab === 'destiny'
        ? ['正在叩问今日命运…', '骰子还在翻滚…', '命运正在抉择…', '就快揭晓了…']
        : ['正在推演未来七天…', '翻动命运的日历…', '一周的签正在落定…'];
    let ri = 0;
    $('#rollingText').textContent = rollLines[0];
    const rollTimer = setInterval(() => {
      ri = (ri + 1) % rollLines.length;
      $('#rollingText').textContent = rollLines[ri];
    }, 700);

    const started = Date.now();
    const endpoint = currentTab === 'destiny' ? './api/plans' : './api/fortune';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      // 让抽签动画至少跑满 900ms，太快会没有仪式感
      const elapsed = Date.now() - started;
      if (elapsed < 900 && !prefersReducedMotion()) {
        await sleep(900 - elapsed);
      }
      clearInterval(rollTimer);
      rolling.hidden = true;

      if (!data.ok || data.error) {
        status.hidden = false;
        status.className = 'status err';
        status.textContent = data.error || '出了点问题，稍后再试。';
        return;
      }
      if (currentTab === 'destiny') renderDestiny(data);
      else renderFortune(data);
    } catch (e) {
      clearInterval(rollTimer);
      rolling.hidden = true;
      status.hidden = false;
      status.className = 'status err';
      status.textContent = '请求失败：' + (e.message || e);
    } finally {
      btn.disabled = false;
    }
  }

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 渲染：今日天选三方案 ---------- */
  function renderDestiny(data) {
    lastDestiny = data;
    const root = $('#result');
    root.hidden = false;
    root.innerHTML = '';

    const reduced = prefersReducedMotion();
    let step = 0; // 登场序号，用于错开延迟
    const stagger = (node, cls) => {
      if (!reduced) {
        node.classList.add(cls);
        node.style.animationDelay = step * 0.18 + 's';
        step++;
      }
      return node;
    };

    const head = el('div', 'card');
    const row = el('div', 'result-head');
    row.appendChild(el('span', 'store-name', '📍 ' + data.store.storeName));
    const chip = el('span', 'luck-chip', data.luck.emoji + ' ' + data.luck.name + ' ' + data.luck.starbar);
    chip.style.background = data.luck.hex;
    if (!reduced) chip.classList.add('luck-pop');
    row.appendChild(chip);
    head.appendChild(row);
    if (data.fallback) {
      head.appendChild(el('div', 'today-hint', '（实时数据暂不可用，当前为演示数据）'));
    }
    stagger(head, 'reveal');
    root.appendChild(head);

    data.plans.forEach((plan) => {
      const cardNode = renderPlanCard(plan);
      // 推荐卡用金色高光脉冲，其余用普通登场
      stagger(cardNode, plan.recommended ? 'glow' : 'reveal');
      root.appendChild(cardNode);
    });

    root.appendChild(stagger(el('div', 'destiny-line', data.line || ''), 'line-in'));
    if (data.todayHint) {
      root.appendChild(el('div', 'today-hint', '顺带一提，今天还有：' + data.todayHint));
    }

    const rerollBtn = el('button', 'btn-reroll', '🎲 不满意？再抽一次');
    rerollBtn.addEventListener('click', () => runDraw({ reroll: true }));
    root.appendChild(rerollBtn);

    const shareBtn = el('button', 'btn-share', '📸 生成分享卡片');
    shareBtn.addEventListener('click', () => generateShareCard(data));
    root.appendChild(shareBtn);

    // 大吉彩蛋：撒花
    if (data.luck.key === 'great' && !reduced) {
      launchConfetti();
    }
  }

  function renderPlanCard(plan) {
    const card = el('div', 'plan' + (plan.recommended ? ' rec' : ''));
    const title = el('div', 'plan-title');
    title.appendChild(el('span', null, plan.label));
    if (plan.recommended) title.appendChild(el('span', 'rec-tag', '⭐ 推荐'));
    card.appendChild(title);

    plan.items.forEach((it) => {
      const line = el('div', 'item');
      line.appendChild(el('span', 'name', '🍔 ' + it.name));
      if (it.priceText) line.appendChild(el('span', 'price', '¥' + it.priceText));
      if (it.onSale) {
        if (it.discountInfo) line.appendChild(el('span', 'sale', '⚡' + it.discountInfo));
        else if (it.originalText) line.appendChild(el('span', 'strike', '¥' + it.originalText));
      }
      card.appendChild(line);
    });

    const price = el('div', 'plan-price');
    if (plan.payYuan != null) {
      const pay = el('span', 'pay', '¥' + plan.payYuan.toFixed(2));
      price.appendChild(pay);
      if (plan.savedYuan != null && plan.savedYuan > 0) {
        price.appendChild(el('span', 'base-strike', '¥' + plan.baseYuan.toFixed(2)));
        price.appendChild(el('span', 'saved', '省¥' + plan.savedYuan.toFixed(2)));
      }
      if (plan.couponName && plan.savedYuan > 0) {
        price.appendChild(el('div', 'today-hint', '用券：' + plan.couponName));
      }
    } else if (plan.baseYuan != null) {
      price.appendChild(el('span', 'pay', '¥' + plan.baseYuan.toFixed(2)));
    } else {
      price.appendChild(el('span', 'today-hint', '价格以官方实时结果为准'));
    }
    card.appendChild(price);
    return card;
  }

  /* ---------- 渲染：运势周历 ---------- */
  function renderFortune(data) {
    const root = $('#result');
    root.hidden = false;
    root.innerHTML = '';
    root.appendChild(el('div', 'today-hint', '📍 ' + (data.store?.storeName || '')));

    const reduced = prefersReducedMotion();
    const grid = el('div', 'week-grid');
    (data.days || []).forEach((day, idx) => {
      const cell = el('div', 'day-cell');
      if (!reduced) {
        cell.classList.add('reveal');
        cell.style.animationDelay = idx * 0.1 + 's';
      }
      // 顶部日期条，用运势色
      const top = el('div', 'day-top');
      top.style.background = day.luck.hex;
      top.appendChild(el('span', 'day-top-label', day.label));
      top.appendChild(el('span', 'day-top-date', day.date + ' ' + day.weekday));
      cell.appendChild(top);

      cell.appendChild(el('div', 'day-luck', day.luck.emoji + ' ' + day.luck.name));

      if (day.plan) {
        const names = day.plan.items.map((it) => it.name).join(' + ');
        cell.appendChild(el('div', 'day-combo', names));
      }
      if (day.priceYuan != null) {
        cell.appendChild(
          el('div', 'day-price' + (day.realtime ? ' rt' : ''),
            (day.realtime ? '¥' : '约¥') + day.priceYuan.toFixed(1))
        );
      }
      grid.appendChild(cell);
    });
    root.appendChild(grid);
    root.appendChild(
      el('div', 'week-note',
        '七天结果按当天日期固定，像运势一样。今天为实时价（¥），其余为菜单参考价（约¥），当天以官方实时为准。')
    );
  }

  /* ---------- 大吉撒花（纯 Canvas，无依赖） ---------- */
  function launchConfetti() {
    const canvas = $('#confetti');
    canvas.hidden = false;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    const colors = ['#DA291C', '#FFC72C', '#1f3a93', '#2E7D32', '#ffffff'];
    const N = 140;
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.4,
        w: 7 + Math.random() * 7,
        h: 10 + Math.random() * 8,
        vy: 2.5 + Math.random() * 3.5,
        vx: -1.5 + Math.random() * 3,
        rot: Math.random() * Math.PI,
        vr: -0.2 + Math.random() * 0.4,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
    const start = Date.now();
    const DURATION = 2600;
    function frame() {
      const t = Date.now() - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = t > DURATION - 600 ? Math.max(0, (DURATION - t) / 600) : 1;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < DURATION) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 分享卡片（Canvas 竖版） ---------- */
  function generateShareCard(data) {
    const canvas = $('#shareCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const luckHex = data.luck.hex || '#DA291C';

    // 背景
    ctx.fillStyle = '#FFF8EC';
    ctx.fillRect(0, 0, W, H);
    // 顶部色带
    ctx.fillStyle = '#FFC72C';
    ctx.fillRect(0, 0, W, 190);

    // MCD 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#DA291C';
    ctx.font = '900 92px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('MCD', W / 2, 118);
    ctx.font = '800 30px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('DESTINY · 命运麦当劳', W / 2, 162);

    // 运势大字
    ctx.fillStyle = luckHex;
    ctx.font = '900 72px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(data.luck.emoji + ' ' + data.luck.name, W / 2, 300);
    ctx.font = '40px sans-serif';
    ctx.fillText(data.luck.starbar, W / 2, 356);

    // 门店
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '26px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('📍 ' + truncate(ctx, data.store.storeName, W - 100), W / 2, 410);

    // 推荐方案卡片
    const rec = (data.plans || []).find((p) => p.recommended) || data.plans[0];
    let y = 470;
    if (rec) {
      const cardX = 60, cardW = W - 120, cardH = 420;
      roundRect(ctx, cardX, y, cardW, cardH, 24);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = luckHex;
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = luckHex;
      ctx.font = '800 40px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText('⭐ ' + rec.label, cardX + 36, y + 70);

      ctx.fillStyle = '#1f1f1f';
      ctx.font = '34px -apple-system, "PingFang SC", sans-serif';
      let iy = y + 140;
      rec.items.forEach((it) => {
        const t = '🍔 ' + it.name + (it.priceText ? '  ¥' + it.priceText : '');
        ctx.fillText(truncate(ctx, t, cardW - 72), cardX + 36, iy);
        iy += 56;
      });

      // 价格
      ctx.font = '900 56px -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = '#DA291C';
      const payText = rec.payYuan != null ? '¥' + rec.payYuan.toFixed(2) : (rec.baseYuan != null ? '¥' + rec.baseYuan.toFixed(2) : '');
      ctx.fillText(payText, cardX + 36, y + cardH - 100);
      if (rec.savedYuan != null && rec.savedYuan > 0) {
        ctx.font = '30px -apple-system, "PingFang SC", sans-serif';
        ctx.fillStyle = '#1b7a33';
        ctx.fillText('省 ¥' + rec.savedYuan.toFixed(2), cardX + 36, y + cardH - 54);
      }
      y += cardH + 50;
    }

    // 签文
    ctx.textAlign = 'center';
    ctx.fillStyle = luckHex;
    ctx.font = '800 32px -apple-system, "PingFang SC", sans-serif';
    wrapText(ctx, data.line || '', W / 2, y, W - 120, 46);

    // 页脚
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '22px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('基于麦当劳 MCP · 价格以官方实时为准 · 非官方产品', W / 2, H - 50);

    // 下载
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mcd-destiny-' + (data.luck.name || 'card') + '.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  /* ---------- Canvas 辅助 ---------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function truncate(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function wrapText(ctx, text, cx, y, maxW, lh) {
    const chars = [...text];
    let line = '';
    let yy = y;
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > maxW) {
        ctx.fillText(line, cx, yy);
        line = ch;
        yy += lh;
      } else {
        line += ch;
      }
    }
    if (line) ctx.fillText(line, cx, yy);
  }
})();
