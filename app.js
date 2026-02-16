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
    bgRemoval: true,   // background removal enabled
    uploadMode: 'individual', // 'individual' | 'spritesheet'
    spriteSheet: null,        // { img, canvas } — loaded sprite sheet
    spriteCols: 1,
    spriteRows: 1,
  };

  // ─── DOM refs ─────────────────────────────────────────────────

  const $uploadArea      = document.getElementById('upload-area');
  const $fileInput       = document.getElementById('file-input');
  const $fileList        = document.getElementById('file-list');
  const $stepOptions     = document.getElementById('step-options');
  const $formatSelect    = document.getElementById('format-select');
  const $sizeSelect      = document.getElementById('size-select');
  const $aniOptions      = document.getElementById('ani-options');
  const $aniUploadArea   = document.getElementById('ani-upload-area');
  const $aniFileInput    = document.getElementById('ani-file-input');
  const $frameRate       = document.getElementById('frame-rate');
  const $frameRateValue  = document.getElementById('frame-rate-value');
  const $stepPreview     = document.getElementById('step-preview');
  const $previewBox      = document.getElementById('preview-box');
  const $previewCanvas   = document.getElementById('preview-canvas');
  const $hotspotMarker   = document.getElementById('hotspot-marker');
  const $animFrames      = document.getElementById('anim-frames');
  const $testArea        = document.getElementById('test-area');
  const $stepConvert     = document.getElementById('step-convert');
  const $convertBtn      = document.getElementById('convert-btn');
  const $status          = document.getElementById('status');
  const $bgRemoveToggle  = document.getElementById('bg-remove-toggle');
  const $processingOverlay = document.getElementById('processing-overlay');
  const $processingText  = document.getElementById('processing-text');

  // Sprite sheet DOM refs
  const $uploadModeTabs    = document.getElementById('upload-mode-tabs');
  const $individualMode    = document.getElementById('individual-mode');
  const $spriteMode        = document.getElementById('sprite-mode');
  const $spriteUploadArea  = document.getElementById('sprite-upload-area');
  const $spriteFileInput   = document.getElementById('sprite-file-input');
  const $spriteConfigPanel = document.getElementById('sprite-config-panel');
  const $spriteCols        = document.getElementById('sprite-cols');
  const $spriteRows        = document.getElementById('sprite-rows');
  const $spriteFrameCount  = document.getElementById('sprite-frame-count');
  const $spriteOverlay     = document.getElementById('sprite-overlay-canvas');
  const $useFramesBtn      = document.getElementById('use-frames-btn');

  // ─── Background Removal ─────────────────────────────────────

  let bgRemovalModule = null;

  async function loadBgRemovalLib() {
    if (!bgRemovalModule) {
      showProcessing(true, 'Loading background removal model...');
      bgRemovalModule = await import(
        'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm'
      );
    }
    return bgRemovalModule;
  }

  async function processBackgroundRemoval(file) {
    const lib = await loadBgRemovalLib();
    const resultBlob = await lib.default(file, {
      model: 'small',
      output: { format: 'image/png' },
    });
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(resultBlob);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load processed image'));
      img.src = url;
    });
  }

  function showProcessing(visible, text) {
    $processingOverlay.classList.toggle('visible', visible);
    if (text) $processingText.textContent = text;
  }

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

    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i];
      try {
        let img;
        if (state.bgRemoval) {
          showProcessing(true,
            newFiles.length > 1
              ? `Removing background (${i + 1}/${newFiles.length})...`
              : 'Removing background...'
          );
          img = await processBackgroundRemoval(file);
        } else {
          img = await loadImageFile(file);
        }
        state.files.push({ file, img, name: file.name });
      } catch (e) {
        console.warn(e.message);
        // Fall back to loading without bg removal if it fails
        try {
          const img = await loadImageFile(file);
          state.files.push({ file, img, name: file.name });
        } catch (e2) {
          console.warn('Skipping file:', e2.message);
        }
      }
    }

    showProcessing(false);

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

  // ─── Sprite Sheet ─────────────────────────────────────────────

  async function loadSpriteSheet(file) {
    const img = await loadImageFile(file);

    // Draw to canvas for analysis
    const canvas = document.createElement('canvas');
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    state.spriteSheet = { img, canvas, name: file.name };

    // Auto-detect grid
    const detected = CursorLib.detectSpriteGrid(canvas);
    state.spriteCols = detected.cols;
    state.spriteRows = detected.rows;
    $spriteCols.value = detected.cols;
    $spriteRows.value = detected.rows;

    $spriteConfigPanel.style.display = 'block';
    updateSpriteOverlay();
  }

  function updateSpriteOverlay() {
    if (!state.spriteSheet) return;

    const { canvas: src } = state.spriteSheet;
    const cols = state.spriteCols;
    const rows = state.spriteRows;
    const w = src.width;
    const h = src.height;
    const frameW = Math.floor(w / cols);
    const frameH = Math.floor(h / rows);

    // Draw the sprite sheet with grid overlay
    $spriteOverlay.width = w;
    $spriteOverlay.height = h;
    const ctx = $spriteOverlay.getContext('2d');
    ctx.drawImage(src, 0, 0);

    // Draw grid lines
    ctx.strokeStyle = 'rgba(124, 92, 191, 0.7)';
    ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 300));

    for (let c = 1; c < cols; c++) {
      const x = c * frameW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const y = r * frameH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Draw frame numbers
    const fontSize = Math.max(10, Math.min(frameW, frameH) / 4);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Count non-empty frames for the label
    const frames = CursorLib.extractFrames(src, cols, rows);
    let frameIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = c * frameW + frameW / 2;
        const cy = r * frameH + frameH / 2;
        // Check if this grid cell produced a frame (non-empty)
        const cellCanvas = document.createElement('canvas');
        cellCanvas.width = frameW;
        cellCanvas.height = frameH;
        const cellCtx = cellCanvas.getContext('2d');
        cellCtx.drawImage(src, c * frameW, r * frameH, frameW, frameH, 0, 0, frameW, frameH);
        const cellData = cellCtx.getImageData(0, 0, frameW, frameH).data;
        let hasContent = false;
        for (let i = 3; i < cellData.length; i += 4) {
          if (cellData[i] > 10) { hasContent = true; break; }
        }
        if (hasContent) {
          frameIdx++;
          // Draw number badge
          ctx.fillStyle = 'rgba(124, 92, 191, 0.8)';
          const badgeR = fontSize * 0.8;
          ctx.beginPath();
          ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(frameIdx, cx, cy);
        }
      }
    }

    $spriteFrameCount.textContent = `${frames.length} frame${frames.length !== 1 ? 's' : ''} detected`;
    $useFramesBtn.disabled = frames.length < 3;
    if (frames.length < 3) {
      $spriteFrameCount.textContent += ' (need 3+)';
    }
  }

  function useSpriteFrames() {
    if (!state.spriteSheet) return;

    const frames = CursorLib.extractFrames(
      state.spriteSheet.canvas,
      state.spriteCols,
      state.spriteRows
    );

    if (frames.length < 3) return;

    // Convert frame canvases into the same format as uploaded files
    state.files = frames.map((fc, i) => {
      // Create an img element from the frame canvas
      const img = new Image();
      img.src = fc.toDataURL('image/png');
      img.width = fc.width;
      img.height = fc.height;
      return {
        file: null,
        img,
        name: `${state.spriteSheet.name} #${i + 1}`,
      };
    });

    state.hotspot = null;
    updateUI();
  }

  // Sprite sheet upload handling
  function setupSpriteUpload() {
    $spriteUploadArea.addEventListener('click', () => $spriteFileInput.click());

    $spriteUploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      $spriteUploadArea.classList.add('drag-over');
    });
    $spriteUploadArea.addEventListener('dragleave', () => {
      $spriteUploadArea.classList.remove('drag-over');
    });
    $spriteUploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      $spriteUploadArea.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        loadSpriteSheet(e.dataTransfer.files[0]);
      }
    });

    $spriteFileInput.addEventListener('change', () => {
      if ($spriteFileInput.files.length > 0) {
        loadSpriteSheet($spriteFileInput.files[0]);
        $spriteFileInput.value = '';
      }
    });

    $spriteCols.addEventListener('change', () => {
      state.spriteCols = Math.max(1, parseInt($spriteCols.value) || 1);
      $spriteCols.value = state.spriteCols;
      updateSpriteOverlay();
    });

    $spriteRows.addEventListener('change', () => {
      state.spriteRows = Math.max(1, parseInt($spriteRows.value) || 1);
      $spriteRows.value = state.spriteRows;
      updateSpriteOverlay();
    });

    $useFramesBtn.addEventListener('click', useSpriteFrames);
  }

  setupSpriteUpload();

  // Upload mode tabs
  document.querySelectorAll('.upload-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.uploadMode = tab.dataset.mode;
      document.querySelectorAll('.upload-mode-tab').forEach(t =>
        t.classList.toggle('active', t === tab)
      );
      $individualMode.style.display = state.uploadMode === 'individual' ? 'block' : 'none';
      $spriteMode.classList.toggle('visible', state.uploadMode === 'spritesheet');
    });
  });

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

    // Upload mode tabs visibility (only in .ani mode)
    $uploadModeTabs.classList.toggle('visible', state.format === 'ani');

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

  $bgRemoveToggle.addEventListener('change', () => {
    state.bgRemoval = $bgRemoveToggle.checked;
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
