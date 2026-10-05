(() => {
  const CHANNEL = 'fcgh-v1', pending = new Map();
  const BRIDGE_VERSION = '1.3.8';
  let callId = 0, catalog = null, sets = [], currentPlan = null, sbcPlan = null, running = false, persona = 'default';
  const collected = new Set(), scores = {}, names = {};
  const format = value => Number(value || 0).toLocaleString('ru-RU');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cardCeiling = (price, globalMax) => Math.min(Number(globalMax), Math.ceil((Number(price) * 1.10 + 100) / 50) * 50);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...(Array.isArray(children) ? children : [children]));
    return node;
  };
  function bridge(method, args = {}, timeout = 30_000) {
    const id = `${Date.now()}-${++callId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('EA не ответила вовремя')); }, timeout);
      pending.set(id, {resolve, reject, timer});
      window.postMessage({channel: CHANNEL, direction: 'request', id, method, args}, '*');
    });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message?.direction !== 'response') return;
    const wait = pending.get(message.id); if (!wait) return;
    clearTimeout(wait.timer); pending.delete(message.id);
    message.ok ? wait.resolve(message.result) : wait.reject(new Error(message.error));
  });
  const runtime = message => new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
    response?.ok ? resolve(response) : reject(new Error(response?.error || 'Фоновый процесс не ответил'));
  }));
  function label(text, control) { return el('label', {}, [el('span', {text}), control]); }
  function fail(status, error) { status.className = 'fcgh-error'; status.textContent = error?.message || String(error); }
  const eaRefused = error => /\b461\b/.test(String(error?.message || error));
  async function findAndBuy({defId, name, ceiling, purchaseMode, status}) {
    const excludedTradeIds = [], attempts = purchaseMode === 'confirm' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = await bridge('search', {defId, maxBuy: ceiling, excludeTradeIds: excludedTradeIds}, 45_000);
      if (!found.found) return {state: 'not-found'};
      const shownName = found.name || name || `#${defId}`;
      if (purchaseMode === 'confirm' && !confirm(`Найден лот:\n\n${shownName}\nЦена: ${format(found.price)} монет\nЛимит: ${format(ceiling)} монет\n\nКупить эту карточку?\n«Отмена» — пропустить и перейти к следующей.`)) return {state: 'skipped', found};
      status.textContent = `Покупаю ${shownName} за ${format(found.price)}…`;
      try {
        const receipt = await bridge('buy', {handle: found.handle, ceiling}, 45_000);
        return {state: 'bought', found, receipt};
      } catch (error) {
        if (!eaRefused(error)) throw error;
        if (found.tradeId != null) excludedTradeIds.push(found.tradeId);
        if (purchaseMode !== 'confirm' || attempt + 1 >= attempts) return {state: 'rejected', found, error};
        status.textContent = `EA отклонила лот ${shownName} за ${format(found.price)}. Ищу другой лот этой карточки…`;
        await sleep(750);
      }
    }
    return {state: 'rejected'};
  }

  function mount() {
    if (document.getElementById('fcgh-root')) return;
    const root = el('div', {id: 'fcgh-root'}), toggle = el('button', {id: 'fcgh-toggle', text: 'FC Helper'}), panel = el('section', {id: 'fcgh-panel'}); panel.hidden = true;
    const head = el('div', {class: 'fcgh-head'}, [el('div', {}, [el('h2', {text: 'FC Gallery + ИПК'}), el('small', {id: 'fcgh-connection', text: 'Подключение…'})]), el('button', {class: 'fcgh-close', text: '×'})]);
    const category = el('select', {id: 'fcgh-category'}), set = el('select', {id: 'fcgh-set'}), grade = el('select', {id: 'fcgh-grade'});
    const platform = el('select', {id: 'fcgh-platform'}, [el('option', {value: 'ps5', text: 'Console / PS5'}), el('option', {value: 'pc', text: 'PC'})]);
    const maxPrice = el('input', {id: 'fcgh-max', type: 'number', min: '150', value: '1000'}), budget = el('input', {id: 'fcgh-budget', type: 'number', min: '0', value: '10000'}), discount = el('input', {id: 'fcgh-discount', type: 'number', min: '0', max: '20', value: '5'});
    const after = el('select', {id: 'fcgh-after'}, [el('option', {value: 'club', text: 'Оставить в клубе'}), el('option', {value: 'transfer', text: 'В трансфер-лист'}), el('option', {value: 'list', text: 'Выставить по минимуму рынка'})]);
    const purchaseMode = el('select', {id: 'fcgh-purchase-mode'}, [el('option', {value: 'confirm', text: 'Полуавтомат: Да / Нет'}), el('option', {value: 'auto', text: 'Автоматически — на свой риск'})]);
    const form = el('div', {class: 'fcgh-form'}, [label('Категория', category), label('Набор', set), label('Грейд', grade), label('Цены', platform), label('Потолок за 1 карту', maxPrice), label('Общий бюджет', budget), label('Режим покупки', purchaseMode), label('После покупки', after), label('Ниже рынка, %', discount)]);
    const sync = el('button', {text: '1. Найти мои карты'}), plan = el('button', {text: '2. Составить план', class: 'fcgh-primary'}), start = el('button', {text: '3. Купить по плану', class: 'fcgh-danger'}), stop = el('button', {text: 'Стоп', class: 'fcgh-secondary'}); stop.disabled = true;
    const status = el('div', {id: 'fcgh-status', text: 'Загружаю каталог…'}), result = el('div', {id: 'fcgh-result'});
    const galleryBody = el('div', {class: 'fcgh-body'}, [el('p', {class: 'fcgh-guide', text: 'Выбери набор и грейд. Затем нажимай кнопки по порядку: 1 → 2 → 3.'}), form, el('div', {class: 'fcgh-actions'}, [sync, plan]), status, result, el('div', {class: 'fcgh-actions'}, [start, stop]), el('p', {class: 'fcgh-risk', text: 'Автопокупка нарушает правила EA и может привести к ограничению рынка или блокировке аккаунта. Перед стартом показывается точный лимит монет и количество карт.'})]);

    const sbcUrl = el('input', {id: 'fcgh-sbc-url', type: 'url', placeholder: 'https://www.futbin.com/27/squad/…/sbc'});
    const sbcPlatform = el('select', {id: 'fcgh-sbc-platform'}, [el('option', {value: 'ps5', text: 'Console / PS5'}), el('option', {value: 'pc', text: 'PC'})]);
    const sbcMax = el('input', {id: 'fcgh-sbc-max', type: 'number', min: '150', value: '2000'}), sbcBudget = el('input', {id: 'fcgh-sbc-budget', type: 'number', min: '0', value: '25000'});
    const sbcPurchaseMode = el('select', {id: 'fcgh-sbc-purchase-mode'}, [el('option', {value: 'confirm', text: 'Полуавтомат: Да / Нет'}), el('option', {value: 'auto', text: 'Автоматически — на свой риск'})]);
    const sbcImport = el('button', {text: '1. Импорт FUTBIN'}), sbcScan = el('button', {text: '2. Проверить клуб', class: 'fcgh-primary'}), sbcBuy = el('button', {text: '3. Купить недостающих', class: 'fcgh-danger'}), sbcStop = el('button', {text: 'Стоп', class: 'fcgh-secondary'}), sbcFill = el('button', {text: '4. Расставить в открытый ИПК', class: 'fcgh-primary'}), sbcUndo = el('button', {text: 'Отменить расстановку', class: 'fcgh-secondary'}); sbcStop.disabled = true; sbcUndo.disabled = true;
    const sbcStatus = el('div', {id: 'fcgh-sbc-status', text: 'Вставь ссылку на готовый состав FUTBIN.'}), sbcResult = el('div', {id: 'fcgh-sbc-result'});
    const sbcBody = el('div', {class: 'fcgh-body'}); sbcBody.hidden = true;
    sbcBody.append(el('p', {class: 'fcgh-guide', text: 'Открой на FUTBIN готовую сборку ИПК, скопируй её ссылку и вставь ниже. После покупки открой нужное испытание в EA и нажми кнопку расстановки.'}), label('Ссылка на сборку FUTBIN', sbcUrl), el('div', {class: 'fcgh-form'}, [label('Цены', sbcPlatform), label('Потолок за 1 карту', sbcMax), label('Общий бюджет', sbcBudget), label('Режим покупки', sbcPurchaseMode)]), el('div', {class: 'fcgh-actions'}, [sbcImport, sbcScan]), sbcStatus, sbcResult, el('div', {class: 'fcgh-actions'}, [sbcBuy, sbcStop]), el('div', {class: 'fcgh-actions'}, [sbcFill, sbcUndo]), el('p', {class: 'fcgh-risk', text: 'Расстановка заменяет игроков на открытом поле и сохраняет состав, но не сдаёт его. Проверь требования EA и сам нажми «Подтвердить».'}));
    const galleryTab = el('button', {class: 'fcgh-tab active', text: 'Gallery'}), sbcTab = el('button', {class: 'fcgh-tab', text: 'ИПК'}), tabs = el('div', {class: 'fcgh-tabs'}, [galleryTab, sbcTab]);
    panel.append(head, tabs, galleryBody, sbcBody);
    root.append(toggle, panel); document.documentElement.append(root);
    const open = value => { panel.hidden = !value; toggle.setAttribute('aria-expanded', String(value)); };
    toggle.onclick = () => open(panel.hidden); head.querySelector('.fcgh-close').onclick = () => open(false);
    const showTab = kind => { const sbc = kind === 'sbc'; galleryBody.hidden = sbc; sbcBody.hidden = !sbc; galleryTab.classList.toggle('active', !sbc); sbcTab.classList.toggle('active', sbc); toggle.textContent = sbc ? 'ИПК' : 'Gallery'; };
    galleryTab.onclick = () => showTab('gallery'); sbcTab.onclick = () => showTab('sbc');
    category.onchange = () => fillSets(category.value, set, grade); set.onchange = () => fillGrades(set.value, grade);
    sync.onclick = () => syncSet(set.value, status, result).catch(error => fail(status, error));
    plan.onclick = () => calculate(set.value, grade.value, {platform, maxPrice, budget}, status, result).catch(error => fail(status, error));
    start.onclick = () => execute({maxPrice, budget, after, discount, purchaseMode}, status, result, start, stop).catch(error => fail(status, error));
    stop.onclick = () => { running = false; status.textContent = 'Останавливаю после текущего запроса…'; };
    sbcImport.onclick = () => importSbc(sbcUrl.value, {platform: sbcPlatform}, sbcStatus, sbcResult).catch(error => fail(sbcStatus, error));
    sbcScan.onclick = () => scanSbcClub({platform: sbcPlatform, maxPrice: sbcMax, budget: sbcBudget}, sbcStatus, sbcResult).catch(error => fail(sbcStatus, error));
    sbcBuy.onclick = () => buySbc({maxPrice: sbcMax, budget: sbcBudget, purchaseMode: sbcPurchaseMode}, sbcStatus, sbcResult, sbcBuy, sbcStop).catch(error => fail(sbcStatus, error));
    sbcStop.onclick = () => { running = false; sbcStatus.textContent = 'Останавливаю после текущего запроса…'; };
    sbcFill.onclick = () => placeSbc(sbcStatus, sbcResult, sbcFill, sbcUndo).catch(error => fail(sbcStatus, error));
    sbcUndo.onclick = () => undoSbc(sbcStatus, sbcUndo).catch(error => fail(sbcStatus, error));
    initialize(category, set, grade, status).catch(error => fail(status, error));
  }
  const selectedSet = id => sets.find(row => row.id === id) || null;
  function fillSets(categoryId, setSelect, gradeSelect) {
    const list = sets.filter(row => row.categoryId === categoryId); setSelect.replaceChildren(...list.map(row => el('option', {value: row.id, text: row.name}))); fillGrades(setSelect.value, gradeSelect);
  }
  function fillGrades(setId, gradeSelect) {
    const row = selectedSet(setId); gradeSelect.replaceChildren(...((row?.grades || []).map(g => el('option', {value: g.letter, text: `${g.letter} — ${format(g.threshold)} очков`}))));
  }
  async function initialize(categorySelect, setSelect, gradeSelect, status) {
    let connected = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      connected = await bridge('status').catch(() => null);
      if (connected?.ready && connected.bridgeVersion !== BRIDGE_VERSION) throw new Error('В странице остался код старой версии расширения. Полностью закрой вкладку EA и открой её заново.');
      if (connected?.ready && connected.capture) break;
      await sleep(500);
    }
    if (!connected?.ready) throw new Error('EA Web App не загрузился. Войди в Ultimate Team и обнови страницу.');
    persona = connected.persona || 'default'; document.getElementById('fcgh-connection').textContent = `EA подключена${Number.isFinite(connected.coins) ? ` · ${format(connected.coins)} монет` : ''}`;
    const memory = await chrome.storage.local.get(`fcghCollected.${persona}`); for (const id of memory[`fcghCollected.${persona}`] || []) collected.add(Number(id));
    catalog = (await runtime({type: 'fcgh.catalog'})).data; sets = [];
    for (const category of catalog.categories || []) for (const row of category.sets || []) sets.push({...row, categoryId: category.id, categoryName: category.name});
    for (const [id, score] of Object.entries(catalog.cardScores || {})) scores[id] = Number(score);
    const categories = [...new Map(sets.map(row => [row.categoryId, row.categoryName])).entries()]; categorySelect.replaceChildren(...categories.map(([id, name]) => el('option', {value: id, text: name})));
    fillSets(categorySelect.value, setSelect, gradeSelect); status.className = ''; status.textContent = `Каталог загружен: ${sets.length} наборов. Выбери набор и проверь историю.`;
  }
  async function saveCollected() { await chrome.storage.local.set({[`fcghCollected.${persona}`]: [...collected]}); }
  async function syncSet(setId, status, result) {
    const row = selectedSet(setId); if (!row) throw new Error('Выбери набор'); const ids = [...new Set((row.pool || []).map(Number))]; if (!ids.length) throw new Error('У набора пустой пул карт');
    result.replaceChildren(); status.className = ''; let checked = 0, newly = 0;
    for (let at = 0; at < ids.length; at += 150) {
      const batch = ids.slice(at, at + 150); status.textContent = `Проверяю историю: ${Math.min(at + batch.length, ids.length)} / ${ids.length}`;
      const answer = await bridge('sync', {ids: batch}, 45_000);
      for (const item of answer.items || []) { if (item.collected === true && !collected.has(item.defId)) { collected.add(item.defId); newly++; } if (Number.isFinite(item.score)) scores[item.defId] = item.score; if (item.name) names[item.defId] = item.name; }
      checked += batch.length; if (at + 150 < ids.length) await sleep(2500);
    }
    await saveCollected(); status.textContent = `Проверено ${checked}. Собрано в наборе: ${ids.filter(id => collected.has(id)).length}. Новых отметок: ${newly}.`;
  }
  function renderSbc(result) {
    result.replaceChildren(); if (!sbcPlan?.cards?.length) return;
    const summary = sbcPlan.scanned
      ? `Состав: ${sbcPlan.cards.length} карт. В клубе: ${sbcPlan.owned.length}. Докупить: ${sbcPlan.missing.length} примерно за ${format(sbcPlan.cost)} монет.`
      : `Импортировано 11 карт${sbcPlan.challenge ? ` для «${sbcPlan.challenge}»` : ''}. Нажми «2. Проверить клуб».`;
    result.append(el('div', {class: sbcPlan.scanned && !sbcPlan.missing.length ? 'fcgh-plan-ok' : '', text: summary}));
    const list = el('ol', {class: 'fcgh-plan'});
    for (const card of sbcPlan.cards) {
      const owned = sbcPlan.owned?.some(row => row.slot === card.slot), live = Number(card.livePrice), expected = Number(card.expectedPrice);
      const text = owned ? ' — ЕСТЬ В КЛУБЕ' : ` — ${card.position || '?'} · ${card.rating} · около ${format(live || expected)} монет`;
      list.append(el('li', {'data-sbc-slot': String(card.slot), class: owned ? 'fcgh-owned' : ''}, [el('b', {text: card.name}), el('span', {text})]));
    }
    result.append(list);
  }
  async function importSbc(url, controls, status, result) {
    if (running) throw new Error('Сначала останови текущую покупку');
    status.className = ''; status.textContent = 'Открываю FUTBIN в фоновой вкладке и читаю состав…'; result.replaceChildren();
    const imported = (await runtime({type: 'fcgh.futbin.import', url: String(url || '').trim()})).data;
    const platform = controls.platform.value;
    sbcPlan = {...imported, platform, scanned: false, owned: [], missing: [], cost: 0, cards: imported.cards.map(card => ({...card, expectedPrice: Number(card[platform]) || 0}))};
    renderSbc(result); status.textContent = 'Состав FUTBIN импортирован. Теперь проверь игроков в клубе.';
  }
  async function scanSbcClub(controls, status, result) {
    if (!sbcPlan?.cards?.length) throw new Error('Сначала импортируй готовую сборку FUTBIN');
    status.className = ''; status.textContent = 'Проверяю точные карточки в клубе EA…';
    const ids = sbcPlan.cards.map(card => card.defId), answer = await bridge('club', {ids}, 45_000);
    const counts = {...(answer.counts || {})}, owned = [], missing = [];
    for (const card of sbcPlan.cards) {
      if (Number(counts[card.defId]) > 0) { counts[card.defId]--; owned.push(card); } else missing.push(card);
    }
    status.textContent = 'Загружаю актуальные цены FUT.GG…';
    const prices = (await runtime({type: 'fcgh.prices', platform: controls.platform.value, ids: missing.map(card => card.defId)})).prices;
    for (const card of sbcPlan.cards) card.livePrice = Number(prices[card.defId]) || card.expectedPrice || 0;
    sbcPlan = {...sbcPlan, platform: controls.platform.value, scanned: true, owned, missing, cost: missing.reduce((sum, card) => sum + Number(card.livePrice || 0), 0)};
    renderSbc(result); status.textContent = missing.length ? `Найдено в клубе: ${owned.length}. Нужно купить: ${missing.length}. Каждая покупка будет по самому дешёвому BIN в своём лимите.` : 'Все 11 карт уже есть в клубе. Покупать ничего не нужно.';
  }
  async function buySbc(controls, status, result, start, stop) {
    if (running) return;
    if (!sbcPlan?.scanned) throw new Error('Сначала проверь игроков в клубе');
    if (!sbcPlan.missing.length) throw new Error('Все карты уже есть в клубе');
    const maxPrice = Number(controls.maxPrice.value), budget = Number(controls.budget.value), purchaseMode = controls.purchaseMode.value;
    if (!Number.isSafeInteger(maxPrice) || maxPrice < 150 || !Number.isSafeInteger(budget) || budget <= 0) throw new Error('Проверь лимиты цены и бюджета');
    const rows = sbcPlan.missing.map(card => `${card.name}: ориентир ${format(card.livePrice)}, искать самый дешёвый лот до ${format(maxPrice)}`).join('\n');
    const modeNotice = purchaseMode === 'auto'
      ? '\n\nВНИМАНИЕ: автоматические покупки нарушают правила EA и выполняются на ваш риск.'
      : '\n\nПолуавтоматический режим: перед каждой покупкой нужно отдельно нажать «Да».';
    if (!confirm(`Покупка игроков для ИПК:\n${rows}\n\nОбщие расходы не больше ${format(budget)} монет. Купленные карты будут отправлены в клуб.${modeNotice}\n\nПродолжить?`)) return;
    running = true; start.disabled = true; stop.disabled = false; let spent = 0, bought = 0;
    try {
      for (const card of sbcPlan.missing) {
        if (!running) break;
        const ceiling = Math.min(maxPrice, budget - spent);
        if (ceiling < 150) { status.textContent = 'Остановлено: достигнут общий бюджет.'; break; }
        status.textContent = `Ищу ${card.name} до ${format(ceiling)}…`;
        const line = result.querySelector(`li[data-sbc-slot="${card.slot}"]`);
        const purchase = await findAndBuy({defId: card.defId, name: card.name, ceiling, purchaseMode, status});
        if (purchase.state === 'not-found') { if (line) { line.classList.add('fcgh-missed'); line.append(' — НЕТ ДРУГОГО ЛОТА В ЛИМИТЕ'); } await sleep(1400); continue; }
        if (purchase.state === 'skipped') { if (line) line.append(' — ПРОПУЩЕНО'); status.textContent = `${card.name} пропущен. Перехожу к следующей карточке.`; continue; }
        if (purchase.state === 'rejected') { if (line) { line.classList.add('fcgh-missed'); line.append(' — EA ОТКЛОНИЛА ЛОТЫ'); } status.textContent = `EA отклонила доступные лоты ${card.name}. Перехожу к следующей карточке.`; continue; }
        const receipt = purchase.receipt;
        if (!receipt.item?.handle) throw new Error('Покупка могла пройти, но карточка не появилась в непринятых. Проверь её вручную; повтор не выполнялся.');
        await bridge('move', {handle: receipt.item.handle, destination: 'club'}, 45_000);
        spent += receipt.price; bought++; if (line) { line.classList.add('fcgh-bought'); line.append(` — КУПЛЕНО ЗА ${format(receipt.price)}`); }
        status.textContent = `Куплено ${bought}/${sbcPlan.missing.length}; потрачено ${format(spent)}.`; await sleep(1500 + Math.floor(Math.random() * 900));
      }
    } finally {
      running = false; start.disabled = false; stop.disabled = true;
      result.prepend(el('div', {class: 'fcgh-run-summary', text: `Итог: куплено ${bought}, потрачено ${format(spent)} монет. Нажми «2. Проверить клуб» ещё раз, затем открой выбранный ИПК в EA и проверь состав перед сдачей.`}));
    }
  }
  async function placeSbc(status, result, button, undoButton) {
    if (running) throw new Error('Сначала останови текущую покупку');
    if (!sbcPlan?.cards?.length) throw new Error('Сначала импортируй сборку FUTBIN');
    if (!confirm('Текущие игроки на открытом поле ИПК будут заменены составом FUTBIN. Сдача награды не выполняется. Продолжить?')) return;
    button.disabled = true; status.className = ''; status.textContent = 'Нахожу 11 точных карточек в клубе и сопоставляю позиции…';
    try {
      const answer = await bridge('sbcfill', {cards: sbcPlan.cards.map(card => ({defId: card.defId, name: card.name, fieldX: card.fieldX, fieldY: card.fieldY}))}, 60_000);
      const ok = answer.meetsRequirements === true && answer.canSubmit !== false;
      const box = el('div', {class: ok ? 'fcgh-placement-ok' : 'fcgh-placement-warn'});
      box.append(el('b', {text: ok ? 'EA подтверждает: требования выполнены.' : 'Состав расставлен, но EA пока не подтверждает все требования.'}), el('div', {text: `Рейтинг: ${answer.rating ?? '?'} · Сыгранность: ${answer.chemistry ?? '?'}`}));
      const list = el('ol', {class: 'fcgh-placements'});
      for (const row of answer.placements || []) list.append(el('li', {text: `${row.name} → ${row.position}`}));
      box.append(list); result.prepend(box);
      status.textContent = ok ? 'Готово. Проверь поле и требования, затем можешь вручную нажать «Подтвердить».' : 'Проверь красные требования EA и расположение игроков. При необходимости отмени расстановку.';
      undoButton.disabled = false;
    } finally { button.disabled = false; }
  }
  async function undoSbc(status, undoButton) {
    undoButton.disabled = true; status.className = ''; status.textContent = 'Возвращаю состав, который был на поле до расстановки…';
    await bridge('sbcundo', {}, 60_000); status.textContent = 'Предыдущий состав восстановлен.';
  }
  async function calculate(setId, letter, controls, status, result) {
    const row = selectedSet(setId), target = row?.grades?.find(g => g.letter === letter); if (!row || !target) throw new Error('Выбери набор и грейд');
    const ids = [...new Set((row.pool || []).map(Number))]; status.className = ''; status.textContent = 'Загружаю базу карт и цены FUT.GG…';
    const [priceAnswer, cardAnswer] = await Promise.all([runtime({type: 'fcgh.prices', platform: controls.platform.value, ids}), runtime({type: 'fcgh.cards', ids})]);
    for (const id of ids) {
      if (Number.isFinite(scores[id]) && scores[id] > 0) continue;
      const card = cardAnswer.cards[id]; if (!card) continue;
      const table = catalog.scoreTable || {}, rarity = table[String(card.rarity)] || table.default || {};
      const value = Number(rarity[String(card.rating)]); if (Number.isFinite(value) && value >= 0) scores[id] = value;
    }
    const makePlan = (maxPrice, budget) => GalleryCore.galleryPlan({pool: ids, slots: row.cards, target: Number(target.threshold), collected: [...collected], scores, prices: priceAnswer.prices, maxPrice, budget});
    currentPlan = makePlan(Number(controls.maxPrice.value), Number(controls.budget.value));
    let fallback = makePlan(15_000_000, 1_000_000_000);
    if (!currentPlan.reached && fallback.reason === 'not-enough-cards') {
      const unknown = ids.filter(id => !collected.has(id) && Number(scores[id]) > 0 && !(Number.isSafeInteger(Number(priceAnswer.prices[id])) && Number(priceAnswer.prices[id]) > 0)).slice(0, 25);
      for (let at = 0; at < unknown.length; at++) {
        status.textContent = `Уточняю отсутствующие цены на рынке EA: ${at + 1} / ${unknown.length}…`;
        const live = await bridge('search', {defId: unknown[at], maxBuy: 15_000_000}, 45_000).catch(() => null);
        if (live?.found && Number.isSafeInteger(live.price)) { priceAnswer.prices[unknown[at]] = live.price; if (live.name) names[unknown[at]] = live.name; }
        if (at + 1 < unknown.length) await sleep(1300);
      }
      currentPlan = makePlan(Number(controls.maxPrice.value), Number(controls.budget.value));
      fallback = makePlan(15_000_000, 1_000_000_000);
    }
    currentPlan.fallback = fallback;
    currentPlan.meta = {setId, setName: row.name, letter, platform: controls.platform.value, priceAt: priceAnswer.at}; result.replaceChildren();
    currentPlan.planning = {pool: ids, slots: row.cards, target: Number(target.threshold), prices: priceAnswer.prices};
    const recommendedMax = fallback.reached && fallback.missing.length ? Math.max(...fallback.missing.map(card => card.price)) : 0;
    const recommendedBudget = fallback.reached ? fallback.missing.reduce((sum, card) => sum + cardCeiling(card.price, 15_000_000), 0) : 0;
    const configuredMax = Number(controls.maxPrice.value);
    const eligible = ids.filter(id => Number(scores[id]) > 0);
    const ownedCount = Math.min(row.cards, eligible.filter(id => collected.has(id)).length);
    const pricedInLimit = eligible.filter(id => !collected.has(id) && Number.isSafeInteger(Number(priceAnswer.prices[id])) && Number(priceAnswer.prices[id]) > 0 && Number(priceAnswer.prices[id]) <= configuredMax);
    const aboveLimit = eligible.filter(id => !collected.has(id) && Number.isSafeInteger(Number(priceAnswer.prices[id])) && Number(priceAnswer.prices[id]) > configuredMax).sort((a, b) => Number(priceAnswer.prices[a]) - Number(priceAnswer.prices[b]));
    const withoutMarket = eligible.filter(id => !collected.has(id) && !(Number.isSafeInteger(Number(priceAnswer.prices[id])) && Number(priceAnswer.prices[id]) > 0));
    const cardLabel = id => names[id] || `Карта #${id}${cardAnswer.cards[id]?.rating ? ` · рейтинг ${cardAnswer.cards[id].rating}` : ''}`;
    result.append(el('div', {class: 'fcgh-grade-summary', text: `Выбран грейд ${letter}: цель ${format(target.threshold)} очков, состав из ${row.cards} карт.`}));
    result.append(el('div', {class: 'fcgh-plan-overview'}, [
      el('b', {text: `Для грейда ${letter} нужно закрыть ${row.cards} мест.`}),
      el('span', {text: `Уже засчитано: ${ownedCount}. Доступно для покупки до ${format(configuredMax)}: ${pricedInLimit.length}.`}),
      el('span', {text: `Минимально не хватает по количеству: ${Math.max(0, row.cards - ownedCount - pricedInLimit.length)}.`})
    ]));
    const verdict = currentPlan.reached
      ? `План ${letter} готов: ${format(currentPlan.score)} очков, до ${format(currentPlan.cost)} монет`
      : fallback.reached
        ? `Чтобы закрыть грейд ${letter}, подними потолок с ${format(configuredMax)} до ${format(recommendedMax)} монет. Ориентировочный бюджет — ${format(fallback.cost)}, безопасный предел — ${format(recommendedBudget)}.`
      : currentPlan.reason === 'not-enough-cards'
        ? `В лимите найдено ${currentPlan.available} из необходимых ${currentPlan.needed} карт. Увеличь «Не дороже» или сначала найди свои карты.`
        : `Грейд недостижим в лимитах. Максимум ${format(currentPlan.score)} очков.`;
    result.append(el('div', {class: currentPlan.reached ? 'fcgh-plan-ok' : 'fcgh-plan-bad', text: verdict}));
    if (!currentPlan.reached && fallback.reached) {
      const use = el('button', {class: 'fcgh-use-limits', text: `Подставить потолок ${format(recommendedMax)} и бюджет ${format(recommendedBudget)}`});
      use.onclick = () => { controls.maxPrice.value = recommendedMax; controls.budget.value = recommendedBudget; use.textContent = 'Лимиты подставлены — нажми «2. Составить план»'; use.disabled = true; };
      result.append(use);
    }
    const shownPlan = currentPlan.reached ? currentPlan : (fallback.reached ? fallback : currentPlan);
    if (shownPlan.missing.length) result.append(el('strong', {text: `Конкретные карты для грейда ${letter}: купить ${shownPlan.missing.length}`}));
    const list = el('ol', {class: 'fcgh-plan'});
    for (const card of shownPlan.missing) {
      const ceiling = currentPlan.reached ? Number(controls.maxPrice.value) : Math.max(recommendedMax, card.price);
      list.append(el('li', {'data-card-id': String(card.id)}, [el('b', {text: names[card.id] || '#' + card.id}), el('span', {text: ` — ожидаемая цена ${format(card.price)}, искать самый дешёвый лот до ${format(ceiling)} · ${format(card.score)} очков`})]));
    }
    result.append(list);
    if (!currentPlan.reached && !fallback.reached) {
      const diagnostic = el('div', {class: 'fcgh-diagnostics'});
      diagnostic.append(el('b', {text: 'Почему точный план пока не собран:'}));
      if (aboveLimit.length) {
        diagnostic.append(el('span', {text: `Выше вашего потолка ${format(configuredMax)} монет:`}));
        const expensive = el('ul');
        for (const id of aboveLimit.slice(0, 10)) expensive.append(el('li', {text: `${cardLabel(id)} — около ${format(priceAnswer.prices[id])} монет, ${format(scores[id])} очков`}));
        diagnostic.append(expensive);
      }
      if (withoutMarket.length) {
        diagnostic.append(el('span', {text: `Нет актуальной цены или лота (${withoutMarket.length}):`}));
        const unavailable = el('ul');
        for (const id of withoutMarket.slice(0, 10)) unavailable.append(el('li', {text: `${cardLabel(id)} — сейчас нельзя включить в план`}));
        diagnostic.append(unavailable);
      }
      if (!aboveLimit.length && !withoutMarket.length) diagnostic.append(el('span', {text: `Карточек по количеству хватает, но их очков недостаточно для порога ${format(target.threshold)}.`}));
      result.append(diagnostic);
    }
    status.textContent = currentPlan.reached
      ? `План ${letter}: уже засчитано ${shownPlan.lineup.filter(x => x.collected).length}, докупить ${shownPlan.missing.length}. Для каждого игрока поиск идёт от минимальной цены до указанного общего потолка.`
      : fallback.reached
        ? `Для грейда ${letter} докупить ${shownPlan.missing.length} карт. Нажми кнопку подстановки лимитов, затем ещё раз «2. Составить план».`
        : `Для грейда ${letter} сейчас доступно ${ownedCount + pricedInLimit.length} из ${row.cards} необходимых карт. Ниже показано, какие карты дороже лимита или отсутствуют на рынке.`;
  }
  async function execute(controls, status, result, start, stop) {
    if (running) return; if (!currentPlan?.reached || !currentPlan.missing.length) throw new Error('Сначала рассчитай достижимый план с недостающими картами');
    const maxPrice = Number(controls.maxPrice.value), maxSpend = Number(controls.budget.value), mode = controls.after.value, discount = Number(controls.discount.value), purchaseMode = controls.purchaseMode.value;
    if (!Number.isSafeInteger(maxPrice) || maxPrice < 150 || !Number.isSafeInteger(maxSpend) || maxSpend <= 0) throw new Error('Проверь лимиты цены и расходов');
    const meta = currentPlan.meta, planning = currentPlan.planning;
    if (!planning?.pool?.length || !Number.isFinite(planning.target)) throw new Error('Пересчитай план для выбранного грейда');
    const review = currentPlan.missing.map(card => `${names[card.id] || '#' + card.id}: ориентир ${format(card.price)}, искать самый дешёвый лот до ${format(maxPrice)}`).join('\n');
    const modeNotice = purchaseMode === 'auto'
      ? '\n\nВНИМАНИЕ: автоматические покупки нарушают правила EA и выполняются на ваш риск.'
      : '\n\nПолуавтоматический режим: найденный лот будет куплен только после отдельного подтверждения.';
    if (!confirm(`План покупки:\n${review}\n\nОбщие расходы не больше ${format(maxSpend)} монет. Перед каждой покупкой будет выбран самый дешёвый BIN.${modeNotice}\n\nПродолжить?`)) return;
    running = true; start.disabled = true; stop.disabled = false; let spent = 0, bought = 0, listed = 0, quicksold = 0;
    const unavailable = new Set();
    let queue = [...currentPlan.missing];
    const replaceCard = failedCard => {
      unavailable.add(failedCard.id);
      const replacement = GalleryCore.galleryPlan({pool: planning.pool.filter(id => !unavailable.has(id)), slots: planning.slots, target: planning.target, collected: [...collected], scores, prices: planning.prices, maxPrice, budget: Math.max(0, maxSpend - spent)});
      if (!replacement.reached) return false;
      currentPlan = {...replacement, meta, planning};
      queue = replacement.missing.filter(card => !unavailable.has(card.id) && !collected.has(card.id));
      const list = result.querySelector('.fcgh-plan');
      for (const card of queue) if (list && !list.querySelector(`li[data-card-id="${card.id}"]`)) {
        const ceiling = maxPrice;
        list.append(el('li', {'data-card-id': String(card.id), class: 'fcgh-replacement'}, [el('b', {text: names[card.id] || '#' + card.id}), el('span', {text: ` — ЗАМЕНА · ожидаемая цена ${format(card.price)}, искать самый дешёвый лот до ${format(ceiling)} · ${format(card.score)} очков`})]));
      }
      result.prepend(el('div', {class: 'fcgh-run-summary', text: `Для грейда ${meta.letter} план пересчитан без карты ${names[failedCard.id] || '#' + failedCard.id}. Новых покупок в очереди: ${queue.length}.` }));
      return true;
    };
    try {
      while (queue.length) {
        const card = queue.shift();
        if (!running) break; const remaining = maxSpend - spent, ceiling = Math.min(maxPrice, remaining); if (ceiling < 150) { status.textContent = 'Остановлено: достигнут лимит расходов.'; break; }
        const cardName = names[card.id] || '#' + card.id;
        status.textContent = `Ищу ${cardName} до ${format(ceiling)}…`;
        const line = result.querySelector(`li[data-card-id="${card.id}"]`);
        const purchase = await findAndBuy({defId: card.id, name: cardName, ceiling, purchaseMode, status});
        if (purchase.found?.name) names[card.id] = purchase.found.name;
        if (purchase.state === 'not-found' || purchase.state === 'skipped' || purchase.state === 'rejected') {
          const reason = purchase.state === 'not-found' ? 'НЕТ ЛОТА' : purchase.state === 'skipped' ? 'ПРОПУЩЕНО' : 'EA ОТКЛОНИЛА ЛОТЫ';
          if (line) { line.classList.add('fcgh-missed'); line.append(` — ${reason}`); }
          if (!replaceCard(card)) { status.textContent = `Для ${names[card.id] || cardName} не найдено подходящей замены, сохраняющей грейд ${meta.letter} в заданных лимитах. Покупки остановлены.`; break; }
          status.textContent = `${names[card.id] || cardName} заменён другой картой. Продолжаю план грейда ${meta.letter}.`;
          await sleep(750);
          continue;
        }
        const receipt = purchase.receipt; if (!receipt.item?.handle) throw new Error('Покупка могла пройти, но EA не показала предмет в PURCHASED. Проверь непринятые вручную; повтор не выполнялся.');
        spent += receipt.price; bought++; collected.add(card.id); await saveCollected(); if (line) { line.classList.add('fcgh-bought'); line.append(` — КУПЛЕНО ЗА ${format(receipt.price)}`); }
        if (mode === 'list') {
          status.textContent = `Проверяю новый минимальный BIN для ${names[card.id] || '#' + card.id}…`;
          await sleep(900);
          const resale = await bridge('search', {defId: card.id, maxBuy: 15_000_000}, 45_000).catch(() => null);
          if (resale?.found) {
            status.textContent = `Минимум рынка ${format(resale.price)}. Выставляю на ${discount}% ниже…`;
            try {
              const sale = await bridge('list', {handle: receipt.item.handle, reference: resale.price, discount}, 45_000);
              listed++; if (line) line.append(` — ВЫСТАВЛЕНО ЗА ${format(sale.buyNow)}`);
            } catch (error) {
              if (!/\b461\b/.test(String(error?.message || error))) throw error;
              status.textContent = 'EA не разрешает такую цену (ошибка 461). Выполняю быструю продажу…';
              const sold = await bridge('quicksell', {handle: receipt.item.handle}, 45_000);
              quicksold++;
              if (line) line.append(` — БЫСТРАЯ ПРОДАЖА${sold.discardValue ? ` ЗА ${format(sold.discardValue)}` : ''}`);
            }
          } else {
            await bridge('move', {handle: receipt.item.handle, destination: 'transfer'}, 45_000);
            if (line) line.append(' — ЦЕНА РЫНКА НЕ НАЙДЕНА, ОСТАВЛЕНО В ТРАНСФЕР-ЛИСТЕ');
          }
        }
        else await bridge('move', {handle: receipt.item.handle, destination: mode}, 45_000);
        status.textContent = `Грейд ${meta.letter}: куплено ${bought}, в очереди ${queue.length}; потрачено ${format(spent)}; выставлено ${listed}; быстро продано ${quicksold}.`; await sleep(1400 + Math.floor(Math.random() * 900));
      }
    } finally { running = false; start.disabled = false; stop.disabled = true; result.prepend(el('div', {class: 'fcgh-run-summary', text: `Итог грейда ${meta.letter}: куплено ${bought}, потрачено ${format(spent)}, выставлено ${listed}, быстро продано ${quicksold}. Теперь нажми «1. Найти мои карты», затем «2. Составить план», чтобы проверить результат.`})); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();
})();
