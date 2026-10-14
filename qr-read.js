/*
 * 识别图片里的二维码（导入「从图片读取二维码」用）。不依赖页面：网页、Node 测试都能用；版式表来自 qr.js。
 * 适合截图、保存下来的二维码图片（可以缩放、被聊天软件压缩、稍微倾斜）；不适合透视很大的照片。
 *
 * 步骤：灰度 → 黑白（先用全图阈值，失败再用局部阈值）→ 按 1:1:3:1:1 找三个定位图案 → 估计版本
 *     → 找右下角的对齐图案，用四个点做透视校正 → 按模块读出黑白 → 格式信息（纠错等级、掩码）、版本信息
 *     → 去掉掩码、按顺序读出码字 → 分块、Reed–Solomon 纠错 → 解析数据（数字、字母数字、字节；字节按 UTF-8）。
 * decode({ width, height, data: RGBA }) → 文字；找不到或读不出时抛出带说明的错误。
 */
(function (root) {
  'use strict';

  var QR = root.QR || (typeof require === 'function' ? require('./qr.js') : null);
  var EXP = QR.EXP, LOG = QR.LOG;

  // ---------- 黑白 ----------

  function luminance(img) {
    var n = img.width * img.height, out = new Uint8Array(n), d = img.data;
    for (var i = 0; i < n; i++) {
      var a = d[i * 4 + 3], l = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      out[i] = 255 - (a * (255 - l)) / 255;                // 透明当作白色
    }
    return out;
  }

  /** 全图阈值（Otsu） */
  function otsu(lum) {
    var hist = new Array(256).fill(0), n = lum.length;
    for (var i = 0; i < n; i++) hist[lum[i]]++;
    var sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, threshold = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = n - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = i; }
    }
    var out = new Uint8Array(n);
    for (i = 0; i < n; i++) out[i] = lum[i] <= threshold ? 1 : 0;
    return out;
  }

  /** 局部阈值：比周围平均暗一点就算黑（光线不均匀时用） */
  function adaptive(lum, w, h) {
    var integral = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var row = 0;
      for (var x = 0; x < w; x++) {
        row += lum[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    var r = Math.max(8, Math.round(Math.min(w, h) / 16)), out = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var s = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        out[y * w + x] = lum[y * w + x] < s / ((x1 - x0) * (y1 - y0)) - 8 ? 1 : 0;
      }
    }
    return out;
  }

  // ---------- 定位图案（黑:白:黑:白:黑 = 1:1:3:1:1） ----------

  function ratioOk(c) {
    var total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (total < 7) return false;
    var m = total / 7, v = m / 1.6;
    return Math.abs(m - c[0]) < v && Math.abs(m - c[1]) < v && Math.abs(3 * m - c[2]) < 3 * v && Math.abs(m - c[3]) < v && Math.abs(m - c[4]) < v;
  }

  /** 从 (x, y) 沿 (dx, dy) 方向两边数黑白段，看中心是不是 1:1:3:1:1；是的话返回中心坐标（沿这个方向）和总长度 */
  function crossCheck(bits, w, h, x, y, dx, dy) {
    var at = function (k) { var px = Math.round(x + dx * k), py = Math.round(y + dy * k); return px >= 0 && py >= 0 && px < w && py < h ? bits[py * w + px] : -1; };
    if (at(0) !== 1) return null;
    var c = [0, 0, 0, 0, 0], k = 0;
    while (at(-k) === 1) { c[2]++; k++; }
    while (at(-k) === 0) { c[1]++; k++; }
    while (at(-k) === 1) { c[0]++; k++; }
    var back = k;
    k = 1;
    while (at(k) === 1) { c[2]++; k++; }
    while (at(k) === 0) { c[3]++; k++; }
    while (at(k) === 1) { c[4]++; k++; }
    if (!ratioOk(c)) return null;
    var start = -back + 1, end = k - 1;                  // 第一个黑像素到最后一个黑像素
    return { total: c[0] + c[1] + c[2] + c[3] + c[4], start: start, end: end };
  }

  /**
   * 二维检查：以 (cx, cy) 为中心、每格 module 像素，对照定位图案的 9 × 9 样子
   * （外圈黑、一圈白、中间 3 × 3 黑，再外面一圈白色分隔带）；数据区里偶然出现的 1:1:3:1:1 一般过不了
   */
  function looksLikeFinder(bits, w, h, cx, cy, module) {
    var ok = 0;
    for (var r = -4; r <= 4; r++) {
      for (var c = -4; c <= 4; c++) {
        var ring = Math.max(Math.abs(r), Math.abs(c));
        var want = ring === 3 || ring <= 1;
        var x = Math.round(cx + c * module), y = Math.round(cy + r * module);
        var dark = x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1;
        if (dark === want) ok++;
      }
    }
    return ok >= 72;                                     // 81 个点里最多错 9 个（模块很小时边界上的点可能读到隔壁）
  }

  function findFinders(bits, w, h) {
    var found = [];
    var add = function (x, y, size) {
      for (var i = 0; i < found.length; i++) {
        var f = found[i];
        if (Math.abs(f.x - x) < f.size / 7 * 2 && Math.abs(f.y - y) < f.size / 7 * 2) {
          f.x = (f.x * f.count + x) / (f.count + 1);
          f.y = (f.y * f.count + y) / (f.count + 1);
          f.size = (f.size * f.count + size) / (f.count + 1);
          f.count++;
          return;
        }
      }
      found.push({ x: x, y: y, size: size, count: 1 });
    };
    for (var y = 0; y < h; y++) {
      var c = [0, 0, 0, 0, 0], state = 0, row = y * w;
      for (var x = 0; x <= w; x++) {
        var b = x < w ? bits[row + x] : 0;
        var dark = b === 1;
        if (state === 0 && !dark && !c[0]) continue;     // 还没遇到黑
        var expectDark = state % 2 === 0;
        if (dark === expectDark) { c[state]++; continue; }
        if (state < 4) { state++; c[state] = 1; continue; }
        // 一组 5 段结束
        if (ratioOk(c)) {
          var cx = x - c[4] - c[3] - c[2] / 2;
          var v = crossCheck(bits, w, h, Math.floor(cx), y, 0, 1);
          if (v) {
            var cy = y + (v.start + v.end) / 2;
            var hz = crossCheck(bits, w, h, Math.floor(cx), Math.round(cy), 1, 0);
            if (hz && Math.abs(hz.total - v.total) < 0.3 * (hz.total + v.total) / 2) {
              var fx = Math.floor(cx) + (hz.start + hz.end) / 2, size = (v.total + hz.total) / 2;
              if (looksLikeFinder(bits, w, h, fx, cy, size / 7)) add(fx, cy, size);
            }
          }
        }
        // 去掉前两段，继续找
        c = [c[2], c[3], c[4], 1, 0];
        state = 3;
      }
    }
    return found;
  }

  /** 三个定位图案：边长相近、构成直角等腰三角形；返回 [左上, 右上, 左下] */
  function pickThree(found) {
    var cands = found.filter(function (f) { return f.count >= 2; });
    if (cands.length < 3) cands = found;
    cands = cands.sort(function (a, b) { return b.count - a.count; }).slice(0, 12);
    var best = null, dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
    for (var i = 0; i < cands.length; i++) for (var j = i + 1; j < cands.length; j++) for (var k = j + 1; k < cands.length; k++) {
      var p = [cands[i], cands[j], cands[k]];
      var sizes = p.map(function (f) { return f.size; }), smax = Math.max.apply(null, sizes), smin = Math.min.apply(null, sizes);
      if (smax > smin * 1.6) continue;
      var d = [dist(p[1], p[2]), dist(p[0], p[2]), dist(p[0], p[1])];   // d[i] = 对着第 i 个点的边
      var top = d.indexOf(Math.max.apply(null, d));                     // 直角对着最长边
      var tl = p[top], a = p[(top + 1) % 3], b = p[(top + 2) % 3];
      var la = dist(tl, a), lb = dist(tl, b);
      if (la < smin * 2 || lb < smin * 2) continue;
      var cos = ((a.x - tl.x) * (b.x - tl.x) + (a.y - tl.y) * (b.y - tl.y)) / (la * lb);
      var score = Math.abs(la - lb) / Math.max(la, lb) + Math.abs(cos) + (smax - smin) / smax;
      if (score > 0.5) continue;
      if (!best || score < best.score) {
        // 叉积 > 0（屏幕坐标 y 向下）：a 是右上、b 是左下
        var cross = (a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x);
        best = { score: score, pts: cross > 0 ? [tl, a, b] : [tl, b, a] };
      }
    }
    return best ? best.pts : null;
  }

  // ---------- 透视变换（四个点 → 四个点） ----------

  function squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3) {
    var dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-10 && Math.abs(dy3) < 1e-10) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    }
    var dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    var den = dx1 * dy2 - dx2 * dy1;
    var a13 = (dx3 * dy2 - dx2 * dy3) / den, a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return [x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1];
  }

  function adjoint(m) {
    return [m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]];
  }

  function times(a, b) {                                 // 3 × 3 矩阵相乘（按行存）
    var out = [];
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
    return out;
  }

  /** 把源四边形（模块坐标）映射到目标四边形（图片坐标）的变换；返回 (x, y) → [px, py] */
  function quadToQuad(src, dst) {
    // 用列向量约定：p' = M p；squareToQuad 给出的是「单位正方形 → 四边形」
    var toDst = squareToQuad.apply(null, dst), toSrc = squareToQuad.apply(null, src);
    var m = times(toColumn(toDst), adjoint(toColumn(toSrc)));
    return function (x, y) {
      var d = m[6] * x + m[7] * y + m[8];
      return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
    };
  }

  function toColumn(t) {                                 // squareToQuad 的结果 [a11 a21 a31 a12 a22 a32 a13 a23 a33] → 按行的矩阵
    return [t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]];
  }

  // ---------- 读模块 ----------

  /**
   * 读一个模块：spread > 0 时用模块中心和四个斜角方向（各 spread 格）共 5 个点投票（噪点多时更稳）；
   * spread = 0 只看中心（模块很小又模糊时，偏离中心的点容易落在灰色的边上）
   */
  function sampler(bits, w, h, map, spread) {
    var at = function (x, y) {                           // 坐标以像素中心为整数
      x = Math.round(x); y = Math.round(y);
      return x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1 ? 1 : 0;
    };
    return function (col, row) {
      var n = 0;
      for (var k = 0; k < 5; k++) {
        var dx = k ? (k & 1 ? spread : -spread) : 0, dy = k ? (k & 2 ? spread : -spread) : 0;
        var p = map(col + 0.5 + dx, row + 0.5 + dy);
        n += at(p[0], p[1]);
      }
      return n >= 3;
    };
  }

  /** 在预计位置附近找右下角的对齐图案（中心黑、一圈白、外圈黑） */
  function findAlignment(bits, w, h, map, size, module) {
    var cx = size - 6.5, cy = size - 6.5, guess = map(cx, cy), r = Math.max(4, Math.round(module * Math.max(4, size * 0.04)));
    var best = null;
    var dark = function (x, y) { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1; };
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        var x = guess[0] + dx, y = guess[1] + dy, score = 0;
        if (!dark(x, y)) continue;
        for (var k = 0; k < 8; k++) {
          var ang = k * Math.PI / 4;
          if (!dark(x + Math.cos(ang) * module, y + Math.sin(ang) * module)) score++;
          if (dark(x + Math.cos(ang) * module * 2, y + Math.sin(ang) * module * 2)) score++;
        }
        var off = Math.hypot(dx, dy) / r;
        if (score >= 14 && (!best || score - off > best.score)) best = { x: x, y: y, score: score - off };
      }
    }
    return best;
  }

  /** 15 位 / 18 位的信息：和所有合法值比，取海明距离最小的（最多错 3 位） */
  function closest(value, candidates) {
    var best = null;
    candidates.forEach(function (c) {
      var x = value ^ c.bits, n = 0;
      while (x) { n += x & 1; x >>>= 1; }
      if (n <= 3 && (!best || n < best.dist)) best = { dist: n, value: c };
    });
    return best ? best.value : null;
  }

  var FORMATS = [];
  ['L', 'M', 'Q', 'H'].forEach(function (level) { for (var mask = 0; mask < 8; mask++) FORMATS.push({ bits: QR.formatBits(level, mask), level: level, mask: mask }); });
  var VERSIONS = [];
  for (var v = 7; v <= 40; v++) VERSIONS.push({ bits: QR.versionBits(v), version: v });

  function readFormat(get, size) {
    var a = 0, b = 0;
    for (var i = 0; i < 15; i++) {
      var p = i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : [size - 15 + i, 8];
      var q = i < 8 ? [8, size - i - 1] : i < 9 ? [8, 15 - i] : [8, 14 - i];
      if (get(p[1], p[0])) a |= 1 << i;
      if (get(q[1], q[0])) b |= 1 << i;
    }
    return closest(a, FORMATS) || closest(b, FORMATS);
  }

  function readVersion(get, size) {
    var a = 0, b = 0;
    for (var i = 0; i < 18; i++) {
      var r = Math.floor(i / 3), c = i % 3 + size - 11;
      if (get(c, r)) a |= 1 << i;                         // 右上角那份
      if (get(r, c)) b |= 1 << i;                         // 左下角那份
    }
    var hit = closest(a, VERSIONS) || closest(b, VERSIONS);
    return hit ? hit.version : null;
  }

  // ---------- Reed–Solomon 纠错（生成多项式的根 α^0 … α^(n−1)） ----------

  var mul = function (a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; };
  var div = function (a, b) { return a ? EXP[(LOG[a] - LOG[b] + 255) % 255] : 0; };
  /** 多项式（系数从低次到高次）在 x 处的值 */
  var evalPoly = function (p, x) { var s = 0; for (var i = p.length - 1; i >= 0; i--) s = mul(s, x) ^ p[i]; return s; };

  /** 纠正一块码字（数据 + 纠错码，第一个码字是最高次项）；纠不了时返回 null */
  function rsCorrect(block, nEc) {
    var N = block.length, r = block.slice(), S = [], any = false;
    var asc = r.slice().reverse();                       // r(x) 系数从低到高
    for (var j = 0; j < nEc; j++) { S.push(evalPoly(asc, EXP[j])); if (S[j]) any = true; }
    if (!any) return r;
    // Berlekamp–Massey：错误位置多项式 Λ
    var C = [1], B = [1], L = 0, m = 1, bb = 1;
    for (var n = 0; n < nEc; n++) {
      var d = S[n];
      for (var i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[n - i]);
      if (!d) { m++; continue; }
      var coef = div(d, bb), T = C.slice();
      var need = B.length + m;
      while (C.length < need) C.push(0);
      for (i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= n) { L = n + 1 - L; B = T; bb = d; m = 1; } else m++;
    }
    while (C.length > L + 1) C.pop();
    if (L * 2 > nEc) return null;
    // Chien 搜索：Λ(X⁻¹) = 0 的位置
    var pos = [];
    for (var p = 0; p < N; p++) if (evalPoly(C, EXP[(255 - p) % 255]) === 0) pos.push(p);
    if (pos.length !== L) return null;
    // Forney：误差值 e = X · Ω(X⁻¹) / Λ'(X⁻¹)
    var omega = new Array(nEc).fill(0);
    for (i = 0; i < nEc; i++) for (var k = 0; k <= i && k < C.length; k++) omega[i] ^= mul(C[k], S[i - k]);
    var deriv = [];
    for (i = 1; i < C.length; i++) deriv.push(i % 2 ? C[i] : 0);
    for (var t = 0; t < pos.length; t++) {
      var X = EXP[pos[t] % 255], Xinv = EXP[(255 - pos[t]) % 255];
      var den = evalPoly(deriv, Xinv);
      if (!den) return null;
      var e = mul(X, div(evalPoly(omega, Xinv), den));
      r[N - 1 - pos[t]] ^= e;
    }
    asc = r.slice().reverse();                           // 再检查一次
    for (j = 0; j < nEc; j++) if (evalPoly(asc, EXP[j])) return null;
    return r;
  }

  // ---------- 数据 ----------

  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function parseData(bytes, version) {
    var pos = 0, total = bytes.length * 8;
    var read = function (n) {
      var v = 0;
      for (var i = 0; i < n; i++, pos++) v = (v << 1) | (pos < total ? (bytes[pos >> 3] >> (7 - (pos & 7))) & 1 : 0);
      return v;
    };
    var size = version < 10 ? 0 : version < 27 ? 1 : 2, text = '', raw = [];
    var flush = function () {
      if (!raw.length) return;
      text += typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(new Uint8Array(raw)) : decodeURIComponent(escape(String.fromCharCode.apply(null, raw)));
      raw = [];
    };
    while (pos + 4 <= total) {
      var mode = read(4);
      if (mode === 0) break;
      if (mode === 4) {
        var n = read([8, 16, 16][size]);
        for (var i = 0; i < n; i++) raw.push(read(8));
      } else if (mode === 2) {
        flush();
        n = read([9, 11, 13][size]);
        for (i = 0; i + 1 < n; i += 2) { var v2 = read(11); text += ALNUM[Math.floor(v2 / 45)] + ALNUM[v2 % 45]; }
        if (n % 2) text += ALNUM[read(6)];
      } else if (mode === 1) {
        flush();
        n = read([10, 12, 14][size]);
        for (i = 0; i + 2 < n; i += 3) text += String(read(10)).padStart(3, '0');
        if (n % 3 === 2) text += String(read(7)).padStart(2, '0');
        else if (n % 3 === 1) text += String(read(4));
      } else if (mode === 7) {
        var first = read(8);                             // ECI：跳过编号（这里一律按 UTF-8）
        if ((first & 0xc0) === 0x80) read(8); else if ((first & 0xe0) === 0xc0) read(16);
      } else throw new Error('二维码里的内容格式不支持');
    }
    flush();
    return text;
  }

  // ---------- 一次尝试：给定定位图案和版本 ----------

  function tryVersion(bits, w, h, pts, version, module) {
    var size = version * 4 + 17;
    var src = [3.5, 3.5, size - 3.5, 3.5, size - 3.5, size - 3.5, 3.5, size - 3.5];
    var tl = pts[0], tr = pts[1], bl = pts[2];
    var br = [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y];
    var map = quadToQuad(src, [tl.x, tl.y, tr.x, tr.y, br[0], br[1], bl.x, bl.y]), maps = [map];
    if (version >= 2) {                                  // 有对齐图案：用它代替推算的第四个点，校正透视（找错时用推算的）
      var ap = findAlignment(bits, w, h, map, size, module);
      if (ap) maps.unshift(quadToQuad([3.5, 3.5, size - 3.5, 3.5, size - 6.5, size - 6.5, 3.5, size - 3.5], [tl.x, tl.y, tr.x, tr.y, ap.x, ap.y, bl.x, bl.y]));
    }
    var retry = null;
    for (var i = 0; i < maps.length * 2; i++) {
      var r = readGrid(sampler(bits, w, h, maps[i >> 1], i & 1 ? 0 : 0.2), version, size);
      if (r && typeof r.text === 'string') return r;
      if (r && r.retry) retry = r;
    }
    return retry;
  }

  /** 按模块读出内容：格式信息、版本信息、去掩码、分块纠错、解析 */
  function readGrid(get, version, size) {
    var fmt = readFormat(get, size);
    if (!fmt) return null;
    if (version >= 7) {
      var vv = readVersion(get, size);
      if (vv && vv !== version) return { retry: vv };
    }
    var mask = QR.MASKS[fmt.mask], codewords = [], cur = 0, nbits = 0;
    QR.dataOrder(version).forEach(function (p) {
      var bit = get(p[1], p[0]) !== mask(p[0], p[1]);
      cur = (cur << 1) | (bit ? 1 : 0);
      if (++nbits === 8) { codewords.push(cur); cur = 0; nbits = 0; }
    });
    // 分块（与生成时的交错相反）
    var spec = [];
    QR.blocks(version, fmt.level).forEach(function (b) { for (var i = 0; i < b[0]; i++) spec.push({ total: b[1], data: b[2], cw: [] }); });
    var maxD = Math.max.apply(null, spec.map(function (s) { return s.data; })), maxE = Math.max.apply(null, spec.map(function (s) { return s.total - s.data; }));
    var k = 0;
    for (var i = 0; i < maxD; i++) spec.forEach(function (s) { if (i < s.data) s.cw.push(codewords[k++]); });
    for (i = 0; i < maxE; i++) spec.forEach(function (s) { if (i < s.total - s.data) s.cw.push(codewords[k++]); });
    var data = [];
    for (i = 0; i < spec.length; i++) {
      var fixed = rsCorrect(spec[i].cw, spec[i].total - spec[i].data);
      if (!fixed) return null;
      data = data.concat(fixed.slice(0, spec[i].data));
    }
    return { text: parseData(data, version) };
  }

  function attempt(bits, w, h) {
    var pts = pickThree(findFinders(bits, w, h));
    if (!pts) return null;
    var module = (pts[0].size + pts[1].size + pts[2].size) / 21;
    var d = (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) + Math.hypot(pts[2].x - pts[0].x, pts[2].y - pts[0].y)) / 2 / module + 7;
    var guess = Math.min(40, Math.max(1, Math.round((d - 17) / 4)));
    var tried = {};
    var order = [guess, guess - 1, guess + 1, guess - 2, guess + 2];
    for (var i = 0; i < order.length; i++) {
      var v = order[i];
      if (v < 1 || v > 40 || tried[v]) continue;
      tried[v] = true;
      var r = tryVersion(bits, w, h, pts, v, module);
      if (r && r.retry && !tried[r.retry]) { tried[r.retry] = true; r = tryVersion(bits, w, h, pts, r.retry, module); }
      if (r && typeof r.text === 'string') return r.text;
    }
    return null;
  }

  /** 3 × 3 多数表决去掉零星的噪点 */
  function despeckle(bits, w, h) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var n = 0, k = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) { n += bits[yy * w + xx]; k++; }
        }
        out[y * w + x] = n * 2 > k ? 1 : 0;
      }
    }
    return out;
  }

  function decode(img) {
    var w = img.width, h = img.height, lum = luminance(img), bits = otsu(lum);
    var text = attempt(bits, w, h);
    if (text === null) text = attempt(adaptive(lum, w, h), w, h);
    if (text === null) text = attempt(despeckle(bits, w, h), w, h);
    if (text === null) throw new Error('没有在图片里找到能读的二维码：请选二维码清楚、完整的截图或图片');
    return text;
  }

  var api = { decode: decode, rsCorrect: rsCorrect, quadToQuad: quadToQuad };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRRead = api;
})(typeof self !== 'undefined' ? self : this);
