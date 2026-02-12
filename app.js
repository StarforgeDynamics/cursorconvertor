/**
 * app.js — UI logic for the Cursor Converter.
 * Handles file uploads, preview, hotspot interaction, and download.
 */

(() => {
  // ─── State ──────────────────────────────────────────────────────

  const state = {
    files: [],         // Array of { file: File, img: HTMLImageElement, name: string }
    format: 'cur',     // 'cur' | 'ani'
    size: 32,
    frameRate: 10,
    hotspot: null,     // { x, y } in output-image pixel coords (null = auto)
    autoHotspot: null, // auto-detected hotspot
    animTimer: null,
    animFrame: 0,
  };

  // ─── DOM refs ─────────────────────────────────────────────────

  const $uploadArea     = document.getElementById('upload-area');
  const $fileInput      = document.getElementById('file-input');
  const $fileList       = document.getElementById('file-list');
  const $stepOptions    = document.getElementById('step-options');
  const $formatSelect   = document.getElementById('format-select');
  const $sizeSelect     = document.getElementById('size-select');
  const $aniOptions     = document.getElementById('ani-options');
  const $aniUploadArea  = document.getElementById('ani-upload-area');
  const $aniFileInput   = document.getElementById('ani-file-input');
  const $frameRate      = document.getElementById('frame-rate');
  const $frameRateValue = document.getElementById('frame-rate-value');
  const $stepPreview    = document.getElementById('step-preview');
  const $previewBox     = document.getElementById('preview-box');
  const $previewCanvas  = document.getElementById('preview-canvas');
  const $hotspotMarker  = document.getElementById('hotspot-marker');
  const $animFrames     = document.getElementById('anim-frames');
  const $testArea       = document.getElementById('test-area');
  const $stepConvert    = document.getElementById('step-convert');
  const $convertBtn     = document.getElementById('convert-btn');
  const $status         = document.getElementById('status');

  // ─── File Loading ─────────────────────────────────────────────

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${file.name}`));
      img.src = url;
    });
  }

  async function addFiles(fileListObj) {
    // In .cur mode, only keep the most recent file
    if (state.format === 'cur') state.files = [];

    const validExts = ['.png', '.jpg', '.jpeg', '.svg'];
    const newFiles = Array.from(fileListObj).filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return validExts.includes(ext);
    });

    for (const file of newFiles) {
      try {
        const img = await loadImageFile(file);
        state.files.push({ file, img, name: file.name });
      } catch (e) {
        console.warn(e.message);
      }
    }

    // In .cur mode, if multiple were somehow added, keep only the last
    if (state.format === 'cur' && state.files.length > 1) {
      state.files = [state.files[state.files.length - 1]];
    }

    state.hotspot = null; // Reset hotspot when files change
    updateUI();
  }

  function removeFile(index) {
    state.files.splice(index, 1);
    updateUI();
  }

  // ─── UI Updates ───────────────────────────────────────────────

  function updateUI() {
    const hasFiles = state.files.length > 0;

    // File chips
    renderFileChips();

    // Enable/disable steps
    $stepOptions.classList.toggle('disabled', !hasFiles);
    $stepPreview.classList.toggle('disabled', !hasFiles);

    const canConvert = state.format === 'cur'
      ? state.files.length >= 1
      : state.files.length >= 3;
    $stepConvert.classList.toggle('disabled', !canConvert);
    $convertBtn.disabled = !canConvert;

    // ANI options visibility
    $aniOptions.classList.toggle('visible', state.format === 'ani');

    // Update upload area text for ANI mode
    if (state.format === 'ani') {
      $fileInput.multiple = true;
      $uploadArea.querySelector('.formats').textContent = 'PNG, JPG, or SVG — upload multiple for animation frames';
    } else {
      $fileInput.multiple = false;
      $uploadArea.querySelector('.formats').textContent = 'PNG, JPG, or SVG';
    }

    // Button text
    $convertBtn.textContent = state.format === 'cur'
      ? 'Convert to .cur'
      : `Convert to .ani (${state.files.length} frame${state.files.length !== 1 ? 's' : ''})`;

    // Status
    if (state.format === 'ani' && state.files.length > 0 && state.files.length < 3) {
      setStatus(`Need at least 3 frames for .ani (have ${state.files.length})`, 'error');
    } else {
      setStatus('');
    }

    // Preview
    if (hasFiles) {
      updatePreview();
    }
  }

  function renderFileChips() {
    $fileList.innerHTML = '';
    state.files.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.draggable = true;
      chip.dataset.index = i;

      const num = document.createElement('span');
      num.className = 'frame-num';
      num.textContent = i + 1;

      const name = document.createElement('span');
      name.textContent = f.name;

      const remove = document.createElement('span');
      remove.className = 'remove-file';
      remove.textContent = '\u00d7';
      remove.onclick = (e) => { e.stopPropagation(); removeFile(i); };

      chip.appendChild(num);
      chip.appendChild(name);
      chip.appendChild(remove);
      $fileList.appendChild(chip);

      // Drag reorder
      chip.addEventListener('dragstart', (e) => {
        chip.classList.add('dragging');
        e.dataTransfer.setData('text/plain', i.toString());
      });
      chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      chip.addEventListener('dragover', (e) => e.preventDefault());
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to = i;
        if (from !== to) {
          const [item] = state.files.splice(from, 1);
          state.files.splice(to, 0, item);
          updateUI();
        }
      });
    });
  }

  // ─── Preview ──────────────────────────────────────────────────

  function updatePreview() {
    stopAnimation();

    if (state.files.length === 0) return;

    if (state.format === 'ani' && state.files.length > 1) {
      showAnimatedPreview();
    } else {
      showStaticPreview(state.files[0]);
    }
  }

  function showStaticPreview(fileEntry) {
    const { canvas } = CursorLib.resizeImage(fileEntry.img, state.size);

    // Detect hotspot on the resized image
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, state.size, state.size);
    state.autoHotspot = CursorLib.detectHotspot(imageData);

    const hs = state.hotspot || state.autoHotspot;

    // Draw preview at display size (scaled up for visibility)
    const displaySize = 160;
    $previewCanvas.width = displaySize;
    $previewCanvas.height = displaySize;
    const pctx = $previewCanvas.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, displaySize, displaySize);
    pctx.drawImage(canvas, 0, 0, displaySize, displaySize);

    // Position hotspot marker
    const scaleFactor = displaySize / state.size;
    positionHotspot(hs.x, hs.y, scaleFactor);

    // Set cursor on test area
    setCursorPreview(canvas, hs);

    // Clear animation frames
    $animFrames.innerHTML = '';
  }

  function showAnimatedPreview() {
    // Build frame thumbnails
    $animFrames.innerHTML = '';
    state.files.forEach((f, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'anim-frame-thumb';
      if (i === 0) thumb.classList.add('active');
      const tc = document.createElement('canvas');
      tc.width = 32;
      tc.height = 32;
      const tctx = tc.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      const { canvas } = CursorLib.resizeImage(f.img, 32);
      tctx.drawImage(canvas, 0, 0, 32, 32);
      thumb.appendChild(tc);
      $animFrames.appendChild(thumb);
    });

    // Start animation
    state.animFrame = 0;
    showAnimFrame(0);
    state.animTimer = setInterval(() => {
      state.animFrame = (state.animFrame + 1) % state.files.length;
      showAnimFrame(state.animFrame);
    }, 1000 / state.frameRate);
  }

  function showAnimFrame(index) {
    const fileEntry = state.files[index];
    if (!fileEntry) return;

    const { canvas } = CursorLib.resizeImage(fileEntry.img, state.size);

    // Detect hotspot on first frame (all frames share the same hotspot)
    if (index === 0 || !state.autoHotspot) {
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, state.size, state.size);
      state.autoHotspot = CursorLib.detectHotspot(imageData);
    }
    const hs = state.hotspot || state.autoHotspot;

    const displaySize = 160;
    $previewCanvas.width = displaySize;
    $previewCanvas.height = displaySize;
    const pctx = $previewCanvas.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, displaySize, displaySize);
    pctx.drawImage(canvas, 0, 0, displaySize, displaySize);

    const scaleFactor = displaySize / state.size;
    positionHotspot(hs.x, hs.y, scaleFactor);

    // Highlight active thumbnail
    document.querySelectorAll('.anim-frame-thumb').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });

    // Set cursor on test area (just use the current frame)
    setCursorPreview(canvas, hs);
  }

  function stopAnimation() {
    if (state.animTimer) {
      clearInterval(state.animTimer);
      state.animTimer = null;
    }
  }

  function positionHotspot(x, y, scaleFactor) {
    $hotspotMarker.style.display = 'block';
    // The preview box centers the canvas. We need to offset relative to the box.
    const boxRect = $previewBox.getBoundingClientRect();
    const canvasRect = $previewCanvas.getBoundingClientRect();
    const offsetLeft = canvasRect.left - boxRect.left;
    const offsetTop = canvasRect.top - boxRect.top;

    $hotspotMarker.style.left = (offsetLeft + x * scaleFactor - 8) + 'px';
    $hotspotMarker.style.top = (offsetTop + y * scaleFactor - 8) + 'px';
  }

  function setCursorPreview(canvas, hotspot) {
    // Create a cursor URL from the canvas
    const cursorUrl = canvas.toDataURL('image/png');
    $testArea.style.cursor = `url(${cursorUrl}) ${hotspot.x} ${hotspot.y}, auto`;
  }

  // ─── Hotspot Click Override ───────────────────────────────────

  $previewBox.addEventListener('click', (e) => {
    if (state.files.length === 0) return;

    const canvasRect = $previewCanvas.getBoundingClientRect();
    const displaySize = $previewCanvas.width;
    const scaleFactor = displaySize / state.size;

    const clickX = e.clientX - canvasRect.left;
    const clickY = e.clientY - canvasRect.top;

    // Convert display coords to image coords
    const imgX = Math.round(clickX / scaleFactor);
    const imgY = Math.round(clickY / scaleFactor);

    // Clamp
    state.hotspot = {
      x: Math.max(0, Math.min(state.size - 1, imgX)),
      y: Math.max(0, Math.min(state.size - 1, imgY)),
    };

    updatePreview();
  });

  // ─── Drag & Drop ──────────────────────────────────────────────

  function setupDragDrop(area, inputEl) {
    area.addEventListener('click', () => inputEl.click());

    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      area.classList.add('drag-over');
    });

    area.addEventListener('dragleave', () => {
      area.classList.remove('drag-over');
    });

    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('drag-over');
      addFiles(e.dataTransfer.files);
    });

    inputEl.addEventListener('change', () => {
      if (inputEl.files.length > 0) {
        addFiles(inputEl.files);
        inputEl.value = '';
      }
    });
  }

  setupDragDrop($uploadArea, $fileInput);
  setupDragDrop($aniUploadArea, $aniFileInput);

  // ─── Options Handlers ─────────────────────────────────────────

  $formatSelect.addEventListener('change', () => {
    state.format = $formatSelect.value;
    state.hotspot = null; // Reset manual hotspot on format change
    updateUI();
  });

  $sizeSelect.addEventListener('change', () => {
    state.size = parseInt($sizeSelect.value);
    state.hotspot = null; // Reset manual hotspot on size change
    updateUI();
  });

  $frameRate.addEventListener('input', () => {
    state.frameRate = parseInt($frameRate.value);
    $frameRateValue.textContent = state.frameRate + ' fps';
    // Restart animation if running
    if (state.animTimer) {
      stopAnimation();
      state.animFrame = 0;
      showAnimatedPreview();
    }
  });

  // ─── Convert & Download ───────────────────────────────────────

  $convertBtn.addEventListener('click', async () => {
    if (state.files.length === 0) return;

    try {
      $convertBtn.disabled = true;
      setStatus('Converting...', '');

      let blob, filename;

      if (state.format === 'cur') {
        // Static cursor
        const { canvas } = CursorLib.resizeImage(state.files[0].img, state.size);
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, state.size, state.size);
        const autoHs = CursorLib.detectHotspot(imageData);
        const hs = state.hotspot || autoHs;

        blob = CursorLib.buildCUR(canvas, hs.x, hs.y);
        const baseName = state.files[0].name.replace(/\.[^.]+$/, '');
        filename = baseName + '.cur';
      } else {
        // Animated cursor
        if (state.files.length < 3) {
          setStatus('Need at least 3 frames for .ani', 'error');
          $convertBtn.disabled = false;
          return;
        }

        const frames = [];
        let sharedHotspot = null;

        for (let i = 0; i < state.files.length; i++) {
          const { canvas } = CursorLib.resizeImage(state.files[i].img, state.size);

          // Use the first frame's hotspot (or manual override) for all frames
          if (i === 0) {
            const ctx = canvas.getContext('2d');
            const imageData = ctx.getImageData(0, 0, state.size, state.size);
            const autoHs = CursorLib.detectHotspot(imageData);
            sharedHotspot = state.hotspot || autoHs;
          }

          frames.push({
            canvas,
            hotspotX: sharedHotspot.x,
            hotspotY: sharedHotspot.y,
          });
        }

        blob = CursorLib.buildANI(frames, state.frameRate);
        filename = 'animated-cursor.ani';
      }

      // Auto-download
      downloadBlob(blob, filename);
      setStatus(`Downloaded ${filename}!`, 'success');
    } catch (e) {
      console.error(e);
      setStatus('Conversion failed: ' + e.message, 'error');
    } finally {
      $convertBtn.disabled = false;
    }
  });

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = 'status' + (type ? ' ' + type : '');
  }

  // ─── Init ─────────────────────────────────────────────────────

  updateUI();
})();
