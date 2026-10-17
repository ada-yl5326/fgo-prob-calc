/*
 * 读 Laplace（Chaldea 的战斗模拟）战斗记录截图里的伤害（「从 Laplace 截图导入」用）。不依赖页面：网页、Node 测试都能用。
 * 截图要求：战斗记录打开显示详情；单栏、双栏（左边关卡和队伍、右边记录），深色、浅色外观都可以。每张卡是一个带边框的格子：左边三栏是三个敌人位置
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
   * 中间断开不超过 1 像素的算同一段（格子之间的空隙在浅色、压缩过的截图里可能只有 3 ~ 4 像素）
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
        if (gap > 1 || y === h) {
          var end = y - gap + 1;
          if (end - start >= minLen) out.push([start, end]);
          start = -1; gap = 0;
        }
      }
    }
    return out;
  }

  /**
   * 一段竖线里可能是几个上下相连的格子（压缩过的浅色截图，格子之间的空隙被糊掉了）：
   * 在横向的边框处切开。横向边框 = 这一行左框到右框之间大部分像素是灰色、比上下（各隔几像素）都亮或都暗。
   * 返回切开后的几段 [上, 下)（太矮的不要）
   */
  function splitAtBorders(img, xs, run, minLen) {
    var w = img.width, d = img.data, off = Math.max(4, Math.round(w / 170));
    var x0 = xs[0] + off * 2, x1 = xs[2] - off * 2, isBorder = [];
    for (var y = run[0]; y < run[1]; y++) {
      var hit = 0, n = 0;
      if (y - off >= 0 && y + off < img.height) {
        for (var x = x0; x < x1; x += 2) {
          var i = (y * w + x) * 4;
          n++;
          if (!neutral(d, i)) continue;
          var l = lum(d, i), a = lum(d, i - off * w * 4), b = lum(d, i + off * w * 4);
          if ((l - a >= 6 && l - b >= 6) || (a - l >= 6 && b - l >= 6)) hit++;
        }
      }
      isBorder.push(n > 0 && hit >= n * 0.6);
    }
    var out = [], start = run[0];
    for (y = run[0]; y <= run[1]; y++) {
      if (y === run[1] || isBorder[y - run[0]]) {
        if (y - start >= minLen) out.push([start, y]);
        start = y + 1;
      }
    }
    return out.length ? out : [run];
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
    // 三条线都够长的组合里，取最窄的那组（外面还有页面、面板的边线时，格子的边框在最里面）
    var triples = [], best = 0;
    for (var a = 0; a < lines.length; a++) {
      for (var b = a + 1; b < lines.length; b++) {
        for (var c = b + 1; c < lines.length; c++) {
          var L = lines[a].x, D = lines[b].x, R = lines[c].x, ratio = (D - L) / (R - D);
          if (R - L < w * 0.3 || ratio < 2 || ratio > 3.6) continue;     // 双栏截图：记录只占右边一半
          var s = Math.min(lines[a].len, lines[b].len, lines[c].len);
          triples.push({ xs: [L, D, R], len: s });
          if (s > best) best = s;
        }
      }
    }
    var pick = null;
    triples.forEach(function (t) {
      if (t.len >= best * 0.9 && (!pick || t.xs[2] - t.xs[0] < pick[2] - pick[0])) pick = t.xs;
    });
    if (!pick) throw new Error('没有找到伤害记录的格子：请用 Laplace 战斗记录的截图，并打开显示详情');
    var minBox = Math.round((pick[2] - pick[0]) * 0.07);
    var boxes = [];
    columnRuns(mask, w, h, pick, minBox).forEach(function (run) {
      splitAtBorders(img, pick, run, minBox).forEach(function (b) { boxes.push(b); });
    });
    // 只要分隔线在这个位置的格子（我方出卡）；敌方攻击的格子分隔线在左边（左边一栏是出手的敌人），不要
    boxes = boxes.filter(function (b) {
      var on = 0;
      for (var y = b[0]; y < b[1]; y++) {
        var i = y * w + pick[1];
        if (mask[i] || mask[i - 1] || mask[i + 1]) on++;
      }
      return on >= (b[1] - b[0]) * 0.6;
    });
    return { left: pick[0], divider: pick[1], right: pick[2], boxes: boxes };
  }

  /** 第 slot 个敌人位置（0 ~ 2）在格子 box 里的范围 { x, y, width, height } */
  function cellRect(frame, box, slot) {
    var cw = (frame.divider - frame.left) / SLOTS, pad = 4;
    var x0 = Math.round(frame.left + slot * cw + pad), x1 = Math.round(frame.left + (slot + 1) * cw - pad);
    return { x: x0, y: box[0] + pad, width: x1 - x0, height: box[1] - box[0] - pad * 2 };
  }

  /** 出卡从者一栏（分隔线到右框）在格子 box 里的范围 */
  function attackerRect(frame, box) {
    var pad = 4;
    return { x: frame.divider + pad, y: box[0] + pad, width: frame.right - frame.divider - pad * 2, height: box[1] - box[0] - pad * 2 };
  }

  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  /** 红字（DMG、RNG）的浓度 0 ~ 1：明显偏红、绿和蓝差不多（橙色的 Overkill 绿比蓝多很多，不算） */
  function redness(d, i) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    return Math.abs(g - b) < 50 ? clamp01((Math.min(r - g, r - b) - 20) / 60) : 0;
  }

  /**
   * 把一个敌人栏变成白底黑字的灰度图：只留灰色字（深色主题白字、浅色主题黑字，和底色反差大）、红字，
   * 蓝色 NP、绿色 Star、橙色 Overkill、彩色头像都去掉。保留抗锯齿的深浅（浅色主题的红字很细，硬切成黑白会断），
   * 黑白交给文字识别自己判断。返回 { width, height, data: RGBA, red: 红字像素数, redMask: 每个像素是不是红色, plain: 原图灰度（白底黑字） }；red 很少 = 这一栏没有挨打，不用识别
   */
  function cellImage(img, rect) {
    var w = img.width, d = img.data, out = new Uint8ClampedArray(rect.width * rect.height * 4), red = 0;
    var redMask = new Uint8Array(rect.width * rect.height), plain = new Uint8Array(rect.width * rect.height);
    var bg = lum(d, ((rect.y + 2) * w + rect.x + 2) * 4);       // 左上角是底色
    for (var y = 0; y < rect.height; y++) {
      for (var x = 0; x < rect.width; x++) {
        var i = ((rect.y + y) * w + rect.x + x) * 4, o = (y * rect.width + x) * 4;
        var chroma = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        var gray = clamp01((Math.abs(lum(d, i) - bg) - 30) / 90) * clamp01(1 - (chroma - 15) / 40);
        var rd = redness(d, i);
        if (rd > 0.5) red++;
        if (rd > 0) redMask[y * rect.width + x] = 1;
        var l = lum(d, i);
        plain[y * rect.width + x] = bg < 128 ? 255 - l : l;      // 原图的灰度（深色主题反过来），切出单行后用
        var v = 255 - Math.round(255 * Math.max(gray, rd));
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return { width: rect.width, height: rect.height, data: out, red: red, redMask: redMask, plain: plain };
  }

  /** 一栏里的一行一行字：[{ start, end, isRed }]（上下相隔不超过 2 像素的算同一行，太矮的不要） */
  function bandsOf(cell) {
    var w = cell.width, h = cell.height, d = cell.data, bands = [], cur = null;
    for (var y = 0; y < h; y++) {
      var ink = 0;
      for (var x = 0; x < w; x++) if (d[(y * w + x) * 4] < 128) ink++;
      if (ink >= 2) { if (cur && y - cur.end <= 2) cur.end = y + 1; else bands.push(cur = { start: y, end: y + 1 }); }
    }
    bands = bands.filter(function (b) { return b.end - b.start >= 4; });
    bands.forEach(function (b) {
      b.red = 0; b.ink = 0;
      for (var y = b.start; y < b.end; y++) {
        for (var x = 0; x < w; x++) {
          if (d[(y * w + x) * 4] < 128) { b.ink++; if (cell.redMask[y * w + x]) b.red++; }
        }
      }
      b.isRed = b.red >= b.ink * 0.5;
    });
    return bands;
  }

  /**
   * 切出一行字，两种图（白底黑字，上下左右留白），识别结果互相补充：
   *   plain = 原图的灰度（一行里只有这一行字；保留抗锯齿，浅色主题的细字更好认），把最深到底色拉满 0 ~ 255；
   *   ink = 去掉其他颜色后的墨色图（深色主题、字旁边有别的东西时更稳）。
   */
  function cropBand(cell, b, kind) {
    var w = cell.width, h = cell.height, d = cell.data;
    var pad = 4, top = Math.max(0, b.start - pad), bottom = Math.min(h, b.end + pad), margin = 10;
    var ow = w + margin * 2, oh = bottom - top + margin * 2;
    var plain = new Uint8ClampedArray(ow * oh * 4).fill(255), inked = new Uint8ClampedArray(ow * oh * 4).fill(255);
    var lo = 255, hi = 0, p = cell.plain;
    for (var y = top; y < bottom; y++) for (var x = 0; x < w; x++) { var v = p[y * w + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
    var span = Math.max(1, hi - lo);
    for (y = top; y < bottom; y++) {
      for (x = 0; x < w; x++) {
        var t = ((y - top + margin) * ow + x + margin) * 4;
        plain[t] = plain[t + 1] = plain[t + 2] = Math.round((p[y * w + x] - lo) / span * 255);
        inked[t] = inked[t + 1] = inked[t + 2] = d[(y * w + x) * 4];
      }
    }
    return { kind: kind, plain: { width: ow, height: oh, data: plain }, ink: { width: ow, height: oh, data: inked } };
  }

  /**
   * 敌人栏里要识别的几行：HP（DMG 上面那行灰色字）和红字的几行（DMG，长数字会换到下一行；RNG）。
   * 返回 [{ kind: 'hp' | 'red', plain, ink }]（见 cropBand）；找不到 DMG 行时是空数组
   */
  function cellLines(cell) {
    var bands = bandsOf(cell), lines = [], first = -1;
    // DMG 行：第一个紧挨在一行灰色字（HP，行高差不多）下面的红色行（头像里也可能有红色，不能只看颜色）
    for (var k = 1; k < bands.length && first < 0; k++) {
      var a = bands[k - 1], b = bands[k], hb = b.end - b.start, ha = a.end - a.start;
      if (b.isRed && !a.isRed && ha >= hb * 0.6 && ha <= hb * 1.6 && b.start - a.end <= hb * 1.5) first = k;
    }
    if (first < 0) return lines;
    lines.push(cropBand(cell, bands[first - 1], 'hp'));
    // 后面紧挨着的红色行：DMG 换行后的数字、RNG（中间隔了 NP、Star 几行的橙色 Overkill 不要）
    var lineH = bands[first].end - bands[first].start;
    for (k = first; k < bands.length && bands[k].isRed && (k === first || bands[k].start - bands[k - 1].end <= lineH * 1.5); k++) {
      lines.push(cropBand(cell, bands[k], 'red'));
    }
    return lines;
  }

  /** 出卡从者一栏（右边）里的红字行：卡的颜色（Buster 是红字）、这张卡的总伤害 DMG。返回 [{ kind: 'red', plain, ink }] */
  function attackerLines(cell) {
    return bandsOf(cell).filter(function (b) { return b.isRed; }).map(function (b) { return cropBand(cell, b, 'red'); });
  }

  /**
   * 识别出的数字里的数字部分：去掉千分位（逗号、被认成句点的逗号）和其他字符。
   * Laplace 的数字 10,000 以上都有千分位，最后一段应该正好 3 位；多出来的是后面的「*」被认成了数字，去掉
   */
  function digitsOf(s) {
    var groups = String(s).replace(/[^\d,.]/g, '').split(/[,.]/).filter(Boolean);
    if (groups.length > 1 && groups[groups.length - 1].length > 3) groups[groups.length - 1] = groups[groups.length - 1].slice(0, 3);
    return groups.join('');
  }

  /** 识别出的整数（负号可能被认成各种横线） */
  function toInt(s) {
    var neg = /^[-—–~_]/.test(s.trim());
    var v = Number(digitsOf(s));
    return neg ? -v : v;
  }

  /**
   * 一个敌人栏识别出的几行（第一行 HP，后面是红字：DMG（可能换行）、RNG）→ { hp, dmg, random, rngMissing }。
   * 没认出 HP 或 DMG 时对应的值是 null；random = null 表示没有 RNG 行（随机数是默认的 0.9）；
   * rngMissing = 有 RNG 行但没认出数字
   */
  function parseCell(text) {
    var lines = String(text).replace(/[，]/g, ',').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var out = { hp: null, dmg: null, random: null, rngMissing: false };
    if (!lines.length) return out;
    var m = lines[0].match(/^H?P?\s*([-—–~_]?\s*\d[\d,.\s]*)$/);
    if (m) out.hp = toInt(m[1]);
    var dmgText = '';
    lines.slice(1).forEach(function (l) {
      if (/[RN]/.test(l)) {                                // RNG 行（DMG 行只有 D、M、G 三个字母）
        var r = l.match(/(\d+(?:\.\d+)?)/);
        if (r) out.random = Number(r[1]); else out.rngMissing = true;
      } else dmgText += l.replace(/[^\d,.]/g, '');      // DMG 和数字可能分在两行
    });
    if (digitsOf(dmgText)) out.dmg = Number(digitsOf(dmgText));
    return out;
  }

  /** 出卡一栏几行红字的识别结果 → 这张卡的总伤害（「DMG 数字」那行；DMG 和数字分成两行时取下一行），认不出时 null */
  function parseTotal(texts) {
    for (var i = 0; i < texts.length; i++) {
      var t = String(texts[i]).trim();
      if (!/MG|DM/.test(t)) continue;
      var digits = digitsOf(t);
      if (!digits && i + 1 < texts.length) digits = digitsOf(texts[i + 1]);
      if (digits) return Number(digits);
    }
    return null;
  }

  /** 均伤：⌈DMG ÷ 随机数⌉（保留两位小数），这样 ⌊随机数 × 均伤⌋ = DMG */
  function averageOf(dmg, random) {
    var v = Math.ceil(Number((dmg / random * 100).toPrecision(15))) / 100;
    if (Math.floor(Number((v * random).toPrecision(15))) < dmg) v = (Math.round(v * 100) + 1) / 100;
    return v;
  }

  var TEXT_FRAME = 1066;                                 // 格子宽 1066 像素时（1206 宽的单栏截图）字号最合适，窄的放大后再识别

  var VARIANTS = ['plain', 'ink'];

  /**
   * 读一张截图。ocr(image, scale, kind) → Promise<文字>：image 是一行字（白底黑字），scale = 识别前建议放大的倍数，
   * kind = 'hp'（只有 HP 和数字、负号、逗号）或 'red'（DMG / RNG 和数字、逗号、小数点、*）。progress(done, total) 可省略。
   * 每一栏用两种图各识别一次（见 cellLines），结果不一样时再放大认一次；在 buildTurns 里按血量核对、多数挑出对得上的那个。
   * 出卡一栏的总伤害也认两次（totals），用来核对各敌人的伤害之和（每个敌人挨的第一张卡，血量链核对不到）。
   * 返回 Promise<{ frame, records: [{ top, bottom, totals: [总伤害 | null], cells: [{ slot: 1 ~ 3, candidates: [{ hp, dmg, random, rngMissing, text }] }] }] }>
   */
  function readShot(img, ocr, progress) {
    var frame = findBoxes(img), jobs = [], records = [];
    frame.boxes.forEach(function (box) {
      var rec = { top: box[0], bottom: box[1], cells: [], totals: [] };
      records.push(rec);
      var any = false;
      for (var s = 0; s < SLOTS; s++) {
        var cell = cellImage(img, cellRect(frame, box, s));
        if (cell.red >= 30) { jobs.push({ rec: rec, slot: s + 1, lines: cellLines(cell) }); any = true; }
      }
      if (any) jobs.push({ rec: rec, attacker: attackerLines(cellImage(img, attackerRect(frame, box))) });
    });
    var done = 0, scale = Math.max(1, TEXT_FRAME / (frame.right - frame.left));
    var cellJobs = jobs.filter(function (j) { return !j.attacker; }).length;
    if (progress) progress(0, cellJobs);
    return jobs.reduce(function (p, job) {
      if (job.attacker) {                                // 出卡一栏的总伤害：两种图各认一次
        return VARIANTS.reduce(function (q, variant) {
          var texts = [];
          return job.attacker.reduce(function (r, line) {
            return r.then(function () { return ocr(line[variant], scale, 'red'); }).then(function (t) { texts.push(t); });
          }, q).then(function () { job.rec.totals.push(parseTotal(texts)); });
        }, p);
      }
      var candidates = [];
      return VARIANTS.reduce(function (q, variant) {
        var texts = [];
        return job.lines.reduce(function (r, line) {
          return r.then(function () { return ocr(line[variant], scale, line.kind); }).then(function (t) { texts.push(String(t).trim()); });
        }, q).then(function () {
          var text = texts.join('\n'), c = parseCell(text);
          c.text = text;
          candidates.push(c);
        });
      }, p).then(function () {
        // 两种图认出的数字不一样：再放大一些认一次，三次里取多数（见 chooseChain）
        var a = candidates[0], b = candidates[1];
        if (a.hp === null || a.dmg === null || b.hp === null || b.dmg === null || (a.hp === b.hp && a.dmg === b.dmg)) return;
        var texts = [];
        return job.lines.reduce(function (r, line) {
          return r.then(function () { return ocr(line.ink, scale * 1.5, line.kind); }).then(function (t) { texts.push(String(t).trim()); });
        }, Promise.resolve()).then(function () {
          var text = texts.join('\n'), c = parseCell(text);
          c.text = text;
          candidates.push(c);
        });
      }).then(function () {
        job.rec.cells.push({ slot: job.slot, candidates: candidates });
        done++;
        if (progress) progress(done, cellJobs);
      });
    }, Promise.resolve()).then(function () {
      return { frame: frame, records: records.filter(function (r) { return r.cells.length; }) };
    });
  }

  /** 一栏的几种识别结果 → 不同的 (HP, DMG) 组合，每种记下认成这样的次数（votes） */
  function optionsOf(candidates) {
    var list = [];
    candidates.forEach(function (x) {
      if (x.hp === null || x.dmg === null) return;
      var same = list.filter(function (y) { return y.hp === x.hp && y.dmg === x.dmg; })[0];
      if (same) {
        same.votes++;
        if (same.random === null && x.random !== null) same.random = x.random;
        if (!x.rngMissing) same.rngMissing = false;
      } else list.push({ hp: x.hp, dmg: x.dmg, random: x.random, rngMissing: !!x.rngMissing, votes: 1, boxOk: false });
    });
    return list.length ? list : [{ hp: null, dmg: null, random: null, rngMissing: false, votes: 0, boxOk: false }];
  }

  /**
   * 同一个敌人这回合挨的几张卡（cells[i].options 见 optionsOf；或者 cells[i].candidates），挑一组让血量前后对得上的：
   * 每张卡 HP、DMG 都认出 +1，挨打前的血量是正数 +1，和前一张卡对得上 +3，这张卡各敌人的伤害之和等于出卡的总伤害 +2；
   * 分数一样时取认成这样的次数多的，再一样取排在前面的。
   * 返回每张卡 { pick: 选中的结果, contested: 有另一种结果不比它差（只挨一张卡、又没有总伤害可以核对时，要检查） }
   */
  function chooseChain(cells) {
    var opts = cells.map(function (c) { return c.options || optionsOf(c.candidates); });
    var best = null, bestScore = -1;
    (function walk(i, picked, score) {
      if (i === opts.length) { if (score > bestScore) { bestScore = score; best = picked.slice(); } return; }
      opts[i].forEach(function (o) {
        var add = o.votes * 0.01, prev = picked[i - 1];          // 次数只在分数一样时起作用
        if (o.hp !== null) {
          add++;
          if (o.boxOk) add += 2;
          if (i === 0) { if (o.hp + o.dmg > 0) add++; }
          else if (prev.hp !== null && prev.hp - o.dmg === o.hp) add += 3;
        }
        picked.push(o);
        walk(i + 1, picked, score + add);
        picked.pop();
      });
    })(0, [], 0);
    return best.map(function (o, i) {
      return { pick: o, contested: opts[i].some(function (x) { return x !== o && x.votes >= o.votes && !(o.boxOk && !x.boxOk); }) };
    });
  }

  /** 一张卡（一个格子）：各敌人栏的结果组合里，伤害之和等于出卡总伤害的，标上 boxOk */
  function markBoxSums(cells, totals) {
    var want = totals.filter(function (t) { return t !== null; });
    if (!want.length) return;
    (function walk(i, sum, picked) {
      if (i === cells.length) {
        if (want.indexOf(sum) >= 0) picked.forEach(function (o) { o.boxOk = true; });
        return;
      }
      cells[i]._options.forEach(function (o) {
        if (o.dmg === null) return;
        picked.push(o);
        walk(i + 1, sum + o.dmg, picked);
        picked.pop();
      });
    })(0, 0, []);
  }

  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };

  /**
   * 识别结果 → 每回合一个伤害组。width = 截图宽度（判断两个格子之间的空隙算不算换了回合）。
   * 返回 [{ turn, problems: [要检查的地方], notes: [提示], targets: [{ slot, life, hp, end, dims: [{ dmg, random, avg }] }], data: 伤害组数据 }]；
   * targets[0] 是主目标（挨的卡最多；一样多时取血量多的），其余是 AOE 其他目标。
   * 同一位置的敌人打死以后又有了血（复活、回合中换下一条血）：后面的卡算另一个目标（life = 2、3…），写进 notes
   */
  function buildTurns(records, width) {
    var turns = [], gap = width * 0.05;
    records.forEach(function (r) {
      var last = turns[turns.length - 1];
      if (last && r.top - last[last.length - 1].bottom < gap) last.push(r);
      else turns.push([r]);
    });
    return turns.map(function (recs, t) {
      var targets = [], problems = [], notes = [], chains = {};
      recs.forEach(function (r, card) {
        r.cells.forEach(function (c) {
          c._options = optionsOf(c.candidates || [{ hp: c.hp, dmg: c.dmg, random: c.random, rngMissing: false }]);
          (chains[c.slot] = chains[c.slot] || []).push({ card: card, options: c._options, cell: c });
        });
        markBoxSums(r.cells, r.totals || []);
      });
      Object.keys(chains).sort().forEach(function (slot) {
        var cells = chains[slot], e = null, lives = 0;
        chooseChain(cells).forEach(function (p, k) {
          var c = p.pick, where = '第 ' + (cells[k].card + 1) + ' 张卡、位置 ' + slot;
          cells[k].cell._pick = c;
          if (c.hp === null) { problems.push(where + '：没认出 HP 或 DMG'); return; }
          var start = c.hp + c.dmg;
          if (e && e.end - c.dmg !== c.hp) {
            if (e.end <= 0 && start > 0) {
              // 已经打死了，又有了新的血（复活、下一条血）：后面的伤害算另一个目标
              notes.push(where + '：前一下已经打到 ' + fmt(e.end) + '，这一下又有 ' + fmt(start) + ' 血（复活或下一条血），当作另一个目标');
              e = null;
            } else {
              problems.push(where + '：' + fmt(e.end) + ' − ' + fmt(c.dmg) + ' ≠ ' + fmt(c.hp) + '，可能有数字认错了，也可能是关卡机制（回血等），请对照截图');
            }
          }
          if (!e) {
            lives++;
            e = { slot: Number(slot), life: lives, hp: start, end: start, dims: [] };
            targets.push(e);
            if (cells.length === 1 && p.contested) problems.push(where + '：几次识别的结果不一样，又没有别的数字可以核对');
          }
          e.end = c.hp;
          var random = c.random || DEFAULT_RANDOM;
          if (c.random === null && c.rngMissing) problems.push(where + '：没认出随机数（RNG），先按 0.9 算');
          if (random < 0.9 || random > 1.1) { problems.push(where + '：随机数 ' + random + ' 不在 0.9 ~ 1.1 之间'); random = DEFAULT_RANDOM; }
          e.dims.push({ dmg: c.dmg, random: random, avg: averageOf(c.dmg, random) });
        });
      });
      // 每张卡：各敌人的伤害之和 = 出卡一栏的总伤害（核对每个敌人挨的第一张卡；总伤害没认出来时没法核对）
      recs.forEach(function (r, card) {
        var want = (r.totals || []).filter(function (x) { return x !== null; });
        if (!want.length || r.cells.some(function (c) { return !c._pick || c._pick.dmg === null; })) return;
        var sum = r.cells.reduce(function (s, c) { return s + c._pick.dmg; }, 0);
        if (want.indexOf(sum) < 0) problems.push('第 ' + (card + 1) + ' 张卡：各位置的伤害加起来是 ' + fmt(sum) + '，出卡一栏的总伤害是 ' + fmt(want[0]) + '，有数字认错了');
      });
      targets.sort(function (a, b) { return b.dims.length - a.dims.length || b.hp - a.hp || a.slot - b.slot || a.life - b.life; });
      targets.forEach(function (e) { if (e.hp <= 0) problems.push('位置 ' + e.slot + '：挨打前的血量 ' + fmt(e.hp) + ' 不是正数，有数字认错了'); });
      if (!targets.length) problems.push('这一回合没有认出任何伤害');
      var dims = function (e) { return e.dims.map(function (d) { return String(d.avg); }); };
      var data = targets.length ? {
        cards: dims(targets[0]), hp: String(targets[0].hp), sl: '',
        aoe: targets.slice(1).map(function (e) { return { cards: dims(e), hp: String(e.hp) }; }),
      } : null;
      return { turn: t + 1, problems: problems, notes: notes, targets: targets, data: data };
    });
  }

  var api = { chooseChain: chooseChain, parseTotal: parseTotal, attackerRect: attackerRect, attackerLines: attackerLines, findBoxes: findBoxes, cellRect: cellRect, cellImage: cellImage, cellLines: cellLines, parseCell: parseCell, averageOf: averageOf, readShot: readShot, buildTurns: buildTurns };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LaplaceShot = api;
})(typeof self !== 'undefined' ? self : this);
