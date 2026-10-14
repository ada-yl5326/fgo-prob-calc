/*
 * 二维码生成（QR Code，字节模式、UTF-8；纠错等级默认 M）。不依赖页面：网页、Node 测试都能用。
 * 按 ISO/IEC 18004 实现：选最小的版本 → 数据码字 → 分块、Reed–Solomon 纠错码 → 交错 → 放进矩阵 → 8 种掩码里选扣分最少的。
 * 纠错块表、对齐图案位置表来自标准（与 Python 的 qrcode 库相同，tests/test_web_qr.py 逐个模块对照）。
 * encode(text, { level: 'L' | 'M' | 'Q' | 'H'（默认 M）, version, mask }) → { version, size, mask, modules: [[true = 深色, …], …] }
 * 识别二维码（qr-read.js）用同样的表：blocks()、formatBits()、versionBits()、reserved()。
 */
(function (root) {
  'use strict';

  var BLOCKS = {
    L: [[[1,26,19]], [[1,44,34]], [[1,70,55]], [[1,100,80]], [[1,134,108]], [[2,86,68]], [[2,98,78]], [[2,121,97]], [[2,146,116]], [[2,86,68],[2,87,69]], [[4,101,81]], [[2,116,92],[2,117,93]], [[4,133,107]], [[3,145,115],[1,146,116]], [[5,109,87],[1,110,88]], [[5,122,98],[1,123,99]], [[1,135,107],[5,136,108]], [[5,150,120],[1,151,121]], [[3,141,113],[4,142,114]], [[3,135,107],[5,136,108]], [[4,144,116],[4,145,117]], [[2,139,111],[7,140,112]], [[4,151,121],[5,152,122]], [[6,147,117],[4,148,118]], [[8,132,106],[4,133,107]], [[10,142,114],[2,143,115]], [[8,152,122],[4,153,123]], [[3,147,117],[10,148,118]], [[7,146,116],[7,147,117]], [[5,145,115],[10,146,116]], [[13,145,115],[3,146,116]], [[17,145,115]], [[17,145,115],[1,146,116]], [[13,145,115],[6,146,116]], [[12,151,121],[7,152,122]], [[6,151,121],[14,152,122]], [[17,152,122],[4,153,123]], [[4,152,122],[18,153,123]], [[20,147,117],[4,148,118]], [[19,148,118],[6,149,119]]],
    M: [[[1,26,16]], [[1,44,28]], [[1,70,44]], [[2,50,32]], [[2,67,43]], [[4,43,27]], [[4,49,31]], [[2,60,38],[2,61,39]], [[3,58,36],[2,59,37]], [[4,69,43],[1,70,44]], [[1,80,50],[4,81,51]], [[6,58,36],[2,59,37]], [[8,59,37],[1,60,38]], [[4,64,40],[5,65,41]], [[5,65,41],[5,66,42]], [[7,73,45],[3,74,46]], [[10,74,46],[1,75,47]], [[9,69,43],[4,70,44]], [[3,70,44],[11,71,45]], [[3,67,41],[13,68,42]], [[17,68,42]], [[17,74,46]], [[4,75,47],[14,76,48]], [[6,73,45],[14,74,46]], [[8,75,47],[13,76,48]], [[19,74,46],[4,75,47]], [[22,73,45],[3,74,46]], [[3,73,45],[23,74,46]], [[21,73,45],[7,74,46]], [[19,75,47],[10,76,48]], [[2,74,46],[29,75,47]], [[10,74,46],[23,75,47]], [[14,74,46],[21,75,47]], [[14,74,46],[23,75,47]], [[12,75,47],[26,76,48]], [[6,75,47],[34,76,48]], [[29,74,46],[14,75,47]], [[13,74,46],[32,75,47]], [[40,75,47],[7,76,48]], [[18,75,47],[31,76,48]]],
    Q: [[[1,26,13]], [[1,44,22]], [[2,35,17]], [[2,50,24]], [[2,33,15],[2,34,16]], [[4,43,19]], [[2,32,14],[4,33,15]], [[4,40,18],[2,41,19]], [[4,36,16],[4,37,17]], [[6,43,19],[2,44,20]], [[4,50,22],[4,51,23]], [[4,46,20],[6,47,21]], [[8,44,20],[4,45,21]], [[11,36,16],[5,37,17]], [[5,54,24],[7,55,25]], [[15,43,19],[2,44,20]], [[1,50,22],[15,51,23]], [[17,50,22],[1,51,23]], [[17,47,21],[4,48,22]], [[15,54,24],[5,55,25]], [[17,50,22],[6,51,23]], [[7,54,24],[16,55,25]], [[11,54,24],[14,55,25]], [[11,54,24],[16,55,25]], [[7,54,24],[22,55,25]], [[28,50,22],[6,51,23]], [[8,53,23],[26,54,24]], [[4,54,24],[31,55,25]], [[1,53,23],[37,54,24]], [[15,54,24],[25,55,25]], [[42,54,24],[1,55,25]], [[10,54,24],[35,55,25]], [[29,54,24],[19,55,25]], [[44,54,24],[7,55,25]], [[39,54,24],[14,55,25]], [[46,54,24],[10,55,25]], [[49,54,24],[10,55,25]], [[48,54,24],[14,55,25]], [[43,54,24],[22,55,25]], [[34,54,24],[34,55,25]]],
    H: [[[1,26,9]], [[1,44,16]], [[2,35,13]], [[4,25,9]], [[2,33,11],[2,34,12]], [[4,43,15]], [[4,39,13],[1,40,14]], [[4,40,14],[2,41,15]], [[4,36,12],[4,37,13]], [[6,43,15],[2,44,16]], [[3,36,12],[8,37,13]], [[7,42,14],[4,43,15]], [[12,33,11],[4,34,12]], [[11,36,12],[5,37,13]], [[11,36,12],[7,37,13]], [[3,45,15],[13,46,16]], [[2,42,14],[17,43,15]], [[2,42,14],[19,43,15]], [[9,39,13],[16,40,14]], [[15,43,15],[10,44,16]], [[19,46,16],[6,47,17]], [[34,37,13]], [[16,45,15],[14,46,16]], [[30,46,16],[2,47,17]], [[22,45,15],[13,46,16]], [[33,46,16],[4,47,17]], [[12,45,15],[28,46,16]], [[11,45,15],[31,46,16]], [[19,45,15],[26,46,16]], [[23,45,15],[25,46,16]], [[23,45,15],[28,46,16]], [[19,45,15],[35,46,16]], [[11,45,15],[46,46,16]], [[59,46,16],[1,47,17]], [[22,45,15],[41,46,16]], [[2,45,15],[64,46,16]], [[24,45,15],[46,46,16]], [[42,45,15],[32,46,16]], [[10,45,15],[67,46,16]], [[20,45,15],[61,46,16]]],
  };
  var ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]];
  var LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // ---------- GF(256)：本原多项式 x^8 + x^4 + x^3 + x^2 + 1（0x11D） ----------
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  var mul = function (a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; };

  /** n 个纠错码字：data × x^n 除以生成多项式 Π (x − α^i) 的余数 */
  function rsEncode(data, n) {
    var gen = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(gen.length + 1).fill(0);
      for (var j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
      gen = next;
    }
    var rem = new Array(n).fill(0);
    data.forEach(function (byte) {
      var f = byte ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var k = 0; k < n; k++) rem[k] ^= mul(gen[k + 1], f);
    });
    return rem;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return unescape(encodeURIComponent(text)).split('').map(function (c) { return c.charCodeAt(0); });
  }

  /** 第 version 版本、纠错等级 level 能放的数据码字数 */
  function capacity(version, level) {
    return BLOCKS[level][version - 1].reduce(function (s, b) { return s + b[0] * b[2]; }, 0);
  }

  /** 数据码字：模式 0100、长度、数据、结束符、补齐到整字节、填充 0xEC 0x11；放不下时返回 null */
  function dataCodewords(bytes, version, level) {
    var bits = [], put = function (v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    put(4, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var limit = capacity(version, level) * 8;
    if (bits.length > limit) return null;
    for (var i = 0; i < 4 && bits.length < limit; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    for (i = 0; bits.length < limit; i++) put(i % 2 ? 0x11 : 0xec, 8);
    var out = [];
    for (i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      out.push(v);
    }
    return out;
  }

  /** 分块、加纠错码、交错 */
  function finalCodewords(data, version, level) {
    var blocks = [], pos = 0;
    BLOCKS[level][version - 1].forEach(function (b) {
      for (var i = 0; i < b[0]; i++) {
        var d = data.slice(pos, pos + b[2]);
        pos += b[2];
        blocks.push({ d: d, e: rsEncode(d, b[1] - b[2]) });
      }
    });
    var out = [], maxD = 0, maxE = 0;
    blocks.forEach(function (b) { maxD = Math.max(maxD, b.d.length); maxE = Math.max(maxE, b.e.length); });
    for (var i = 0; i < maxD; i++) blocks.forEach(function (b) { if (i < b.d.length) out.push(b.d[i]); });
    for (i = 0; i < maxE; i++) blocks.forEach(function (b) { if (i < b.e.length) out.push(b.e[i]); });
    return out;
  }

  var MASKS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return (i * j) % 2 + (i * j) % 3 === 0; },
    function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; },
    function (i, j) { return ((i * j) % 3 + (i + j) % 2) % 2 === 0; },
  ];

  /** BCH 码：data 后面拼上「data 左移后除以 poly 的余数」 */
  function bch(data, poly) {
    var deg = function (x) { var n = 0; while (x) { n++; x >>>= 1; } return n; };
    var shifted = data << (deg(poly) - 1), d = shifted;
    while (deg(d) >= deg(poly)) d ^= poly << (deg(d) - deg(poly));
    return shifted | d;
  }

  /** 格式信息（15 位）：纠错等级 2 位 + 掩码 3 位，BCH(15,5)，再和 0x5412 异或 */
  function formatBits(level, mask) { return bch((LEVEL_BITS[level] << 3) | mask, 0x537) ^ 0x5412; }
  /** 版本信息（18 位，版本 7 起）：BCH(18,6) */
  function versionBits(version) { return bch(version, 0x1f25); }

  /** 只放功能图案（定位、对齐、时序、格式信息、版本信息、固定的深色模块）的矩阵；数据区为 null */
  function layout(version, level, mask) {
    var size = version * 4 + 17, m = [], r, i;
    for (r = 0; r < size; r++) m.push(new Array(size).fill(null));
    var finder = function (row, col) {
      for (var a = -1; a <= 7; a++) {
        for (var b = -1; b <= 7; b++) {
          if (row + a < 0 || row + a >= size || col + b < 0 || col + b >= size) continue;
          m[row + a][col + b] = (a >= 0 && a <= 6 && (b === 0 || b === 6)) || (b >= 0 && b <= 6 && (a === 0 || a === 6)) || (a >= 2 && a <= 4 && b >= 2 && b <= 4);
        }
      }
    };
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
    var pos = ALIGN[version - 1];
    pos.forEach(function (row) {
      pos.forEach(function (col) {
        if (m[row][col] !== null) return;
        for (var a = -2; a <= 2; a++) for (var b = -2; b <= 2; b++) m[row + a][col + b] = a === -2 || a === 2 || b === -2 || b === 2 || (a === 0 && b === 0);
      });
    });
    for (r = 8; r < size - 8; r++) {
      if (m[r][6] === null) m[r][6] = r % 2 === 0;
      if (m[6][r] === null) m[6][r] = r % 2 === 0;
    }
    var fmt = formatBits(level, mask);
    for (i = 0; i < 15; i++) {
      var on = ((fmt >> i) & 1) === 1;
      if (i < 6) m[i][8] = on; else if (i < 8) m[i + 1][8] = on; else m[size - 15 + i][8] = on;
      if (i < 8) m[8][size - i - 1] = on; else if (i < 9) m[8][15 - i] = on; else m[8][14 - i] = on;
    }
    m[size - 8][8] = true;                               // 固定的深色模块
    if (version >= 7) {                                  // 版本信息：BCH(18,6)
      var ver = versionBits(version);
      for (i = 0; i < 18; i++) {
        var v = ((ver >> i) & 1) === 1;
        m[Math.floor(i / 3)][i % 3 + size - 11] = v;
        m[i % 3 + size - 11][Math.floor(i / 3)] = v;
      }
    }
    return m;
  }

  /** 数据模块的位置，按放数据的顺序：从右下角开始，每次两列，上下来回；跳过第 6 列（时序图案） */
  function dataOrder(m) {
    var size = m.length, out = [], inc = -1, row = size - 1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var c = 0; c < 2; c++) if (m[row][col - c] === null) out.push([row, col - c]);
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
    return out;
  }

  /** 放好功能图案、数据、掩码、格式信息、版本信息的矩阵 */
  function build(codewords, version, level, mask) {
    var m = layout(version, level, mask), fn = MASKS[mask];
    dataOrder(m).forEach(function (p, k) {
      var byteIndex = k >> 3, bitIndex = 7 - (k & 7);
      var dark = byteIndex < codewords.length && ((codewords[byteIndex] >> bitIndex) & 1) === 1;
      if (fn(p[0], p[1])) dark = !dark;
      m[p[0]][p[1]] = dark;
    });
    return m;
  }

  /** 掩码扣分（越少越好）：连续同色、2×2 同色块、1:1:3:1:1 图案、深浅比例 */
  function penalty(m) {
    var n = m.length, p = 0, r, c;
    for (var pass = 0; pass < 2; pass++) {
      for (r = 0; r < n; r++) {
        var run = 1;
        for (c = 1; c <= n; c++) {
          var same = c < n && (pass ? m[c][r] === m[c - 1][r] : m[r][c] === m[r][c - 1]);
          if (same) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
      }
    }
    for (r = 0; r < n - 1; r++) {
      for (c = 0; c < n - 1; c++) {
        var v = m[r][c];
        if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) p += 3;
      }
    }
    var A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    var match = function (get, pat) { for (var k = 0; k < 11; k++) if (get(k) !== (pat[k] === 1)) return false; return true; };
    for (r = 0; r < n; r++) {
      for (c = 0; c + 10 < n; c++) {
        var inRow = function (k) { return m[r][c + k]; }, inCol = function (k) { return m[c + k][r]; };
        if (match(inRow, A) || match(inRow, B)) p += 40;
        if (match(inCol, A) || match(inCol, B)) p += 40;
      }
    }
    var dark = 0;
    m.forEach(function (line) { line.forEach(function (x) { if (x) dark++; }); });
    return p + Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  }

  function encode(text, opts) {
    opts = opts || {};
    var level = opts.level || 'M', bytes = utf8(String(text)), version = opts.version, data = null;
    if (version) data = dataCodewords(bytes, version, level);
    else for (version = 1; version <= 40 && !(data = dataCodewords(bytes, version, level)); version++) { /* 找最小的版本 */ }
    if (!data) throw new Error('内容太长，放不进二维码');
    var codewords = finalCodewords(data, version, level), best = null;
    for (var mask = 0; mask < 8; mask++) {
      if (opts.mask !== undefined && opts.mask !== mask) continue;
      var mm = build(codewords, version, level, mask), score = opts.mask !== undefined ? 0 : penalty(mm);
      if (!best || score < best.score) best = { modules: mm, mask: mask, score: score };
    }
    return { version: version, size: best.modules.length, mask: best.mask, modules: best.modules };
  }

  /** 第 version 版本、纠错等级 level 的分块 [[块数, 总码字, 数据码字], …] */
  var blocks = function (version, level) { return BLOCKS[level][version - 1]; };
  /** 功能图案占用的模块（true = 不是数据） */
  var reserved = function (version) { return layout(version, 'M', 0).map(function (row) { return row.map(function (x) { return x !== null; }); }); };

  var api = {
    encode: encode, capacity: capacity, blocks: blocks, formatBits: formatBits, versionBits: versionBits,
    reserved: reserved, dataOrder: function (version) { return dataOrder(layout(version, 'M', 0)); },
    MASKS: MASKS, LEVEL_BITS: LEVEL_BITS, ALIGN: ALIGN, EXP: EXP, LOG: LOG, rsEncode: rsEncode,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this);
