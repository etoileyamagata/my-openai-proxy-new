(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = { draft:'準備中', verified:'検査済み', sending:'結果確認が必要', unknown:'結果確認が必要', failed:'出品エラー', published:'出品済み' };
  const settingFields = ['shipping_policy_id', 'return_policy_id', 'payment_policy_id'];
  const settingsByEnv = {};
  let csrf = '', draft = null, busy = false, uncertain = false;
  let imported = null;
  const pendingKey = 'ailis-ebay-pending-product';
  const draftKey = 'ailis-ebay-current-draft';
  function showLogin() { csrf = ''; $('login').hidden = false; $('app-content').hidden = true; $('app-nav').hidden = true; }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd = value => Number(value).toLocaleString('en-US', { style:'currency', currency:'USD' });
  const date = value => new Date(value * 1000).toLocaleString('ja-JP');
  const envLabel = env => env === 'production' ? 'Production（本番）' : 'Sandbox（テスト）';
  const locked = () => draft && ['sending', 'unknown', 'published'].includes(draft.state);
  function message(text, type='info') {
    $('message').textContent = text;
    $('message').className = 'notice ' + type;
    $('message').hidden = !text;
  }
  async function session() {
    const response = await fetch('/api/ebay-trading?action=session', { headers:{'X-AILIS-Request':'trading-v1'}, cache:'no-store' });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '共通サーバーに接続できません。');
    csrf = result.csrf;
    if (!result.authenticated) { showLogin(); return false; }
    $('login').hidden = true; $('app-content').hidden = false; $('app-nav').hidden = false;
    return true;
  }
  async function api(action, data={}) {
    if (draft && data.draft_id === draft.id) data.expected_revision = draft.revision;
    if (['save_settings','check_connection'].includes(action)) data.settings_revision = settingsByEnv[data.environment]?.revision;
    const response = await fetch('/api/ebay-trading', { method:'POST', cache:'no-store',
      headers:{'Content-Type':'application/json', 'X-AILIS-Request':'trading-v1', 'X-AILIS-CSRF':csrf},
      body:JSON.stringify({action, ...data}) });
    const result = await response.json().catch(() => ({ok:false,error:'共通サーバーから応答を受け取れませんでした。保存状態を再読込してください。'}));
    if (response.status === 401 && action !== 'login') showLogin();
    if (!response.ok || !result.ok) {
      const details = (result.details || []).map(d => `${d.code}: ${d.message}`).join('\n');
      throw new Error((result.error || '処理に失敗しました。') + (details ? '\n' + details : ''));
    }
    return result;
  }
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    message(label);
    const controls = [...document.querySelectorAll('button,input,select,textarea')].map(el => [el, el.disabled]);
    controls.forEach(([el]) => { el.disabled = true; });
    try { await fn(); } catch (error) { message(error.message, 'error'); }
    finally {
      busy = false;
      controls.forEach(([el, disabled]) => { el.disabled = disabled; });
      renderDraft();
    }
  }
  function currentEnvironment() { return $('settings-environment').value; }
  function fillSettings(settings) {
    settingsByEnv[settings.environment] = settings;
    if (settings.environment !== currentEnvironment()) return;
    settingFields.forEach(key => { $(key).value = settings[key] || ''; });
    $('store-locations').innerHTML = settings.stores.map(store => {
      const address = settings.store_locations[store.key];
      return `<fieldset><legend>${escape(store.name)}</legend><div class="grid"><label>商品所在地（英語）<input id="store-location-${escape(store.key)}" value="${escape(address.location)}" maxlength="80" placeholder="例：Yamagata, Yamagata, Japan"></label><label>郵便番号<input id="store-postal-${escape(store.key)}" value="${escape(address.postal_code)}" maxlength="10" placeholder="例：990-2444"></label></div></fieldset>`;
    }).join('');
    $('oauth-help').textContent = settings.oauth_ready ? '接続・再接続後は、本番出品を有効にする設定が解除されます。' : '管理者によるeBay接続の初期設定が必要です。';
    $('production_enabled').checked = settings.production_enabled === true;
    $('production-setting').hidden = settings.environment !== 'production';
    $('account-state').textContent = settings.seller_id ? `${envLabel(settings.environment)} · ${settings.seller_id} · 接続確認 ${date(settings.checked_at)}` : `${envLabel(settings.environment)} · 接続未確認`;
  }
  async function loadSettings(env) {
    const result = await api('settings', {environment:env});
    fillSettings(result.settings);
    return result.settings;
  }
  async function adopt(result) {
    draft = result.draft;
    uncertain = false;
    history.replaceState(null, '', '/ebay/?draft=' + draft.id);
    sessionStorage.setItem(draftKey, draft.id);
    $('settings-environment').value = draft.environment;
    await loadSettings(draft.environment);
    renderDraft();
  }
  function messagesHtml(result) {
    const messages = (result?.messages || []).map(m => `<div class="notice ${m.severity === 'Error' ? 'error' : 'warning'}">${escape(m.code)} · ${escape(m.message)}</div>`).join('');
    const details = (result?.details || []).map(message => `<div class="notice ${result.ack === 'Failure' || result.ack === 'PartialFailure' ? 'error' : 'warning'}"><strong>eBayからの詳しい説明</strong><br>${escape(message)}</div>`).join('');
    return messages + details;
  }
  function policyHtml(kind, policy) {
    const p = policy.details || {};
    const rows = [];
    const add = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push([label,value]); };
    const boolean = value => typeof value === 'boolean' ? (value ? 'あり' : 'なし') : '';
    const regions = value => (value || []).map(r => r.regionName).join(', ');
    add('ポリシー名',policy.name); add('ポリシーID',policy.id); add('対象サイト',p.marketplaceId);
    if (kind === 'shipping') {
      if (p.handlingTime) add('発送まで', `${p.handlingTime.value} ${p.handlingTime.unit === 'DAY' ? '営業日' : p.handlingTime.unit}`);
      for (const option of p.shippingOptions || []) {
        for (const s of option.shippingServices || []) {
          const cost = s.freeShipping ? '送料無料' : s.shippingCost ? `${s.shippingCost.value} ${s.shippingCost.currency}` : '送料はeBay側で計算・設定';
          add(option.optionType === 'DOMESTIC' ? '米国内向けの配送' : '国際配送', `${s.shippingServiceCode || s.shippingCarrierCode || ''} / ${cost}`);
          add('サービスの配送先',regions(s.shipToLocations?.regionIncluded));
        }
      }
      add('配送先',regions(p.shipToLocations?.regionIncluded));
      add('配送対象外',regions(p.shipToLocations?.regionExcluded));
      add('店頭受取',boolean(p.localPickup));
    } else if (kind === 'return') {
      add('返品受付',boolean(p.returnsAccepted));
      if (p.returnPeriod) add('返品期間',`${p.returnPeriod.value} ${p.returnPeriod.unit === 'DAY' ? '日' : p.returnPeriod.unit}`);
      add('返送料負担',{BUYER:'購入者',SELLER:'出品者'}[p.returnShippingCostPayer] || p.returnShippingCostPayer);
      if (p.internationalOverride) add('国際取引の返品受付',boolean(p.internationalOverride.returnsAccepted));
    } else {
      add('即時支払',boolean(p.immediatePay));
      add('決済方法',(p.paymentMethods || []).map(m => m.paymentMethodType).join(', '));
    }
    return `<h3>${escape(policy.name)}</h3><dl>${rows.map(([k,v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl><button type="button" data-select-policy="${kind}" data-policy-id="${escape(policy.id)}">この${{shipping:'配送',return:'返品',payment:'支払'}[kind]}ポリシーを選ぶ</button>`;
  }
  function verificationValid() {
    const v = draft?.verification;
    return !uncertain && draft?.state === 'verified' && v && v.expires_at > Date.now()/1000
      && settingsByEnv[draft.environment]?.revision === v.settings_revision;
  }
  function updatePublishButton() {
    const s = draft && settingsByEnv[draft.environment];
    $('publish').disabled = busy || !verificationValid() || !$('publish-confirm').checked
      || (draft?.environment === 'production' && !s?.production_enabled);
  }
  function renderDraft() {
    $('welcome').hidden = !!draft;
    $('workspace').hidden = !draft;
    if (!draft) return;
    const p = draft.product;
    const isProduction = draft.environment === 'production';
    $('environment-badge').textContent = envLabel(draft.environment);
    $('environment-badge').className = 'badge' + (isProduction ? ' production' : '');
    $('draft-state').textContent = names[draft.state] || draft.state;
    $('product-summary').innerHTML = `<h3>${escape(p.title)}</h3><dl><dt>SKU / 店舗</dt><dd>${escape(p.sku)} / ${escape(draft.store || '未指定')}</dd><dt>出品価格</dt><dd class="price">${usd(p.pricing.targetUsd)}</dd><dt>Best Offer</dt><dd>${usd(p.pricing.quickUsd)}未満は自動拒否 ／ 自動承諾なし</dd><dt>形式 / 数量</dt><dd>米国 · 固定価格 · GTC（終了するまで継続） · 1点</dd><dt>カテゴリ / 状態</dt><dd>${escape(p.categoryId)} / ${escape(p.condition.name || p.condition.id)}</dd><dt>製造国</dt><dd>${escape(p.countryOfOrigin)}</dd></dl>`;
    $('product-details').innerHTML = `<pre>${escape(p.description)}</pre><h3>コンディション説明</h3><pre>${escape(p.condition.description)}</pre><table><tbody>${Object.entries(p.itemSpecifics).map(([name,values]) => `<tr><th>${escape(name)}</th><td>${escape([values].flat().join(', '))}</td></tr>`).join('')}</tbody></table>`;
    $('clone-draft').textContent = isProduction ? 'Sandbox用の出品準備を作る' : '本番用の出品準備を作る';
    $('clone-draft').hidden = ['sending','unknown'].includes(draft.state);
    $('image-count').textContent = `（${draft.images.length}/24）`;
    $('images').innerHTML = draft.images.map((im, index) => `<div class="image-card"><img src="${escape(im.url)}" alt="商品画像 ${index+1}" referrerpolicy="no-referrer"><p>${index === 0 ? 'メイン画像' : '画像 ' + (index+1)} · ${escape(im.name)}</p>${im.expires_at ? `<p>有効期限 ${escape(date(im.expires_at))}</p>` : ''}${locked() ? '' : `<div class="actions"><button data-image-action="image_move" data-image-id="${im.id}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="画像${index+1}を前へ">←</button><button data-image-action="image_move" data-image-id="${im.id}" data-direction="1" ${index === draft.images.length-1 ? 'disabled' : ''} aria-label="画像${index+1}を後へ">→</button><button data-image-action="image_remove" data-image-id="${im.id}">削除</button></div>`}</div>`).join('');
    $('image-edit').hidden = locked();
    $('file-area').hidden = !isProduction;
    $('sandbox-image-note').hidden = isProduction;
    $('verify').disabled = busy || locked() || !draft.images.length;
    const v = draft.verification;
    const valid = verificationValid();
    let verification = messagesHtml(draft.last_result);
    if (v) {
      const submitted = ['sending','unknown','published'].includes(draft.state);
      verification = `<div class="notice ${valid || submitted ? 'success' : 'warning'}">${submitted ? '出品時に使用した事前検査の記録です。' : valid ? '事前検査を通過しました。' : '検査期限切れ、または設定が変更されました。再検査してください。'}\n確認した出品者：${escape(v.seller_id)} ／ 有効期限：${escape(date(v.expires_at))}</div>` + verification;
      if (v.fees.length) verification += `<details open><summary>eBayが返した出品時の手数料見積り</summary><table><tbody>${v.fees.filter(f => Number(f.value) || f.name === 'ListingFee').map(f => `<tr><th>${escape(f.name)}</th><td>${escape(f.value)} ${escape(f.currency)}</td></tr>`).join('')}</tbody></table><p class="muted">落札手数料は含みません。実際の出品時に金額が変わる場合があります。</p></details>`;
    }
    $('verification').innerHTML = verification;
    const s = v?.settings || settingsByEnv[draft.environment] || {};
    const address = v?.settings?.store === draft.store ? v.settings : settingsByEnv[draft.environment]?.store_locations?.[draft.store] || {};
    const storeName = (settingsByEnv[draft.environment]?.stores || []).find(store => store.key === draft.store)?.name || draft.store || '店舗未指定';
    const seller = v?.seller_id || settingsByEnv[draft.environment]?.seller_id || '接続未確認';
    $('publish-summary').innerHTML = `<dl><dt>出品先</dt><dd><strong>${escape(envLabel(draft.environment))} / ${escape(seller)}</strong></dd><dt>価格 / 数量</dt><dd>${usd(p.pricing.targetUsd)} / 1点</dd><dt>在庫店舗</dt><dd>${escape(storeName)}</dd><dt>商品所在地</dt><dd>${escape(address.location || '未設定')} / ${escape(address.postal_code || '未設定')}（JP）</dd><dt>ポリシーID</dt><dd>配送 ${escape(s.shipping_policy_id || '未設定')} / 返品 ${escape(s.return_policy_id || '未設定')} / 支払 ${escape(s.payment_policy_id || '未設定')}</dd></dl><p>${isProduction ? '「eBayに出品する」を押すと、商品が公開され購入可能になります。' : 'Sandbox内のテスト出品です。実際のeBayには公開されません。'}</p>${isProduction && !settingsByEnv.production?.production_enabled ? '<p class="notice warning">接続設定で本番出品を有効にしてから、再検査してください。</p>' : ''}`;
    $('publish-confirm').checked = false;
    $('confirm-row').hidden = locked();
    $('publish').hidden = locked();
    $('publish').textContent = isProduction ? 'eBayに出品する' : 'Sandboxにテスト出品する';
    $('publish').className = 'primary' + (isProduction ? ' danger' : '');
    $('reconcile').hidden = !['unknown','sending'].includes(draft.state);
    let published = '';
    if (draft.state === 'published') {
      const host = isProduction ? 'www.ebay.com' : 'www.sandbox.ebay.com';
      published = `<div class="notice success">出品が完了しました。Item ID：${escape(draft.item_id)}\n<a target="_blank" rel="noopener noreferrer" href="https://${host}/itm/${encodeURIComponent(draft.item_id)}">出品した商品を確認する</a></div>`;
    } else if (['sending','unknown'].includes(draft.state) || uncertain) {
      published = '<div class="notice warning">出品結果の確認が必要です。再送せず、保存状態の再読込または結果照会を行ってください。</div>';
    }
    if (draft.reconcile_result && draft.state !== 'published') published += `<div class="notice warning">${escape(draft.reconcile_result.message)}${draft.reconcile_result.found_item_id ? '\n見つかったItem ID：' + escape(draft.reconcile_result.found_item_id) : ''}</div>`;
    $('published-result').innerHTML = published;
    updatePublishButton();
  }
  function openSettings() { $('settings').hidden = false; $('settings').scrollIntoView({behavior:'smooth', block:'start'}); }
  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    run('ログインしています。', async () => {
      try { await api('login', {username:$('login-user').value.trim(), password:$('login-password').value}); await initialize(); }
      finally { $('login-password').value = ''; }
    });
  });
  $('logout').addEventListener('click', () => run('ログアウトしています。', async () => {
    await api('logout'); sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(draftKey); imported = null; draft = null;
    history.replaceState(null, '', '/ebay/'); showLogin(); message('ログアウトしました。');
  }));
  $('connect-ebay').addEventListener('click', () => run('eBayの接続画面を開いています。', async () => {
    const result = await api('oauth_start', {environment:currentEnvironment()});
    location.assign(result.url);
  }));
  $('settings-toggle').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  $('welcome-settings').addEventListener('click', openSettings);
  $('settings-environment').addEventListener('change', () => run('接続設定を読み込んでいます。', async () => {
    $('policy-details').replaceChildren();
    ['shipping','return','payment'].forEach(k => $(k+'-policies').replaceChildren());
    await loadSettings(currentEnvironment()); message('');
  }));
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    run('接続設定を保存しています。', async () => {
      const settings = Object.fromEntries(settingFields.map(k => [k,$(k).value.trim()]));
      settings.store_locations = Object.fromEntries(settingsByEnv[currentEnvironment()].stores.map(store => [store.key, {
        location:$('store-location-' + store.key).value.trim(), postal_code:$('store-postal-' + store.key).value.trim()
      }]));
      settings.production_enabled = $('production_enabled').checked;
      const result = await api('save_settings', {environment:currentEnvironment(), settings});
      fillSettings(result.settings);
      message('共通設定を保存しました。出品前に再検査してください。', 'success');
    });
  });
  $('check-connection').addEventListener('click', () => run('eBayアカウントへの接続を確認しています。', async () => {
    try {
      const result = await api('check_connection', {environment:currentEnvironment()});
      fillSettings(result.settings);
      message('接続を確認しました：' + result.settings.seller_id, 'success');
    } catch (error) { await loadSettings(currentEnvironment()); throw error; }
  }));
  $('clear-credentials').addEventListener('click', () => {
    if (!confirm(envLabel(currentEnvironment()) + 'のeBay接続を全PCで解除しますか？ 作業中の商品と二重出品防止の記録は残ります。')) return;
    run('認証情報を削除しています。', async () => {
      const result = await api('save_settings', {environment:currentEnvironment(), settings:{clear_credentials:true}});
      fillSettings(result.settings); message('認証情報を削除しました。', 'success');
    });
  });
  $('load-policies').addEventListener('click', () => run('eBayのビジネスポリシーを取得しています。', async () => {
    const result = await api('policies', {environment:currentEnvironment()});
    const labels = {shipping:'配送',return:'返品',payment:'支払'};
    $('policy-details').innerHTML = Object.entries(result.policies).map(([kind, items]) => {
      $(kind + '-policies').innerHTML = items.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
      return `<details><summary>${labels[kind]}ポリシー：${items.length}件（条件を確認）</summary>${items.map(p => policyHtml(kind,p)).join('')}</details>`;
    }).join('');
    message('各ポリシーID欄から対象を選び、条件を確認して保存してください。', 'success');
  }));
  $('policy-details').addEventListener('click', event => {
    const button = event.target.closest('[data-select-policy]');
    if (!button || busy) return;
    $(button.dataset.selectPolicy + '_policy_id').value = button.dataset.policyId;
    message('ポリシーを選びました。「設定を保存」で確定してください。');
  });
  async function loadWorklist() {
    const result = await api('worklist');
    $('worklist-list').innerHTML = result.drafts.length ? result.drafts.map(d => `<div class="worklist-item"><div><strong>${escape(d.title)}</strong><small>${escape(d.sku)} · ${escape(envLabel(d.environment))} · ${escape(names[d.state])} · ${escape(date(d.updated_at))}</small></div><button data-draft-id="${d.id}">開く</button></div>`).join('') : '<p class="muted">作業中の商品はありません。</p>';
  }
  $('worklist-toggle').addEventListener('click', () => {
    $('worklist').hidden = !$('worklist').hidden;
    if (!$('worklist').hidden) run('作業中の商品を読み込んでいます。', async () => { await loadWorklist(); message(''); });
  });
  $('refresh-worklist').addEventListener('click', () => run('作業中の商品を読み込んでいます。', async () => { await loadWorklist(); message(''); }));
  $('worklist-list').addEventListener('click', event => {
    const button = event.target.closest('[data-draft-id]');
    if (button) run('出品準備を読み込んでいます。', async () => { await adopt(await api('draft', {draft_id:button.dataset.draftId})); $('worklist').hidden = true; message(''); });
  });
  $('reload-draft').addEventListener('click', () => run('保存状態を読み込んでいます。', async () => { await adopt(await api('draft',{draft_id:draft.id})); message('保存状態を読み込みました。', 'success'); }));
  $('clone-draft').addEventListener('click', () => run('出品準備を作成しています。', async () => {
    await adopt(await api('clone', {draft_id:draft.id, environment:draft.environment === 'production' ? 'sandbox' : 'production'}));
    message(envLabel(draft.environment) + 'の出品準備を作りました。画像と接続設定を確認してください。', 'success');
  }));
  $('add-urls').addEventListener('click', () => run('画像URLを登録しています。', async () => {
    const urls = $('image-urls').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!urls.length) throw new Error('画像URLを入力してください。');
    if (draft.images.length + urls.length > 24) throw new Error('画像は合計24枚以内にしてください。');
    for (let i = 0; i < urls.length; i++) {
      const result = await api('image_url', {draft_id:draft.id, url:urls[i]});
      draft = result.draft;
      // On partial failure only leave URLs that have not been added.
      $('image-urls').value = urls.slice(i+1).join('\n');
    }
    message('画像URLを登録しました。表示・順序を確認してください。', 'success');
  }));
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('画像ファイルを読み取れませんでした。'));
      reader.readAsDataURL(file);
    });
  }
  $('image-files').addEventListener('change', () => {
    const files = [...$('image-files').files];
    if (!files.length) return;
    run('画像をeBayへ登録しています。', async () => {
      try {
        if (draft.images.length + files.length > 24) throw new Error('画像は合計24枚以内にしてください。');
        for (const file of files) if (file.size > 12*1024*1024) throw new Error(file.name + '：画像は12MB以下にしてください。');
        for (let i = 0; i < files.length; i++) {
          message(`画像をeBayへ登録しています（${i+1}/${files.length}）：${files[i].name}`);
          const file = files[i];
          const upload = await api('image_begin', {draft_id:draft.id, name:file.name, size:file.size});
          for (let start = 0, part = 0; start < file.size; start += 1048576, part++) {
            await api('image_chunk', {upload_id:upload.upload_id, part, base64:await readBase64(file.slice(start,start+1048576))});
          }
          const result = await api('image_finish', {upload_id:upload.upload_id});
          draft = result.draft;
        }
        message('画像を登録しました。表示・順序を確認してください。', 'success');
      } finally { $('image-files').value = ''; }
    });
  });
  $('images').addEventListener('click', event => {
    const button = event.target.closest('[data-image-action]');
    if (!button) return;
    run('画像一覧を更新しています。', async () => {
      draft = (await api(button.dataset.imageAction, {draft_id:draft.id, image_id:button.dataset.imageId, direction:Number(button.dataset.direction)})).draft;
      message('画像一覧を更新しました。', 'success');
    });
  });
  $('verify').addEventListener('click', () => run('eBayで事前検査しています。公開はされません。', async () => {
    draft.verification = null;
    draft.state = 'draft';
    draft = (await api('verify', {draft_id:draft.id})).draft;
    await loadSettings(draft.environment);
    message(draft.state === 'verified' ? '事前検査を通過しました。出品内容と検査結果を確認してください。' : 'eBayの検査でエラーが返りました。検査結果を確認してください。', draft.state === 'verified' ? 'success' : 'error');
  }));
  $('publish-confirm').addEventListener('change', updatePublishButton);
  $('publish').addEventListener('click', () => {
    if (!verificationValid() || !$('publish-confirm').checked) return;
    const verificationId = draft.verification.id;
    run('出品リクエストを送信しています。結果が表示されるまでお待ちください。', async () => {
      try {
        draft = (await api('publish', {draft_id:draft.id, verification_id:verificationId, confirmed:true})).draft;
        message(draft.state === 'published' ? '出品が完了しました。Item ID：' + draft.item_id : '出品結果を確認してください。', draft.state === 'published' ? 'success' : 'warning');
      } catch (error) {
        uncertain = true;
        try { await adopt(await api('draft', {draft_id:draft.id})); } catch (_) { /* Require explicit reload after connection loss. */ }
        throw error;
      }
    });
  });
  $('reconcile').addEventListener('click', () => run('eBayに出品結果を照会しています。再送は行いません。', async () => {
    draft = (await api('reconcile', {draft_id:draft.id})).draft;
    message(draft.state === 'published' ? '出品済みの商品を確認しました。' : '出品を確定できませんでした。結果欄を確認してください。', draft.state === 'published' ? 'success' : 'warning');
  }));
  // Consume a fragment once; product information never goes into server request logs.
  async function initialize() {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('ailis');
    if (fragment) {
      history.replaceState(null, '', '/ebay/');
      imported = JSON.parse(fragment);
      sessionStorage.setItem(pendingKey, JSON.stringify(imported));
    }
    if (!imported && sessionStorage.getItem(pendingKey)) imported = JSON.parse(sessionStorage.getItem(pendingKey));
    if (!(await session())) { message(''); return; }
    if (imported) {
      await adopt(await api('create', {environment:'production', product:imported.product, store:imported.store || ''}));
      imported = null;
      sessionStorage.removeItem(pendingKey);
      message('AILISの商品情報を引き継ぎ、本番用の出品準備を作りました。まだ出品されていません。画像を登録し、事前検査へ進んでください。', 'success');
    } else {
      const params = new URLSearchParams(location.search);
      const id = params.get('draft') || sessionStorage.getItem(draftKey);
      if (id) await adopt(await api('draft', {draft_id:id}));
      else { await loadSettings('production'); message(''); }
      if (params.get('connection_error')) message('eBayとの接続が完了しませんでした。接続設定からもう一度接続してください。', 'error');
      if (['sandbox','production'].includes(params.get('connected'))) {
        $('settings-environment').value = params.get('connected');
        await loadSettings(params.get('connected')); openSettings();
        message('eBayに接続しました。出品者とポリシーを確認してください。', 'success');
      }
    }
  }
  run('出品画面を準備しています。', initialize);
  setInterval(() => { if (!busy) updatePublishButton(); }, 1000);
}());
