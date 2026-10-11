/* =========================================================
   画像圧縮ツール — script.js
   すべての処理はブラウザ内（端末内）で完結します。
   重い処理は Web Worker + OffscreenCanvas に逃がし、
   非対応環境ではメインスレッドにフォールバックします。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     Worker ソース（Blob URL として生成。外部ファイル不要）
     --------------------------------------------------------- */
  var WORKER_SRC = [
    'self.onmessage = async function (ev) {',
    '  var d = ev.data;',
    '  if (!d || d.type !== "compress") return;',
    '  try {',
    '    var bmp = await createImageBitmap(d.file);',
    '    var w = bmp.width, h = bmp.height;',
    '    if (d.maxDim > 0 && Math.max(w, h) > d.maxDim) {',
    '      var s = d.maxDim / Math.max(w, h);',
    '      w = Math.max(1, Math.round(w * s));',
    '      h = Math.max(1, Math.round(h * s));',
    '    }',
    '    var cv = new OffscreenCanvas(w, h);',
    '    var ctx = cv.getContext("2d");',
    '    ctx.imageSmoothingEnabled = true;',
    '    ctx.imageSmoothingQuality = "high";',
    '    if (d.mime === "image/jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); }',
    '    ctx.drawImage(bmp, 0, 0, w, h);',
    '    if (bmp.close) bmp.close();',
    '    var blob = await cv.convertToBlob({ type: d.mime, quality: d.quality });',
    '    if (!blob) throw new Error("エンコードに失敗しました");',
    '    self.postMessage({ id: d.id, ok: true, blob: blob, width: w, height: h });',
    '  } catch (err) {',
    '    self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });',
    '  }',
    '};'
  ].join('\n');

  /* ---------------------------------------------------------
     環境判定
     --------------------------------------------------------- */
  var hasWebp = (function () {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { return false; }
  })();

  var workerUrl = null;
  var worker = null;
  var pending = Object.create(null);
  var workerBroken = false;

  (function initWorker() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
        typeof createImageBitmap === 'undefined' || !self.URL || !URL.createObjectURL) {
      return;
    }
    try {
      workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = function (ev) {
        var d = ev.data || {};
        var job = pending[d.id];
        if (!job) return;
        delete pending[d.id];
        if (d.ok) job.resolve(d);
        else job.reject(new Error(d.error || '圧縮に失敗しました'));
      };
      worker.onerror = function () {
        workerBroken = true;
        Object.keys(pending).forEach(function (k) {
          pending[k].reject(new Error('worker unavailable'));
          delete pending[k];
        });
        try { worker.terminate(); } catch (e) {}
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
  })();

  var jobSeq = 0;

  /* ---------------------------------------------------------
     圧縮の実処理（Worker → メインスレッドの順に試す）
     --------------------------------------------------------- */
  function compressInWorker(file, opts) {
    if (!worker || workerBroken) return Promise.reject(new Error('no worker'));
    return new Promise(function (resolve, reject) {
      var id = 'job' + (++jobSeq);
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage({
        type: 'compress', id: id, file: file,
        quality: opts.quality, mime: opts.mime, maxDim: opts.maxDim
      }, []);
    });
  }

  function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  function compressOnMainThread(file, opts) {
    var src = null;
    return loadBitmap(file).then(function (bmp) {
      src = bmp;
      var w = bmp.width || bmp.naturalWidth;
      var h = bmp.height || bmp.naturalHeight;
      if (opts.maxDim > 0 && Math.max(w, h) > opts.maxDim) {
        var s = opts.maxDim / Math.max(w, h);
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
      }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (opts.mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();

      return new Promise(function (resolve, reject) {
        cv.toBlob(function (blob) {
          if (blob) resolve({ blob: blob, width: w, height: h });
          else reject(new Error('エンコードに失敗しました'));
        }, opts.mime, opts.quality);
      });
    });
  }

  function compress(file, opts) {
    if (worker && !workerBroken) {
      return compressInWorker(file, opts).catch(function () {
        return compressOnMainThread(file, opts);
      });
    }
    return compressOnMainThread(file, opts);
  }

  /* ---------------------------------------------------------
     ユーティリティ
     --------------------------------------------------------- */
  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    var kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(2) : mb.toFixed(1)) + ' MB';
  }

  function extFor(mime) {
    if (mime === 'image/jpeg') return '.jpg';
    if (mime === 'image/webp') return '.webp';
    if (mime === 'image/png') return '.png';
    return '';
  }

  function baseName(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function resolveMime(choice, file) {
    if (choice === 'image/webp' && !hasWebp) return file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (choice && choice !== 'auto') return choice;
    var t = file.type;
    if (t === 'image/jpeg' || t === 'image/png' || t === 'image/webp') return t;
    return 'image/jpeg';
  }

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */
  var $ = function (sel) { return document.querySelector(sel); };

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var list = $('#list');
  var emptyHint = $('#emptyHint');
  var controls = $('#controls');
  var summary = $('#summary');
  var qualityGlobal = $('#qualityGlobal');
  var qualityGlobalOut = $('#qualityGlobalOut');
  var formatGlobal = $('#formatGlobal');
  var maxDimInput = $('#maxDim');

  var entries = [];          // 表示順の管理
  var uid = 0;
  var queue = [];
  var running = false;

  if (!hasWebp) {
    // WebP エンコード非対応ブラウザでは選択肢を隠す
    Array.prototype.forEach.call(document.querySelectorAll('option[value="image/webp"]'), function (op) {
      op.remove();
    });
  }

  /* ---------- ファイル追加 ---------- */
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    files.forEach(function (file) { addFile(file); });
    syncChrome();
  }

  function addFile(file) {
    var entry = {
      id: ++uid,
      file: file,
      origSize: file.size,
      quality: Number(qualityGlobal.value) / 100,
      mimeChoice: formatGlobal.value,
      status: 'queued',
      outBlob: null,
      outUrl: null,
      origUrl: null,
      el: null
    };

    if (!file.type || file.type.indexOf('image/') !== 0) {
      entry.status = 'error';
      entry.unsupported = true;
      entry.error = '画像ファイルではありません（PNG / JPEG / WebP に対応）';
    }

    try { entry.origUrl = URL.createObjectURL(file); } catch (e) {}

    entry.el = buildCard(entry);
    list.appendChild(entry.el);
    entries.push(entry);

    if (entry.status === 'error') { renderCard(entry); return; }
    enqueue(entry);
  }

  /* ---------- カード生成 ---------- */
  function buildCard(entry) {
    var card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = entry.id;

    card.innerHTML = [
      '<div class="thumb"><img alt="" loading="lazy"></div>',
      '<div class="card-main">',
      '  <p class="fname"></p>',
      '  <div class="sizes">',
      '    <span class="size-before"></span>',
      '    <span class="arrow" aria-hidden="true">→</span>',
      '    <span class="size-after">—</span>',
      '    <span class="badge" hidden></span>',
      '  </div>',
      '  <div class="progress" hidden><i></i></div>',
      '  <p class="card-note"></p>',
      '</div>',
      '<div class="card-side">',
      '  <div class="control">',
      '    <label>品質</label>',
      '    <div class="range-row">',
      '      <input type="range" class="q-range" min="10" max="100" step="1">',
      '      <output class="q-out"></output>',
      '    </div>',
      '  </div>',
      '  <div class="control">',
      '    <label>出力形式</label>',
      '    <select class="q-format">',
      '      <option value="auto">元の形式を維持</option>',
      (hasWebp ? '      <option value="image/webp">WebP</option>' : ''),
      '      <option value="image/jpeg">JPEG</option>',
      '      <option value="image/png">PNG（可逆）</option>',
      '    </select>',
      '  </div>',
      '  <div class="card-actions">',
      '    <button type="button" class="btn btn-secondary btn-sm dl" disabled>ダウンロード</button>',
      '    <button type="button" class="icon-btn rm" aria-label="このファイルを削除">',
      '      <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">',
      '        <path d="M5.5 5.5l9 9m0-9l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      '      </svg>',
      '    </button>',
      '  </div>',
      '</div>'
    ].join('\n');

    var img = card.querySelector('img');
    img.src = entry.origUrl || '';
    img.alt = entry.file.name;
    card.querySelector('.fname').textContent = entry.file.name;
    card.querySelector('.size-before').textContent = formatBytes(entry.origSize);

    var qRange = card.querySelector('.q-range');
    var qOut = card.querySelector('.q-out');
    var fmt = card.querySelector('.q-format');

    qRange.value = Math.round(entry.quality * 100);
    qOut.textContent = qRange.value + '%';
    if (entry.mimeChoice && fmt.querySelector('option[value="' + entry.mimeChoice + '"]')) {
      fmt.value = entry.mimeChoice;
    } else {
      entry.mimeChoice = fmt.value;
    }

    // スライダー: ドラッグ中は表示だけ更新、離したら再圧縮
    qRange.addEventListener('input', function () {
      qOut.textContent = qRange.value + '%';
      entry.quality = Number(qRange.value) / 100;
    });
    qRange.addEventListener('change', function () {
      entry.quality = Number(qRange.value) / 100;
      requeue(entry);
    });

    fmt.addEventListener('change', function () {
      entry.mimeChoice = fmt.value;
      requeue(entry);
    });

    card.querySelector('.rm').addEventListener('click', function () { removeEntry(entry); });

    entry.ui = {
      card: card, img: img, qRange: qRange, qOut: qOut, fmt: fmt,
      after: card.querySelector('.size-after'),
      badge: card.querySelector('.badge'),
      note: card.querySelector('.card-note'),
      progress: card.querySelector('.progress'),
      dl: card.querySelector('.dl')
    };

    entry.ui.dl.addEventListener('click', function () { downloadEntry(entry); });

    return card;
  }

  /* ---------- キュー処理（同時実行を1件に絞る） ---------- */
  function enqueue(entry) {
    entry.status = 'queued';
    queue.push(entry);
    renderCard(entry);
    pump();
  }

  function requeue(entry) {
    if (entry.unsupported) return;
    if (!entry.outBlob && entry.status === 'queued') return;   // すでに待機中
    releaseOutput(entry);
    enqueue(entry);
  }

  function pump() {
    if (running) return;
    var entry = queue.shift();
    if (!entry) {
      syncChrome();
      return;
    }
    if (entries.indexOf(entry) === -1) { pump(); return; }   // 待機中に削除された
    running = true;

    entry.status = 'working';
    renderCard(entry);

    var mime = resolveMime(entry.mimeChoice, entry.file);
    var maxDim = Math.max(0, parseInt(maxDimInput.value, 10) || 0);

    compress(entry.file, { quality: entry.quality, mime: mime, maxDim: maxDim })
      .then(function (res) {
        if (entries.indexOf(entry) === -1) return;   // 処理中に削除された
        releaseOutput(entry);
        entry.outBlob = res.blob;
        entry.outMime = res.blob.type || mime;
        entry.outWidth = res.width;
        entry.outHeight = res.height;
        entry.outUrl = URL.createObjectURL(res.blob);
        entry.status = 'done';
        entry.error = null;
        entry.ui.img.src = entry.outUrl;             // プレビューは圧縮後の画像
        renderCard(entry);
      })
      .catch(function (err) {
        if (entries.indexOf(entry) === -1) return;
        entry.status = 'error';
        entry.error = (err && err.message) ? err.message : '圧縮に失敗しました';
        renderCard(entry);
      })
      .then(function () {
        running = false;
        pump();
      });
  }

  /* ---------- 表示更新 ---------- */
  function renderCard(entry) {
    var ui = entry.ui;
    if (!ui) return;

    var effectiveMime = resolveMime(entry.mimeChoice, entry.file);
    var lossless = effectiveMime === 'image/png';
    ui.qRange.disabled = lossless;
    if (lossless) {
      ui.qOut.textContent = '—';
      ui.qRange.title = 'PNGは可逆圧縮のため品質設定は反映されません';
    } else {
      ui.qOut.textContent = ui.qRange.value + '%';
      ui.qRange.title = '';
    }

    if (entry.status === 'working' || entry.status === 'queued') {
      ui.progress.hidden = false;
      ui.after.textContent = '—';
      ui.badge.hidden = true;
      ui.dl.disabled = true;
      ui.note.className = 'card-note';
      ui.note.textContent = entry.status === 'working' ? '圧縮中…（ブラウザ内で処理しています）' : '待機中…';
      return;
    }

    ui.progress.hidden = true;

    if (entry.status === 'error') {
      ui.note.className = 'card-note err';
      ui.note.textContent = entry.error || '圧縮に失敗しました';
      ui.after.textContent = '—';
      ui.badge.hidden = true;
      ui.dl.disabled = true;
      ui.card.classList.add('is-error');
      if (entry.unsupported) {          // 画像以外は設定を触れないようにする
        ui.qRange.disabled = true;
        ui.fmt.disabled = true;
        ui.img.hidden = true;
      }
      return;
    }

    ui.card.classList.remove('is-error');
    ui.after.textContent = formatBytes(entry.outBlob.size);

    var diff = entry.origSize - entry.outBlob.size;
    var pct = entry.origSize > 0 ? Math.round((diff / entry.origSize) * 100) : 0;
    ui.badge.hidden = false;
    ui.badge.className = 'badge' + (pct < 0 ? ' neg' : '');
    ui.badge.textContent = pct >= 0 ? '−' + pct + '%' : '+' + Math.abs(pct) + '%';

    var dims = (entry.outWidth && entry.outHeight)
      ? entry.outWidth + '×' + entry.outHeight + ' px'
      : '';
    ui.note.className = 'card-note';
    ui.note.textContent = [dims, extFor(entry.outMime).replace('.', '').toUpperCase(), 'ブラウザ内で処理済み']
      .filter(Boolean).join(' · ');

    ui.dl.disabled = false;
  }

  function releaseOutput(entry) {
    if (entry.outUrl) { URL.revokeObjectURL(entry.outUrl); entry.outUrl = null; }
    entry.outBlob = null;
  }

  function removeEntry(entry) {
    var i = entries.indexOf(entry);
    if (i !== -1) entries.splice(i, 1);
    queue = queue.filter(function (e) { return e !== entry; });
    releaseOutput(entry);
    if (entry.origUrl) URL.revokeObjectURL(entry.origUrl);
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    syncChrome();
  }

  function clearAll() {
    entries.slice().forEach(removeEntry);
    syncChrome();
  }

  /* ---------- 集計・ヘッダー制御 ---------- */
  function syncChrome() {
    var has = entries.length > 0;
    controls.hidden = !has;
    summary.hidden = !has;
    emptyHint.hidden = has;

    var count = 0, before = 0, after = 0;
    entries.forEach(function (e) {
      if (e.status === 'done' && e.outBlob) {
        count++; before += e.origSize; after += e.outBlob.size;
      }
    });
    $('#sumCount').textContent = String(entries.length);
    $('#sumBefore').textContent = formatBytes(before);
    $('#sumAfter').textContent = formatBytes(after);
    var saved = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
    var el = $('#sumSaved');
    el.textContent = saved + '%';
    el.classList.toggle('ok', saved > 0);

    $('#downloadAll').disabled = count === 0;
  }

  /* ---------- ダウンロード ---------- */
  function downloadEntry(entry) {
    if (!entry.outBlob || !entry.outUrl) return;
    var a = document.createElement('a');
    a.href = entry.outUrl;
    a.download = baseName(entry.file.name) + '-compressed' + extFor(entry.outMime || entry.file.type);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function downloadAll() {
    var done = entries.filter(function (e) { return e.status === 'done' && e.outBlob; });
    done.forEach(function (e, i) {
      setTimeout(function () { downloadEntry(e); }, i * 350);
    });
  }

  /* ---------------------------------------------------------
     イベント
     --------------------------------------------------------- */
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    dropzone.addEventListener(t, function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'dragend'].forEach(function (t) {
    dropzone.addEventListener(t, function (ev) {
      ev.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });
  dropzone.addEventListener('drop', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    dropzone.classList.remove('is-dragover');
    if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
  });

  // ページ全体へのドロップでブラウザが画像を開いてしまうのを防ぐ
  ['dragover', 'drop'].forEach(function (t) {
    window.addEventListener(t, function (ev) { ev.preventDefault(); });
  });

  // クリップボードからの貼り付け
  document.addEventListener('paste', function (ev) {
    if (!ev.clipboardData || !ev.clipboardData.files) return;
    var files = Array.prototype.filter.call(ev.clipboardData.files, function (f) {
      return f.type && f.type.indexOf('image/') === 0;
    });
    if (files.length) addFiles(files);
  });

  // 一括設定
  qualityGlobal.addEventListener('input', function () {
    qualityGlobalOut.textContent = qualityGlobal.value + '%';
  });
  qualityGlobal.addEventListener('change', function () {
    var q = Number(qualityGlobal.value) / 100;
    entries.forEach(function (e) {
      e.quality = q;
      if (e.ui) {
        e.ui.qRange.value = qualityGlobal.value;
        if (!e.ui.qRange.disabled) e.ui.qOut.textContent = qualityGlobal.value + '%';
      }
      if (e.file.type && e.file.type.indexOf('image/') === 0) requeue(e);
    });
  });

  formatGlobal.addEventListener('change', function () {
    var v = formatGlobal.value;
    entries.forEach(function (e) {
      e.mimeChoice = v;
      if (e.ui) e.ui.fmt.value = v;
      if (e.file.type && e.file.type.indexOf('image/') === 0) requeue(e);
    });
  });

  var maxDimTimer = null;
  maxDimInput.addEventListener('input', function () {
    clearTimeout(maxDimTimer);
    maxDimTimer = setTimeout(function () {
      entries.forEach(function (e) {
        if (e.file.type && e.file.type.indexOf('image/') === 0) requeue(e);
      });
    }, 600);
  });

  $('#downloadAll').addEventListener('click', downloadAll);
  $('#clearAll').addEventListener('click', clearAll);

  window.addEventListener('beforeunload', function () {
    entries.forEach(function (e) {
      if (e.outUrl) URL.revokeObjectURL(e.outUrl);
      if (e.origUrl) URL.revokeObjectURL(e.origUrl);
    });
  });

  /* ---------- 初期化 ---------- */
  (function init() {
    var y = $('#year');
    if (y) y.textContent = String(new Date().getFullYear());
    qualityGlobalOut.textContent = qualityGlobal.value + '%';
    if (!hasWebp) formatGlobal.value = 'auto';
    syncChrome();
  })();

})();
