/*
 * 读 Laplace（Chaldea 的战斗模拟）战斗记录截图里的伤害（「从 Laplace 截图导入」用）。不依赖页面：网页、Node 测试都能用。
 * 截图要求：战斗记录「完整截图」、单栏、打开显示详情。每张卡是一个带边框的格子：左边三栏是三个敌人位置
 * （名字、HP 打完后的血量、DMG 伤害、RNG 随机数（不是 0.9 时才有）、NP、Star、Overkill），右边一栏是出卡的从者。
 *
 * 步骤：找格子的边框竖线（左框、分隔线、右框）→ 沿分隔线找出每个格子的上下边 → 每个敌人栏只留白字和红字，
 *     交给文字识别（OCR，由调用方提供）→ 读出 HP、DMG、RNG → 相邻的格子是同一回合 → 每回合拼成一个伤害组。
 * 敌人的血量：这回合第一次挨打前的 HP = 打完后的 HP + DMG；同一敌人后面每张卡的 HP 必须正好减去 DMG（核对识别结果）。
 * 均伤 = DMG ÷ 随机数（默认 0.9），向上保留两位小数，保证 ⌊随机数 × 均伤⌋ = DMG。
 */
(function (root) {
  'use strict';

  var SLOTS = 3;                                         // 敌人最多 3 个位置
  var DEFAULT_RANDOM = 0.9;                              // Laplace 默认随机数

  function lum(d, i) { return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; }
  function neutral(d, i) { return Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 16; }

  /**
   * 边框线：灰色（不带颜色），比左右两边（各隔 7 像素）都亮或都暗。深色、浅色主题都适用。
   * 返回每个像素是不是边框线的表（Uint8Array）
   */
  function lineMask(img) {
    var w = img.width, h = img.height, d = img.data, out = new Uint8Array(w * h), off = Math.max(4, Math.round(w / 170));
    for (var y = 0; y < h; y++) {
      for (var x = off; x < w - off; x++) {
        var i = (y * w + x) * 4;
        if (!neutral(d, i)) continue;
        var l = lum(d, i), a = lum(d, i - off * 4), b = lum(d, i + off * 4);
        if ((l - a >= 8 && l - b >= 8) || (a - l >= 8 && b - l >= 8)) out[y * w + x] = 1;
      }
    }
    return out;
  }

  /**
   * 几条竖线（xs，各允许左右差 1 像素）上的边框线连续段 [上, 下)：任意一条有线就算（文字贴着某条线时它会断开）；
   * 中间断开不超过 3 像素的算同一段
   */
  function columnRuns(mask, w, h, xs, minLen) {
    var out = [], start = -1, gap = 0;
    var at = function (y) {
      for (var k = 0; k < xs.length; k++) {
        var i = y * w + xs[k];
        if (mask[i] || mask[i - 1] || mask[i + 1]) return true;
      }
      return false;
    };
    for (var y = 0; y <= h; y++) {
      var on = y < h && at(y);
      if (on) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0) {
        gap++;
        if (gap > 3 || y === h) {
          var end = y - gap + 1;
          if (end - start >= minLen) out.push([start, end]);
          start = -1; gap = 0;
        }
      }
    }
    return out;
  }

  /**
   * 找卡的格子：返回 { left, divider, right, boxes: [[上, 下), ...] }；找不到时抛出带说明的错误。
   * 三条竖线里，左框到分隔线是三个敌人位置，分隔线到右框是出卡的从者（宽度约为一个敌人位置）。
   */
  function findBoxes(img) {
    var w = img.width, h = img.height, mask = lineMask(img);
    var minRun = Math.round(w * 0.15);
    var best = new Int32Array(w);
    for (var x = 1; x < w - 1; x++) {
      var run = 0, max = 0;
      for (var y = 0; y < h; y++) {
        if (mask[y * w + x]) { run++; if (run > max) max = run; } else run = 0;
      }
      best[x] = max;
    }
    var lines = [];                                      // 相邻几列合成一条线，取最长的那列
    for (x = 1; x < w - 1; x++) {
      if (best[x] < minRun) continue;
      var last = lines[lines.length - 1];
      if (last && x - last.end <= 8) { last.end = x; if (best[x] > last.len) { last.len = best[x]; last.x = x; } }
      else lines.push({ x: x, len: best[x], end: x });
    }
    var pick = null, score = 0;
    for (var a = 0; a < lines.length; a++) {
      for (var b = a + 1; b < lines.length; b++) {
        for (var c = b + 1; c < lines.length; c++) {
          var L = lines[a].x, D = lines[b].x, R = lines[c].x, ratio = (D - L) / (R - D);
          if (R - L < w * 0.6 || ratio < 2 || ratio > 3.6) continue;
          var s = Math.min(lines[a].len, lines[b].len, lines[c].len);
          if (s > score) { score = s; pick = [L, D, R]; }
        }
      }
    }
    if (!pick) throw new Error('没有找到伤害记录的格子：请用 Laplace 战斗记录的「完整截图」，单栏、打开显示详情');
    var boxes = columnRuns(mask, w, h, pick, Math.round(w * 0.06));
    return { left: pick[0], divider: pick[1], right: pick[2], boxes: boxes };
  }

  /** 第 slot 个敌人位置（0 ~ 2）在格子 box 里的范围 { x, y, width, height } */
  function cellRect(frame, box, slot) {
    var cw = (frame.divider - frame.left) / SLOTS, pad = 4;
    var x0 = Math.round(frame.left + slot * cw + pad), x1 = Math.round(frame.left + (slot + 1) * cw - pad);
    return { x: x0, y: box[0] + pad, width: x1 - x0, height: box[1] - box[0] - pad * 2 };
  }

  /** 白字（深色主题）/ 黑字（浅色主题）：灰色且和底色差很多 */
  function isRed(d, i) { return d[i] > 150 && d[i + 1] < 120 && d[i + 2] < 120; }

  /**
   * 把一个敌人栏变成白底黑字（只留和底色反差大的灰色字、红字；蓝色 NP、绿色 Star、橙色 Overkill、头像都去掉）。
   * 返回 { width, height, data: RGBA, red: 红色像素数 }；red 很少 = 这一栏没有挨打（没有 DMG），不用识别
   */
  function cellImage(img, rect) {
    var w = img.width, d = img.data, out = new Uint8ClampedArray(rect.width * rect.height * 4), red = 0;
    var bg = lum(d, ((rect.y + 2) * w + rect.x + 2) * 4);       // 左上角是底色
    for (var y = 0; y < rect.height; y++) {
      for (var x = 0; x < rect.width; x++) {
        var i = ((rect.y + y) * w + rect.x + x) * 4, o = (y * rect.width + x) * 4, ink = false;
        if (isRed(d, i)) { ink = true; red++; }
        else if (neutral(d, i) && Math.abs(lum(d, i) - bg) > 70) ink = true;
        var v = ink ? 0 : 255;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return { width: rect.width, height: rect.height, data: out, red: red };
  }

  /** 识别出的数字：去掉千分位（逗号、被认成句点的逗号、空格），负号可能被认成各种横线 */
  function toInt(s) {
    var neg = /^[-—–~_]/.test(s.trim());
    var v = Number(s.replace(/[^\d]/g, ''));
    return neg ? -v : v;
  }

  /** 一个敌人栏的识别文字 → { hp, dmg, random }；没认出 HP 或 DMG 时对应的值是 null */
  function parseCell(text) {
    var t = String(text).replace(/[，]/g, ',');
    var hp = t.match(/HP\s*([-—–~_]?\s*[\d][\d,.\s]*)/), dmg = t.match(/[DO0]?MG\s*([\d][\d,.]*)/), rng = t.match(/RNG\s*(\d+(?:\.\d+)?)/);
    return {
      hp: hp ? toInt(hp[1].split('\n')[0]) : null,
      dmg: dmg ? toInt(dmg[1]) : null,
      random: rng ? Number(rng[1]) : null,
    };
  }

  /** 均伤：⌈DMG ÷ 随机数⌉（保留两位小数），这样 ⌊随机数 × 均伤⌋ = DMG */
  function averageOf(dmg, random) {
    var v = Math.ceil(Number((dmg / random * 100).toPrecision(15))) / 100;
    if (Math.floor(Number((v * random).toPrecision(15))) < dmg) v = (Math.round(v * 100) + 1) / 100;
    return v;
  }

  /**
   * 读一张截图。ocr(cellImage) → Promise<文字>；progress(done, total) 可省略。
   * 返回 Promise<{ frame, records: [{ top, bottom, cells: [{ slot: 1 ~ 3, hp, dmg, random, text }] }] }>
   */
  function readShot(img, ocr, progress) {
    var frame = findBoxes(img), jobs = [], records = [];
    frame.boxes.forEach(function (box) {
      var rec = { top: box[0], bottom: box[1], cells: [] };
      records.push(rec);
      for (var s = 0; s < SLOTS; s++) {
        var cell = cellImage(img, cellRect(frame, box, s));
        if (cell.red >= 30) jobs.push({ rec: rec, slot: s + 1, cell: cell });
      }
    });
    var done = 0;
    if (progress) progress(0, jobs.length);
    return jobs.reduce(function (p, job) {
      return p.then(function () { return ocr(job.cell); }).then(function (text) {
        var c = parseCell(text);
        job.rec.cells.push({ slot: job.slot, hp: c.hp, dmg: c.dmg, random: c.random, text: String(text) });
        done++;
        if (progress) progress(done, jobs.length);
      });
    }, Promise.resolve()).then(function () {
      return { frame: frame, records: records.filter(function (r) { return r.cells.length; }) };
    });
  }

  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };

  /**
   * 识别结果 → 每回合一个伤害组。width = 截图宽度（判断两个格子之间的空隙算不算换了回合）。
   * 返回 [{ turn, problems: [文字], targets: [{ slot, hp, end, dims: [{ dmg, random, avg }] }], data: 伤害组数据 }]；
   * targets[0] 是主目标（挨的卡最多；一样多时取血量多的），其余是 AOE 其他目标
   */
  function buildTurns(records, width) {
    var turns = [], gap = width * 0.05;
    records.forEach(function (r) {
      var last = turns[turns.length - 1];
      if (last && r.top - last[last.length - 1].bottom < gap) last.push(r);
      else turns.push([r]);
    });
    return turns.map(function (recs, t) {
      var enemies = {}, problems = [];
      recs.forEach(function (r, card) {
        r.cells.forEach(function (c) {
          var where = '第 ' + (card + 1) + ' 张卡、位置 ' + c.slot;
          if (c.hp === null || c.dmg === null) { problems.push(where + '：没认出' + (c.hp === null ? ' HP' : '') + (c.dmg === null ? ' DMG' : '')); return; }
          var e = enemies[c.slot];
          if (!e) e = enemies[c.slot] = { slot: c.slot, hp: c.hp + c.dmg, end: c.hp + c.dmg, dims: [] };
          else if (e.end - c.dmg !== c.hp) problems.push(where + '：' + fmt(e.end) + ' − ' + fmt(c.dmg) + ' ≠ ' + fmt(c.hp) + '，有数字认错了');
          e.end = c.hp;
          var random = c.random || DEFAULT_RANDOM;
          if (random < 0.9 || random > 1.1) { problems.push(where + '：随机数 ' + random + ' 不在 0.9 ~ 1.1 之间'); random = DEFAULT_RANDOM; }
          e.dims.push({ dmg: c.dmg, random: random, avg: averageOf(c.dmg, random) });
        });
      });
      var targets = Object.keys(enemies).map(function (k) { return enemies[k]; })
        .sort(function (a, b) { return b.dims.length - a.dims.length || b.hp - a.hp || a.slot - b.slot; });
      targets.forEach(function (e) { if (e.hp <= 0) problems.push('位置 ' + e.slot + '：挨打前的血量 ' + fmt(e.hp) + ' 不是正数，有数字认错了'); });
      if (!targets.length) problems.push('这一回合没有认出任何伤害');
      var dims = function (e) { return e.dims.map(function (d) { return String(d.avg); }); };
      var data = targets.length ? {
        cards: dims(targets[0]), hp: String(targets[0].hp), sl: '',
        aoe: targets.slice(1).map(function (e) { return { cards: dims(e), hp: String(e.hp) }; }),
      } : null;
      return { turn: t + 1, problems: problems, targets: targets, data: data };
    });
  }

  var api = { findBoxes: findBoxes, cellRect: cellRect, cellImage: cellImage, parseCell: parseCell, averageOf: averageOf, readShot: readShot, buildTurns: buildTurns };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LaplaceShot = api;
})(typeof self !== 'undefined' ? self : this);
