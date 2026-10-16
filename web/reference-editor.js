// Attachment tools live in this dialog; the message composer only shows thumbnails.
export function createReferenceEditor({ imageSource, upload, downloadLink, onComments, onReplace, onSend, onGenerate, onAdvanced, onClose, onStateChange, transform, notify: notifyUser }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#reference-dialog'), viewport = $('#reference-viewport'), surface = $('#reference-surface');
  const canvas = $('#reference-drawing'), ctx = canvas.getContext('2d');
  const form = $('#reference-comment-form'), text = $('#reference-comment-text');
  const resizeMenu = $('#reference-resize-menu'), resizeButton = $('[data-reference-tool="resize"]');
  const ratios = { '1:1': [1, 1], '3:4': [3, 4], '9:16': [9, 16], '4:3': [4, 3], '16:9': [16, 9] };
  let reference, image, readOnly = false, tool = '', comments = [], pending = null;
  let strokes = [], drawing = null, operation = null, loading = false, ticket = 0;
  let docked = false, closed = true, externalBusy = false, advancedActive = false;
  const isBusy = () => loading || externalBusy;
  const copyComments = value => (value || []).map(comment => ({ ...comment }));
  const notify = message => { status(message); notifyUser(message); };
  const icon = name => $(`#reference-icon-${name}`).content.cloneNode(true);
  dialog.querySelectorAll('[data-reference-icon]').forEach(node => {
    node.append(icon(node.dataset.referenceIcon));
    if (node.classList.contains('ratio-icon')) node.querySelector('svg').setAttribute('preserveAspectRatio', 'none');
  });
  function status(message) { $('#reference-editor-status').textContent = message; }
  function commentDirty() { return pending && text.value.trim() !== (pending.index < 0 ? '' : comments[pending.index].text); }
  function positionComment() {
    if (!pending || form.hidden) return;
    const rect = surface.getBoundingClientRect(), x = rect.left + pending.x * rect.width, y = rect.top + pending.y * rect.height;
    const bounds = dialog.getBoundingClientRect(), minLeft = bounds.left + 16, maxRight = bounds.right - 16;
    const width = Math.min(340, bounds.width - 32); form.style.width = `${width}px`;
    const rightFits = x + 24 + width <= maxRight, leftFits = x - width - 24 >= minLeft;
    const left = rightFits ? x + 24 : leftFits ? x - width - 24 : x - width / 2;
    const safeBottom = viewport.getBoundingClientRect().bottom - 8;
    const top = rightFits || leftFits ? y - 20 : y + 28 + form.offsetHeight <= safeBottom ? y + 28 : y - form.offsetHeight - 28;
    form.style.left = `${Math.max(minLeft, Math.min(left, maxRight - width)) - (docked ? bounds.left : 0)}px`;
    form.style.top = `${Math.max(64, Math.min(top, innerHeight - form.offsetHeight - 20))}px`;
  }
  function layout() {
    if (!image || !dialog.open) return;
    const fit = Math.min(1, Math.max(32, viewport.clientWidth - 64) / image.naturalWidth, Math.max(32, viewport.clientHeight - 48) / image.naturalHeight);
    const zoom = $('#reference-zoom').value === 'fit' ? fit : Number($('#reference-zoom').value);
    surface.style.width = `${image.naturalWidth * zoom}px`; surface.style.height = `${image.naturalHeight * zoom}px`;
    positionComment(); positionResizeMenu();
  }
  function positionResizeMenu() {
    if (resizeMenu.hidden) return;
    const anchor = resizeButton.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
    resizeMenu.style.left = `${Math.max(bounds.left + 12, Math.min(anchor.right - resizeMenu.offsetWidth, bounds.right - resizeMenu.offsetWidth - 12)) - (docked ? bounds.left : 0)}px`;
    resizeMenu.style.top = `${Math.max(68, anchor.top - resizeMenu.offsetHeight - 8)}px`;
  }
  function drawStrokes(context, width, height, list, color) {
    for (const stroke of list) {
      context.strokeStyle = context.fillStyle = color || stroke.color;
      context.lineWidth = stroke.width * width; context.lineCap = context.lineJoin = 'round';
      context.beginPath();
      stroke.points.forEach((point, index) => context[index ? 'lineTo' : 'moveTo'](point.x * width, point.y * height));
      context.stroke();
      if (stroke.points.length === 1) { const point = stroke.points[0]; context.beginPath(); context.arc(point.x * width, point.y * height, context.lineWidth / 2, 0, Math.PI * 2); context.fill(); }
    }
  }
  function paint() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = tool === 'erase' ? .5 : 1;
    drawStrokes(ctx, canvas.width, canvas.height, strokes, tool === 'erase' ? '#8b5cf6' : null);
    ctx.globalAlpha = 1;
    $('#reference-undo').disabled = $('#reference-clear').disabled = !strokes.length || isBusy();
    $('#reference-apply-drawing').disabled = !strokes.length || isBusy();
  }
  function renderPins() {
    const pins = $('#reference-pins'); pins.replaceChildren();
    const points = pending?.index === -1 ? [...comments, pending] : comments;
    points.forEach((comment, index) => {
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'reference-pin'; pin.textContent = index + 1;
      pin.style.left = `${comment.x * 100}%`; pin.style.top = `${comment.y * 100}%`;
      pin.setAttribute('aria-label', `评论 ${index + 1}${comment.text ? `：${comment.text}` : ''}`); pin.title = comment.text || '新评论';
      pin.disabled = isBusy() || advancedActive; pin.onclick = event => { event.stopPropagation(); openComment(index < comments.length ? index : -1, comment); };
      pins.append(pin);
    });
    $('#reference-comment-count').textContent = `${comments.length} 条评论`;
    $('#reference-send-comments').disabled = !comments.length || isBusy();
  }
  function resetComment() { pending = null; form.hidden = true; text.value = ''; renderPins(); onStateChange?.(); }
  function saveComment() {
    if (!pending || readOnly) return true;
    if (isBusy()) return false;
    const value = text.value.trim();
    if (!value) { text.focus(); return false; }
    if (value.length > 300) { notify('每条评论最多 300 字。'); return false; }
    const next = copyComments(comments), comment = { x: pending.x, y: pending.y, text: value };
    if (pending.index < 0) { if (next.length >= 20) { notify('每张参考图最多添加 20 条评论。'); return false; } next.push(comment); }
    else next[pending.index] = comment;
    try { onComments(reference, next); } catch (error) { notify(error.message); return false; }
    comments = next; delete reference.resizeSource; resetComment(); status('评论已保存，可继续点击图片添加。'); return true;
  }
  function openComment(index, point = comments[index]) {
    if (isBusy()) return;
    if (commentDirty()) { notify('请先保存或取消当前评论。'); text.focus(); return; }
    if (!readOnly && tool !== 'comment' && !setTool('comment')) return;
    pending = { x: point.x, y: point.y, index };
    text.value = index < 0 ? '' : comments[index].text; text.readOnly = readOnly;
    $('#reference-comment-save').hidden = readOnly;
    $('#reference-comment-delete').hidden = readOnly || index < 0;
    $('#reference-comment-cancel').textContent = readOnly ? '关闭' : '取消';
    form.hidden = false; resizeComment(); renderPins(); positionComment(); text.focus();
  }
  function setTool(next) {
    if (isBusy() || readOnly || advancedActive) return false;
    if (commentDirty()) { notify('请先保存或取消当前评论。'); text.focus(); return false; }
    if (strokes.length && next !== tool) { notify('请先保存标注、应用擦除或清空选区。'); return false; }
    resetComment(); tool = next; surface.dataset.tool = tool;
    dialog.querySelectorAll('[data-reference-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.referenceTool === tool)));
    $('#reference-draw-options').hidden = !['annotate', 'erase'].includes(tool);
    $('#reference-color-control').hidden = tool === 'erase';
    $('#reference-apply-drawing').textContent = tool === 'erase' ? '擦除选区' : '保存标注';
    resizeMenu.hidden = tool !== 'resize'; resizeButton.setAttribute('aria-expanded', String(tool === 'resize'));
    $('#reference-comment-summary').hidden = tool !== 'comment';
    $('#reference-tools').hidden = tool === 'comment';
    status({annotate:'在图片上绘制标注，保存后作为参考图发送。',comment:'点击图片添加评论，Enter 保存，Shift + Enter 换行。',erase:'涂抹要移除的物体，再点击「擦除选区」。'}[tool] || '');
    paint(); layout();
    if (tool === 'resize') {
      resizeMenu.querySelectorAll('[data-reference-ratio]').forEach(button => {
        const [width, height] = ratios[button.dataset.referenceRatio];
        button.setAttribute('aria-checked', String(image.naturalWidth * height === image.naturalHeight * width));
      });
      (resizeMenu.querySelector('[aria-checked="true"]') || resizeMenu.querySelector('button')).focus();
    }
    return true;
  }
  async function loadAsset() {
    const currentTicket = ++ticket;
    const loaded = new Image(); loaded.src = await imageSource(reference.asset.url); await loaded.decode();
    if (currentTicket !== ticket || !dialog.open) return false;
    image = loaded; $('#reference-image').src = loaded.src; $('#reference-image').alt = reference.asset.name || '参考图片';
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    $('#reference-name').textContent = reference.asset.name;
    const link = downloadLink(reference.asset); link.replaceChildren(icon('download')); link.className = 'composer-icon'; link.setAttribute('aria-label', '下载参考图片'); link.title = '下载图片';
    $('#reference-download').replaceChildren(link); layout(); paint(); return true;
  }
  function setLoading(value) {
    loading = value; syncControls(); onStateChange?.();
  }
  function syncControls() {
    dialog.setAttribute('aria-busy', String(isBusy()));
    dialog.querySelectorAll('[data-reference-tool], #reference-draw-options input, #reference-resize-menu button, #reference-comment-save, #reference-comment-delete').forEach(control => { control.disabled = isBusy() || advancedActive; });
    $('#reference-cancel-operation').hidden = !operation; renderPins(); paint();
  }
  async function runOperation(message, execute, mapComments) {
    if (isBusy()) return;
    operation = new AbortController(); const controller = operation;
    setLoading(true); status(message);
    try {
      const asset = await execute(controller.signal);
      if (controller.signal.aborted || !dialog.open) return;
      onReplace(reference, asset, mapComments?.(comments)); comments = copyComments(reference.comments); strokes = []; drawing = null;
      if (!mapComments) delete reference.resizeSource;
      await loadAsset();
      if (!dialog.open) return;
      setLoading(false); setTool(''); status('图片已更新，可关闭后继续输入需求。');
    } catch (error) { status(controller.signal.aborted ? '已取消，保留原图。' : error.message || '图片处理失败，请重试。'); }
    finally { if (operation === controller) { operation = null; setLoading(false); } }
  }
  async function pngBlob(output) {
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片导出失败，请重试。'); return blob;
  }
  const point = event => { const rect = surface.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
  canvas.addEventListener('pointerdown', event => {
    if (readOnly || isBusy() || event.button !== 0 || !image) return;
    if (tool === 'comment') { if (comments.length >= 20) { notify('每张参考图最多添加 20 条评论。'); return; } openComment(-1, point(event)); return; }
    if (!['annotate', 'erase'].includes(tool)) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    drawing = { color: $('#reference-color').value, width: Number($('#reference-brush').value) / surface.getBoundingClientRect().width, points: [point(event)] };
    strokes.push(drawing); paint(); onStateChange?.();
  });
  canvas.addEventListener('pointermove', event => { if (!drawing || loading) return; drawing.points.push(point(event)); paint(); });
  const finishStroke = () => { drawing = null; };
  canvas.addEventListener('pointerup', finishStroke); canvas.addEventListener('pointercancel', finishStroke);
  $('#reference-undo').onclick = () => { strokes.pop(); paint(); onStateChange?.(); };
  $('#reference-clear').onclick = () => { strokes = []; paint(); onStateChange?.(); };
  $('#reference-apply-drawing').onclick = () => {
    if (!strokes.length || isBusy()) return;
    const mode = tool;
    void runOperation(mode === 'erase' ? '正在擦除选区…' : '正在保存标注…', async signal => {
      const output = document.createElement('canvas'); output.width = image.naturalWidth; output.height = image.naturalHeight;
      const context = output.getContext('2d');
      if (mode === 'erase') {
        context.fillStyle = '#000'; context.fillRect(0, 0, output.width, output.height); context.globalCompositeOperation = 'destination-out';
        drawStrokes(context, output.width, output.height, strokes, '#000');
        const mask = await upload(await pngBlob(output), '擦除选区.png', true);
        signal.throwIfAborted();
        return transform(reference, { prompt: '移除蒙版区域中的物体，根据周围画面自然补全，保持未选中的区域不变。', edit: { type: 'inpaint', sourceId: reference.assetId, maskId: mask.id }, signal });
      }
      context.drawImage(image, 0, 0); drawStrokes(context, output.width, output.height, strokes);
      return upload(await pngBlob(output), '标注参考图.png');
    });
  };
  resizeMenu.querySelectorAll('[data-reference-ratio]').forEach(button => { button.onclick = () => {
    if (isBusy() || readOnly || !image) return;
    const ratio = button.dataset.referenceRatio, [ratioWidth, ratioHeight] = ratios[ratio];
    // Reuse the original within this draft so trying ratios does not accumulate borders.
    reference.resizeSource ||= { image, comments: copyComments(comments) };
    const original = reference.resizeSource, source = original.image, sourceWidth = source.naturalWidth, sourceHeight = source.naturalHeight;
    const unit = Math.min(Math.ceil(Math.max(sourceWidth / ratioWidth, sourceHeight / ratioHeight)), Math.floor(4096 / Math.max(ratioWidth, ratioHeight)));
    const width = ratioWidth * unit, height = ratioHeight * unit;
    // Keep the full image undistorted. Added canvas stays transparent.
    const scale = Math.min(1, width / sourceWidth, height / sourceHeight);
    const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
    const left = Math.floor((width - drawnWidth) / 2), top = Math.floor((height - drawnHeight) / 2);
    setTool('');
    if (image.naturalWidth === width && image.naturalHeight === height) { resizeButton.focus(); return; }
    void runOperation(`正在调整为 ${ratio}…`, async () => {
      const output = document.createElement('canvas'); output.width = width; output.height = height;
      const context = output.getContext('2d'); context.imageSmoothingQuality = 'high'; context.drawImage(source, left, top, drawnWidth, drawnHeight);
      return upload(await pngBlob(output), `参考图 ${ratio}.png`);
    }, () => original.comments.map(comment => ({ ...comment, x: (left + comment.x * drawnWidth) / width, y: (top + comment.y * drawnHeight) / height })));
  }; });
  resizeMenu.onkeydown = event => {
    const choices = [...resizeMenu.querySelectorAll('button')], index = choices.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      setTool(''); resizeButton.focus();
    }
  };
  dialog.addEventListener('pointerdown', event => {
    if (!resizeMenu.hidden && !resizeMenu.contains(event.target) && !resizeButton.contains(event.target)) setTool('');
  });
  async function removeBackground() {
    setLoading(true); status('正在发送…');
    try {
      await onGenerate(reference, {
        action: 'remove-background',
        prompt: '移除此图像的背景。保持所有前景主体不变且完整，边缘干净平滑。将背景设为透明。',
      });
      dismiss();
    } catch (error) { notify(error.message || '发送失败，请重试。'); }
    finally { setLoading(false); }
  }
  dialog.querySelectorAll('[data-reference-tool]').forEach(button => { button.onclick = () => {
    const next = button.dataset.referenceTool;
    if (!setTool(next === tool ? '' : next)) return;
    if (['inpaint', 'outpaint'].includes(next)) {
      advancedActive = true; viewport.hidden = true; $('#reference-advanced-slot').hidden = false; syncControls();
      onAdvanced?.(reference, next, $('#reference-advanced-slot')); return;
    }
    if (next === 'remove-background') void removeBackground();
  }; });
  form.onsubmit = event => { event.preventDefault(); saveComment(); };
  function resizeComment() { text.style.height = '28px'; text.style.height = `${Math.min(112, Math.max(28, text.scrollHeight))}px`; positionComment(); }
  text.oninput = () => { resizeComment(); onStateChange?.(); };
  text.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !readOnly) { event.preventDefault(); saveComment(); } };
  $('#reference-comment-cancel').onclick = resetComment;
  $('#reference-comment-delete').onclick = () => {
    if (!pending || pending.index < 0 || readOnly) return;
    const next = comments.filter((_, index) => index !== pending.index); onComments(reference, next); comments = next; delete reference.resizeSource; resetComment(); status('评论已删除。');
  };
  $('#reference-send-comments').onclick = () => {
    if (isBusy() || readOnly || (pending && text.value.trim() && !saveComment())) return;
    if (!comments.length) return;
    dismiss(); onSend();
  };
  $('#reference-exit-comments').onclick = () => setTool('');
  $('#reference-zoom').onchange = layout; viewport.addEventListener('scroll', positionComment);
  new ResizeObserver(layout).observe(viewport);
  window.addEventListener('resize', layout);
  function close() {
    if (!dialog.open) return true;
    if (commentDirty()) { notify('请先保存或取消当前评论。'); text.focus(); return false; }
    if (strokes.length && !operation) { notify('请先保存标注、应用擦除或清空选区。'); return false; }
    dismiss(); return true;
  }
  function finishClose() {
    if (closed) return;
    closed = true; ticket++; operation?.abort(); drawing = null;
    const wasDocked = docked; docked = false;
    dialog.classList.remove('docked'); document.body.classList.remove('editing-result');
    if (wasDocked) onClose?.();
  }
  function dismiss() { if (dialog.open) dialog.close(); finishClose(); }
  function finishAdvanced() {
    advancedActive = false; $('#reference-advanced-slot').hidden = true; viewport.hidden = false;
    tool = ''; surface.dataset.tool = ''; dialog.querySelectorAll('[data-reference-tool]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    status(''); syncControls(); layout();
  }
  $('#close-reference').onclick = close;
  $('#reference-cancel-operation').onclick = () => { operation?.abort(); status('正在取消…'); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!resizeMenu.hidden) { setTool(''); resizeButton.focus(); } else if (!form.hidden) resetComment(); else close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) finishClose(); });
  dialog.addEventListener('keydown', event => { if (docked && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); if (!resizeMenu.hidden) { setTool(''); resizeButton.focus(); } else if (!form.hidden) resetComment(); else close(); } });
  return {
    close, dismiss, finishAdvanced,
    isProcessing: () => !!operation || (dialog.open && loading),
    hasPendingChanges: () => dialog.open && (loading || advancedActive || commentDirty() || strokes.length > 0),
    setBusy(value) { if (externalBusy !== value) { externalBusy = value; syncControls(); } },
    async open(ref, options = {}) {
      if (operation) { notify('请等待图片处理结束。'); return false; }
      if (!close()) return false;
      reference = ref; image = null; readOnly = !!options.readOnly; comments = copyComments(ref.comments); strokes = []; tool = ''; pending = null;
      docked = !!options.docked; closed = false; advancedActive = false;
      dialog.classList.toggle('docked', docked); document.body.classList.toggle('editing-result', docked);
      dialog.querySelectorAll('[data-result-tool]').forEach(button => { button.hidden = !docked; });
      viewport.hidden = false; $('#reference-advanced-slot').hidden = true;
      $('#close-reference').setAttribute('aria-label', docked ? '关闭图片编辑面板' : '关闭附件编辑器');
      form.hidden = true; surface.dataset.tool = ''; $('#reference-image').removeAttribute('src'); surface.style.width = surface.style.height = '0px';
      $('#reference-tools').hidden = readOnly; $('#reference-comment-summary').hidden = $('#reference-draw-options').hidden = resizeMenu.hidden = true; resizeButton.setAttribute('aria-expanded', 'false');
      $('#reference-zoom').value = 'fit'; if (docked) dialog.show(); else dialog.showModal(); setLoading(true); status('正在加载图片…');
      const openingTicket = ticket + 1;
      try { if (await loadAsset()) { status(readOnly ? '点击编号查看图片评论。' : ''); if (!readOnly) { setLoading(false); setTool(''); } } }
      catch (error) { if (openingTicket === ticket) { notify(error.message || '图片加载失败。'); dismiss(); } }
      finally { if (openingTicket === ticket) setLoading(false); }
    },
  };
}
