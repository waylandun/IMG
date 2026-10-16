export function createEditor({ imageSource, upload, onApply, onClose, notify }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#editor-dialog'), canvas = $('#edit-canvas'), ctx = canvas.getContext('2d');
  const selection = document.createElement('canvas'), selectionCtx = selection.getContext('2d');
  const overlay = document.createElement('canvas'), overlayCtx = overlay.getContext('2d');
  const hatch = document.createElement('canvas'); hatch.width = hatch.height = 12;
  const hatchCtx = hatch.getContext('2d'); hatchCtx.fillStyle = '#fff'; hatchCtx.fillRect(0, 0, 12, 12);
  hatchCtx.strokeStyle = '#111'; hatchCtx.lineWidth = 3;
  for (const x of [-12, 0, 12]) { hatchCtx.beginPath(); hatchCtx.moveTo(x, 0); hatchCtx.lineTo(x + 12, 12); hatchCtx.stroke(); }
  let asset, image, mode, tool = 'brush', drawing = false, startPoint, lastPoint, savedSelection;
  let undo = [], selected = false, loading = false, generation = 0;
  const originalParent = dialog.parentElement;
  let opened = false;
  function finishClose() {
    if (!opened) return;
    opened = false; generation++; drawing = false;
    dialog.classList.remove('inline-editor'); originalParent.append(dialog); onClose?.();
  }
  function close() { if (dialog.open) dialog.close(); finishClose(); }
  const margins = () => Object.fromEntries([...dialog.querySelectorAll('[data-edge]')].map(input => [input.dataset.edge, Number(input.value)]));
  function dimensions() {
    const edge = margins();
    const pad = Object.fromEntries(['left', 'right', 'top', 'bottom'].map(key => [key, Math.round((key === 'left' || key === 'right' ? asset.width : asset.height) * edge[key] / 100 / 16) * 16]));
    return { ...pad, width: Math.ceil((asset.width + pad.left + pad.right) / 16) * 16, height: Math.ceil((asset.height + pad.top + pad.bottom) / 16) * 16 };
  }
  function paint() {
    if (!image) return;
    if (mode === 'outpaint') {
      const d = dimensions();
      if (!Number.isFinite(d.width + d.height) || d.width <= 0 || d.height <= 0) return;
      const scale = Math.min(1, 1200 / d.width, 800 / d.height);
      canvas.width = Math.round(d.width * scale); canvas.height = Math.round(d.height * scale);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, d.left * scale, d.top * scale, asset.width * scale, asset.height * scale);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.strokeRect(d.left * scale, d.top * scale, asset.width * scale, asset.height * scale);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.strokeRect(d.left * scale, d.top * scale, asset.width * scale, asset.height * scale); ctx.setLineDash([]);
      $('#editor-info').textContent = `原图 ${asset.width} × ${asset.height} → ${d.width} × ${d.height}`;
      const valid = Object.values(margins()).every(n => Number.isInteger(n) && n >= 0 && n <= 100) && d.width <= 3840 && d.height <= 3840 && d.width * d.height <= 8_294_400 && Math.max(d.width / d.height, d.height / d.width) <= 3 && Object.values(margins()).some(Boolean);
      $('#apply-edit').disabled = !valid || loading;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      overlay.width = canvas.width; overlay.height = canvas.height;
      overlayCtx.fillStyle = overlayCtx.createPattern(hatch, 'repeat'); overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
      overlayCtx.globalCompositeOperation = 'destination-in'; overlayCtx.drawImage(selection, 0, 0);
      ctx.save(); ctx.globalAlpha = .5; ctx.drawImage(overlay, 0, 0); ctx.restore();
      $('#editor-info').textContent = `${asset.width} × ${asset.height} · 斜纹覆盖处会重新生成`;
      $('#apply-edit').disabled = !selected || loading;
      $('#mask-undo').disabled = !undo.length;
    }
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  }
  function stroke(from, to) {
    selectionCtx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    selectionCtx.lineWidth = Number($('#brush-size').value) * canvas.width / canvas.getBoundingClientRect().width;
    selectionCtx.lineCap = 'round'; selectionCtx.strokeStyle = '#fff'; selectionCtx.fillStyle = '#fff';
    selectionCtx.beginPath(); selectionCtx.moveTo(from.x, from.y); selectionCtx.lineTo(to.x, to.y); selectionCtx.stroke();
    selectionCtx.beginPath(); selectionCtx.arc(to.x, to.y, selectionCtx.lineWidth / 2, 0, Math.PI * 2); selectionCtx.fill();
    selectionCtx.globalCompositeOperation = 'source-over';
  }
  canvas.addEventListener('pointerdown', event => {
    if (mode !== 'inpaint' || loading || !image || event.button !== 0) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId); drawing = true;
    startPoint = lastPoint = point(event);
    savedSelection = selectionCtx.getImageData(0, 0, selection.width, selection.height);
    undo.push({ pixels: savedSelection, selected }); if (undo.length > 12) undo.shift();
    if (tool !== 'rect') stroke(startPoint, startPoint);
    selected = true; paint();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const p = point(event);
    if (tool === 'rect') {
      selectionCtx.putImageData(savedSelection, 0, 0); selectionCtx.fillStyle = '#fff';
      selectionCtx.fillRect(Math.min(startPoint.x, p.x), Math.min(startPoint.y, p.y), Math.abs(p.x - startPoint.x), Math.abs(p.y - startPoint.y));
    } else stroke(lastPoint, p);
    lastPoint = p; paint();
  });
  const endStroke = () => {
    if (!drawing) return;
    drawing = false;
    const pixels = selectionCtx.getImageData(0, 0, selection.width, selection.height).data;
    selected = false;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { selected = true; break; }
    paint();
  };
  canvas.addEventListener('pointerup', endStroke); canvas.addEventListener('pointercancel', endStroke);
  for (const button of dialog.querySelectorAll('[data-tool]')) button.onclick = () => {
    tool = button.dataset.tool;
    for (const other of dialog.querySelectorAll('[data-tool]')) other.classList.toggle('selected', other === button);
  };
  $('#mask-undo').onclick = () => { const step = undo.pop(); if (!step) return; selectionCtx.putImageData(step.pixels, 0, 0); selected = step.selected; paint(); };
  $('#mask-clear').onclick = () => {
    undo.push({ pixels: selectionCtx.getImageData(0, 0, selection.width, selection.height), selected }); if (undo.length > 12) undo.shift();
    selectionCtx.clearRect(0, 0, selection.width, selection.height); selected = false; paint();
  };
  for (const input of dialog.querySelectorAll('[data-edge]')) input.oninput = paint;
  for (const button of dialog.querySelectorAll('[data-expand]')) button.onclick = () => {
    for (const input of dialog.querySelectorAll('[data-edge]')) input.value = button.dataset.expand === 'all' || (button.dataset.expand === 'horizontal' ? ['left', 'right'] : ['top', 'bottom']).includes(input.dataset.edge) ? '25' : '0';
    paint();
  };
  $('#close-editor').onclick = close;
  dialog.addEventListener('close', () => { if (!dialog.open) finishClose(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (dialog.classList.contains('inline-editor') && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  $('#apply-edit').onclick = async () => {
    loading = true; paint(); const currentGeneration = generation;
    try {
      let edit;
      if (mode === 'inpaint') {
        const full = document.createElement('canvas'); full.width = asset.width; full.height = asset.height;
        const fullCtx = full.getContext('2d'); fullCtx.fillStyle = '#000'; fullCtx.fillRect(0, 0, full.width, full.height);
        fullCtx.globalCompositeOperation = 'destination-out'; fullCtx.drawImage(selection, 0, 0, full.width, full.height);
        const blob = await new Promise(resolve => full.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('选区导出失败，请重新绘制。');
        const mask = await upload(blob, '局部重绘选区.png', true);
        edit = { type: 'inpaint', maskId: mask.id, sourceId: asset.id };
      } else edit = { type: 'outpaint', margins: margins(), sourceId: asset.id };
      if (currentGeneration !== generation) return;
      onApply(edit); close();
    } catch (error) { notify(error.message); }
    finally { loading = false; paint(); }
  };
  return {
    close,
    async open(source, type, { container } = {}) {
      close();
      const ticket = ++generation; loading = true; image = null; asset = source; mode = type; undo = []; selected = false;
      tool = 'brush';
      dialog.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('selected', button.dataset.tool === tool));
      dialog.querySelectorAll('[data-edge]').forEach(input => { input.value = ['left', 'right'].includes(input.dataset.edge) ? '25' : '0'; });
      if (container) { container.append(dialog); dialog.classList.add('inline-editor'); }
      $('#editor-title').textContent = mode === 'inpaint' ? '局部重绘' : '扩展画布';
      $('#editor-description').textContent = mode === 'inpaint' ? '涂抹或框选想改变的部分，应用后输入修改要求。未选中的区域会保留原图。' : '设置四周扩展比例，透明区域由 AI 补全，原图内容保持不变。';
      $('#mask-tools').hidden = mode !== 'inpaint'; $('#outpaint-tools').hidden = mode !== 'outpaint';
      $('#apply-edit').textContent = mode === 'inpaint' ? '应用选区' : '应用扩图'; $('#apply-edit').disabled = true;
      $('#editor-info').textContent = '正在加载原图…'; ctx.clearRect(0, 0, canvas.width, canvas.height); opened = true;
      if (container) dialog.show(); else dialog.showModal();
      try {
        const loaded = new Image(); loaded.src = await imageSource(asset.url); await loaded.decode();
        if (ticket !== generation) return;
        image = loaded;
        if (mode === 'inpaint') {
          const scale = Math.min(1, 1600 / Math.max(asset.width, asset.height));
          canvas.width = selection.width = Math.round(asset.width * scale); canvas.height = selection.height = Math.round(asset.height * scale);
        }
      } catch (error) { if (ticket === generation) { notify(error.message || '图片加载失败'); close(); } }
      finally { if (ticket === generation) { loading = false; paint(); } }
    },
  };
}
