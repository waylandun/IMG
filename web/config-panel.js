export function createConfigPanel({ api, onConfig, notify }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#config-dialog');
  let config, editing = null, deleting = null, saving = false, fetching = false, models = [], epoch = 0;
  const node = (tag, className, text) => { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; };
  const action = (text, callback) => { const b = node('button', 'tool-button', text); b.type = 'button'; b.onclick = callback; return b; };
  const error = message => { $('#channel-error').textContent = message || ''; $('#channel-error').hidden = !message; };
  const request = (route, method, data = {}) => api(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function controls() {
    $('#channel-fields').disabled = saving;
    $('#save-channel').disabled = saving || fetching;
    $('#fetch-channel-models').disabled = saving || fetching;
    $('#fetch-channel-models').textContent = fetching ? '正在拉取…' : '拉取模型';
    $('#channel-delete-submit').disabled = saving;
    $('#channel-delete-cancel').disabled = saving;
    $('#cancel-channel').disabled = saving;
    $('#add-channel').disabled = saving;
    $('#refresh-config').disabled = saving;
    $('#channel-list').querySelectorAll('button').forEach(b => { b.disabled = saving; });
  }
  function clearModels() {
    epoch++; fetching = false; models = [];
    $('#channel-model-search').value = '';
    $('#channel-model-list').replaceChildren();
    $('#channel-model-picker').hidden = true;
    $('#channel-model-status').textContent = '支持 OpenAI 兼容 Images API；拉取列表后请选择生图模型，也可直接填写模型 ID。';
    controls();
  }
  function overview() {
    clearModels(); editing = null; deleting = null;
    $('#channel-form').reset(); $('#channel-api-key').value = '';
    $('#channel-form').hidden = true; $('#channel-overview').hidden = false; $('#channel-delete-confirm').hidden = true;
    error('');
  }
  function edit(channel) {
    overview(); editing = channel?.id || null;
    $('#channel-overview').hidden = true; $('#channel-form').hidden = false;
    $('#channel-form-title').textContent = channel ? '编辑生图渠道' : '新增生图渠道';
    $('#channel-name').value = channel?.name || '';
    $('#channel-base-url').value = channel?.baseUrl || '';
    $('#channel-model').value = channel?.imageModel || '';
    $('#channel-api-key').required = !channel;
    $('#channel-api-key').placeholder = channel ? '留空保留已保存的密钥' : '输入 API Key';
    $('#channel-key-help').textContent = channel ? '密钥不回显；留空保留原值，输入新值将替换。' : '密钥仅保存在本机，保存后不回显。';
    $('#channel-name').focus();
  }
  function render() {
    const list = $('#channel-list'); list.replaceChildren();
    for (const channel of config.channels || []) {
      const card = node('section', 'channel-card');
      card.setAttribute('aria-label', channel.name);
      const heading = node('div', 'channel-heading'); heading.append(node('strong', '', channel.name));
      if (channel.source === 'codex') heading.append(node('span', 'channel-badge', '只读'));
      if (channel.id === config.defaultChannelId) { heading.append(node('span', 'channel-badge channel-default', '默认')); card.classList.add('is-default'); }
      card.append(heading);
      const details = node('dl', 'channel-details');
      const entries = channel.source === 'codex'
        ? [['聊天模型', channel.model], ['生图模型', channel.imageModel], ['服务提供方', channel.provider], ['API 地址', channel.baseUrl], ['凭据来源', channel.credentialSource], ['Profile', channel.profile || '默认']]
        : [['生图模型', channel.imageModel], ['API 地址', channel.baseUrl], ['API Key', '已保存 · 不回显']];
      for (const [label, value] of entries) details.append(node('dt', '', label), node('dd', '', value || '—'));
      card.append(details);
      if (!channel.ready) card.append(node('p', 'channel-help', channel.error || '配置不可用'));
      if (channel.source === 'codex' && !channel.promptReady) card.append(node('p', 'channel-help', `聊天与提示词整理不可用：${channel.promptError}`));
      const actions = node('div', 'channel-actions');
      if (channel.id !== config.defaultChannelId) actions.append(action('设为默认', () => mutate(() => request('/api/config/default-channel', 'PATCH', { channelId: channel.id }), '默认生图渠道已切换')));
      if (channel.source === 'custom') {
        actions.append(action('编辑', () => edit(channel)), action('删除', () => {
          deleting = channel.id;
          $('#channel-delete-message').textContent = `删除“${channel.name}”？${channel.id === config.defaultChannelId ? '删除后默认渠道将恢复为 Codex 扫描配置。' : ''}正在运行的任务不受影响。`;
          $('#channel-delete-confirm').hidden = false; $('#channel-delete-cancel').focus();
        }));
      }
      card.append(actions); list.append(card);
    }
    controls();
  }
  async function refresh() {
    config = await api('/api/config'); onConfig(config); render(); return config;
  }
  async function mutate(operation, message) {
    if (saving) return;
    saving = true; controls(); error('');
    try {
      await operation(); overview(); await refresh(); notify(message);
      if (!config.ready) error(config.error || '当前生图渠道不可用，请选择其他渠道。');
      if (dialog.open) $('#add-channel').focus();
    } catch (e) { error(e.message); }
    finally { saving = false; controls(); }
  }
  function filterModels() {
    const select = $('#channel-model-list'), query = $('#channel-model-search').value.trim().toLowerCase();
    select.replaceChildren();
    for (const id of models.filter(id => id.toLowerCase().includes(query))) { const option = node('option', '', id); option.value = id; select.append(option); }
    select.value = $('#channel-model').value;
  }
  $('#add-channel').onclick = () => edit();
  $('#cancel-channel').onclick = () => { overview(); $('#add-channel').focus(); };
  $('#close-config').onclick = () => dialog.close();
  dialog.addEventListener('close', overview);
  $('#refresh-config').onclick = async () => { error(''); try { await refresh(); notify('已重新读取 Codex 配置'); } catch (e) { error(e.message); } };
  $('#channel-delete-cancel').onclick = () => { deleting = null; $('#channel-delete-confirm').hidden = true; $('#add-channel').focus(); };
  $('#channel-delete-submit').onclick = () => { const id = deleting; if (id) void mutate(() => request(`/api/channels/${id}`, 'DELETE'), '渠道已删除'); };
  function saveChannel() {
    if (fetching || saving || !$('#channel-form').reportValidity()) return;
    const id = editing;
    const data = { name: $('#channel-name').value.trim(), baseUrl: $('#channel-base-url').value.trim(), apiKey: $('#channel-api-key').value, imageModel: $('#channel-model').value.trim() };
    void mutate(() => request(id ? `/api/channels/${id}` : '/api/channels', id ? 'PATCH' : 'POST', data), '渠道已保存');
  }
  // The MCP sandbox may omit allow-forms: invoke the local API directly rather
  // than depending on a native form submission (even with preventDefault).
  $('#save-channel').onclick = saveChannel;
  $('#channel-form').onsubmit = event => { event.preventDefault(); saveChannel(); };
  $('#channel-form').onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT') {
      event.preventDefault();
      if (event.target.id !== 'channel-model-search') saveChannel();
    }
  };
  $('#channel-model-search').oninput = filterModels;
  $('#channel-model-list').onchange = event => { if (event.target.value) $('#channel-model').value = event.target.value; };
  for (const id of ['channel-base-url', 'channel-api-key']) $(`#${id}`).addEventListener('input', clearModels);
  $('#fetch-channel-models').onclick = async () => {
    if (fetching || saving) return;
    if (!$('#channel-base-url').reportValidity() || !$('#channel-api-key').reportValidity()) return;
    const ticket = ++epoch;
    fetching = true; controls(); error('');
    $('#channel-model-status').textContent = '正在拉取模型列表…';
    try {
      const result = await request('/api/channels/models', 'POST', { channelId: editing || undefined, baseUrl: $('#channel-base-url').value.trim(), apiKey: $('#channel-api-key').value });
      if (ticket !== epoch) return;
      models = result.models; filterModels(); $('#channel-model-picker').hidden = !models.length;
      $('#channel-model-status').textContent = models.length ? `已拉取 ${models.length} 个模型，请选择支持生图的模型；也可手动填写。` : '模型列表为空，可手动填写模型 ID。';
    } catch (e) { if (ticket === epoch) { $('#channel-model-picker').hidden = true; $('#channel-model-status').textContent = `${e.message} 可手动填写模型 ID 后保存。`; } }
    finally { if (ticket === epoch) { fetching = false; controls(); } }
  };
  return { refresh, async open() { overview(); dialog.showModal(); try { await refresh(); } catch (e) { error(e.message); } } };
}
