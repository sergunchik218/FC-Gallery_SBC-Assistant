(() => {
  const CHANNEL = 'fcgh-v1', pending = new Map();
  const BRIDGE_VERSION = '3.0.2';
  let callId = 0, catalog = null, sets = [], currentPlan = null, sbcPlan = null, running = false, persona = 'default';
  const collected = new Set(), galleryVerified = new Set(), gallerySyncAt = new Map(), scores = {}, names = {}, collectedSources = {};
  let operation = false, stopRequested = false, ready = false, dashboardUI = null, canUndoSbc = false;
  const checkedAt = {}, purchaseLog = [];
  const dateTime = value => value ? new Date(value).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : 'ещё не проверено';
  const format = value => Number(value || 0).toLocaleString('ru-RU');
  const sourceLabel = id => ({'ea-gallery': 'подтверждено EA Gallery', club: 'найдено в клубе', purchase: 'куплено помощником'})[collectedSources[id]] || 'сохранено в локальной истории';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cardCeiling = (price, globalMax) => Math.min(Number(globalMax), Math.floor(Number(price) * 1.10));
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
  async function catalogBatch(type, ids, platform) {
    const answer = {prices: {}, cards: {}, at: null};
    for (let at = 0; at < ids.length; at += 8000) {
      const page = await runtime({type, ids: ids.slice(at, at + 8000), platform});
      Object.assign(answer.prices, page.prices || {}); Object.assign(answer.cards, page.cards || {});
      if (page.at) answer.at = answer.at == null ? page.at : Math.min(answer.at, page.at);
    }
    return answer;
  }
  function label(text, control) { return el('label', {}, [el('span', {text}), control]); }
  function fail(status, error) { status.className = 'fcgh-error'; status.textContent = error?.message || String(error); }
  const eaRefused = error => /\b461\b/.test(String(error?.message || error));
  async function findAndBuy({defId, name, ceiling, purchaseMode, status, platform = 'ps5', reference = null, referenceAt = 0}) {
    if (stopRequested) return {state: 'stopped'};
    const unassigned = await bridge('unassigned', {defId}, 45_000);
    if (unassigned.items?.length) return {state: 'owned'};
    const quote = await runtime({type: 'fcgh.prices', platform, ids: [defId]}).catch(() => null);
    const fresh = Number(quote?.prices?.[defId]);
    if (fresh > 0 && !GalleryCore.priceRisk(fresh, fresh, quote.at).manual) {
      if (GalleryCore.priceRisk(reference, reference, referenceAt).reason === 'unknown' || fresh < reference) { reference = fresh; referenceAt = quote.at; }
    }
    const excludedTradeIds = [], attempts = purchaseMode === 'confirm' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = await bridge('search', {defId, maxBuy: ceiling, excludeTradeIds: excludedTradeIds}, 45_000);
      if (stopRequested) return {state: 'stopped'};
      if (!found.found) return {state: 'not-found'};
      const shownName = found.name || name || `#${defId}`;
      const risk = GalleryCore.priceRisk(found.price, reference, referenceAt);
      const priceNote = risk.reason === 'unknown' ? 'Нет свежего ценового ориентира. Автоматическая покупка запрещена: проверь цену вручную.' : `Ориентир этой карты: ${format(reference)} (${dateTime(referenceAt)})\nРазница: ${risk.premium > 0 ? '+' : ''}${risk.premium.toFixed(1)}%\nБез предупреждения: до ${format(Math.floor(reference * 1.1))} монет.`;
      const warning = risk.reason === 'overpay' ? 'ПЕРЕПЛАТА БОЛЕЕ 10% — требуется ваше подтверждение\n\n' : '';
      if ((purchaseMode === 'confirm' || risk.manual) && !confirm(`${warning}${shownName}\nЛот EA: ${format(found.price)} монет\n${priceNote}\nЖёсткий лимит: ${format(ceiling)}\n\nКупить именно этот лот?\n«Отмена» — не покупать; для Gallery будет подобрана замена.`)) {
        await recordPurchase({defId, name: shownName, price: found.price, reference: risk.reference, state: 'skipped', reason: risk.reason});
        return {state: 'skipped', found};
      }
      if (stopRequested) return {state: 'stopped'};
      status.textContent = `Покупаю ${shownName} за ${format(found.price)}…`;
      try {
        const receipt = await bridge('buy', {handle: found.handle, ceiling}, 45_000);
        // Every successful purchase also counts permanently towards Gallery, including SBC purchases.
        collected.add(Number(defId)); collectedSources[Number(defId)] = 'purchase'; await saveCollected();
        await recordPurchase({defId, name: shownName, price: receipt.price, reference: risk.reference, state: 'bought', reason: risk.reason});
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
    const head = el('div', {class: 'fcgh-head'}, [el('div', {class: 'fcgh-brand'}, [el('span', {class: 'fcgh-logo', text: 'FC'}), el('div', {}, [el('h2', {text: 'Gallery Assistant'}), el('small', {id: 'fcgh-connection', text: 'Подключение к EA…'})])]), el('div', {class: 'fcgh-version', text: 'V3'}), el('button', {class: 'fcgh-close', text: '×', 'aria-label': 'Закрыть помощник'})]);
    const category = el('select', {id: 'fcgh-category'}), set = el('select', {id: 'fcgh-set'}), grade = el('select', {id: 'fcgh-grade'});
    const platform = el('select', {id: 'fcgh-platform'}, [el('option', {value: 'ps5', text: 'Console / PS5'}), el('option', {value: 'pc', text: 'PC'})]);
    const maxPrice = el('input', {id: 'fcgh-max', type: 'number', min: '150', value: '1000'}), budget = el('input', {id: 'fcgh-budget', type: 'number', min: '0', value: '10000'}), discount = el('input', {id: 'fcgh-discount', type: 'number', min: '0', max: '20', value: '5'});
    const after = el('select', {id: 'fcgh-after'}, [el('option', {value: 'club', text: 'Оставить в клубе'}), el('option', {value: 'transfer', text: 'В трансфер-лист'}), el('option', {value: 'list', text: 'Выставить по минимуму рынка'})]);
    const purchaseMode = el('select', {id: 'fcgh-purchase-mode'}, [el('option', {value: 'confirm', text: 'Полуавтомат: Да / Нет'}), el('option', {value: 'auto', text: 'Автоматически — на свой риск'})]);
    const targetForm = el('div', {class: 'fcgh-form fcgh-target-form'}, [label('Категория Gallery', category), label('Команда или набор', set), label('Целевой тир', grade)]);
    const limitForm = el('div', {class: 'fcgh-form'}, [label('Платформа цен', platform), label('Максимум за карту', maxPrice), label('Общий бюджет', budget)]);
    const behaviorForm = el('div', {class: 'fcgh-form'}, [label('Подтверждение покупки', purchaseMode), label('Куда отправить карту', after), label('Скидка при продаже, %', discount)]);
    const sync = el('button', {text: '1. Синхронизировать Gallery'}), plan = el('button', {text: '2. Составить план', class: 'fcgh-primary'}), start = el('button', {text: '3. Купить по плану', class: 'fcgh-danger'}), stop = el('button', {text: 'Стоп', class: 'fcgh-secondary'}); stop.disabled = true;
    const status = el('div', {id: 'fcgh-status', text: 'Загружаю каталог…'}), result = el('div', {id: 'fcgh-result'});
    const galleryBody = el('div', {class: 'fcgh-body'}, [
      el('div', {class: 'fcgh-page-title'}, [el('div', {}, [el('span', {class: 'fcgh-eyebrow', text: 'ПЛАНИРОВЩИК ПОКУПОК'}), el('h3', {text: 'Соберите следующий тир без путаницы'}), el('p', {text: 'Сначала проверяем историю Gallery и клуб, затем показываем каждую карту, её очки, ориентир цены и жёсткий лимит.'})])]),
      el('div', {class: 'fcgh-stepper', id: 'fcgh-steps'}, [el('span', {text: '1  Коллекция'}), el('span', {text: '2  Цель'}), el('span', {text: '3  План'}), el('span', {text: '4  Покупка'})]),
      el('section', {class: 'fcgh-config-card'}, [el('h4', {text: '1. Что собираем'}), targetForm]),
      el('section', {class: 'fcgh-config-card'}, [el('h4', {text: '2. Лимиты расходов'}), limitForm]),
      el('section', {class: 'fcgh-config-card'}, [el('h4', {text: '3. Поведение покупки'}), behaviorForm]),
      el('div', {class: 'fcgh-price-policy', text: 'Защита цены включена всегда: неизвестная цена и переплата более 10% требуют ручного подтверждения. Расширение никогда не превышает лимит карты и общий бюджет.'}),
      el('div', {class: 'fcgh-actions fcgh-main-actions'}, [sync, plan]), status, result, el('div', {class: 'fcgh-actions fcgh-buy-actions'}, [start, stop]),
      el('p', {class: 'fcgh-risk', text: 'Автоматизация рынка может нарушать правила EA. Полуавтоматический режим безопаснее: вы подтверждаете каждый найденный лот.'})
    ]);
    start.id = 'fcgh-buy'; stop.id = 'fcgh-stop'; stop.dataset.stop = 'true';
    plan.id = 'fcgh-plan-button'; sync.id = 'fcgh-sync-button';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');

    const sbcUrl = el('input', {id: 'fcgh-sbc-url', type: 'url', placeholder: 'https://www.futbin.com/27/squad/…/sbc'});
    const sbcPlatform = el('select', {id: 'fcgh-sbc-platform'}, [el('option', {value: 'ps5', text: 'Console / PS5'}), el('option', {value: 'pc', text: 'PC'})]);
    const sbcMax = el('input', {id: 'fcgh-sbc-max', type: 'number', min: '150', value: '2000'}), sbcBudget = el('input', {id: 'fcgh-sbc-budget', type: 'number', min: '0', value: '25000'});
    const sbcPurchaseMode = el('select', {id: 'fcgh-sbc-purchase-mode'}, [el('option', {value: 'confirm', text: 'Полуавтомат: Да / Нет'}), el('option', {value: 'auto', text: 'Автоматически — на свой риск'})]);
    const sbcImport = el('button', {text: '1. Импорт FUTBIN'}), sbcScan = el('button', {text: '2. Проверить клуб', class: 'fcgh-primary'}), sbcBuy = el('button', {text: '3. Купить недостающих', class: 'fcgh-danger'}), sbcStop = el('button', {text: 'Стоп', class: 'fcgh-secondary'}), sbcFill = el('button', {text: '4. Расставить в открытый ИПК', class: 'fcgh-primary'}), sbcUndo = el('button', {text: 'Отменить расстановку', class: 'fcgh-secondary'}); sbcStop.disabled = true; sbcUndo.disabled = true;
    const sbcStatus = el('div', {id: 'fcgh-sbc-status', text: 'Вставь ссылку на готовый состав FUTBIN.'}), sbcResult = el('div', {id: 'fcgh-sbc-result'});
    const sbcBody = el('div', {class: 'fcgh-body'}); sbcBody.hidden = true;
    sbcBody.append(el('p', {class: 'fcgh-guide', text: 'Открой на FUTBIN готовую сборку ИПК, скопируй её ссылку и вставь ниже. После покупки открой нужное испытание в EA и нажми кнопку расстановки.'}), label('Ссылка на сборку FUTBIN', sbcUrl), el('div', {class: 'fcgh-form'}, [label('Цены', sbcPlatform), label('Потолок за 1 карту', sbcMax), label('Общий бюджет', sbcBudget), label('Режим покупки', sbcPurchaseMode)]), el('div', {class: 'fcgh-actions'}, [sbcImport, sbcScan]), sbcStatus, sbcResult, el('div', {class: 'fcgh-actions'}, [sbcBuy, sbcStop]), el('div', {class: 'fcgh-actions'}, [sbcFill, sbcUndo]), el('p', {class: 'fcgh-risk', text: 'Расстановка заменяет игроков на открытом поле и сохраняет состав, но не сдаёт его. Проверь требования EA и сам нажми «Подтвердить».'}));
    sbcBuy.id = 'fcgh-sbc-buy'; sbcScan.id = 'fcgh-sbc-scan'; sbcFill.id = 'fcgh-sbc-fill';
    sbcStop.dataset.stop = 'true'; sbcUndo.id = 'fcgh-sbc-undo';
    const overviewTab = el('button', {class: 'fcgh-tab active', text: '▦  Коллекция'}), galleryTab = el('button', {class: 'fcgh-tab', text: '◎  План покупки'}), sbcTab = el('button', {class: 'fcgh-tab', text: '◇  ИПК'}), tabs = el('div', {class: 'fcgh-tabs'}, [overviewTab, galleryTab, sbcTab]);
    const overviewBody = el('div', {class: 'fcgh-body fcgh-overview'});
    panel.append(head, tabs, overviewBody, galleryBody, sbcBody);
    root.append(toggle, panel); document.documentElement.append(root);
    const open = value => { panel.hidden = !value; toggle.setAttribute('aria-expanded', String(value)); };
    toggle.onclick = () => open(panel.hidden); head.querySelector('.fcgh-close').onclick = () => open(false);
    const showTab = kind => { overviewBody.hidden = kind !== 'overview'; galleryBody.hidden = kind !== 'gallery'; sbcBody.hidden = kind !== 'sbc'; overviewTab.classList.toggle('active', kind === 'overview'); galleryTab.classList.toggle('active', kind === 'gallery'); sbcTab.classList.toggle('active', kind === 'sbc'); };
    overviewTab.onclick = () => showTab('overview'); galleryTab.onclick = () => showTab('gallery'); sbcTab.onclick = () => showTab('sbc');
    mountDashboard(overviewBody, (row, letter) => {
      category.value = row.categoryId; fillSets(category.value, set, grade); set.value = row.id; fillGrades(row.id, grade);
      grade.value = letter || GalleryCore.galleryProgress({...row, slots: row.cards, collected: [...collected], scores}).next?.letter || row.grades.at(-1).letter;
      renderProgress(row, result); status.textContent = `Цель: ${row.name}, тир ${grade.value}. Нажмите «2. Составить план»: недостающие данные обновятся автоматически.`;
      showTab('gallery');
    });
    showTab('overview');
    category.onchange = () => fillSets(category.value, set, grade); set.onchange = () => fillGrades(set.value, grade);
    sync.onclick = () => syncSet(set.value, status, result).catch(error => fail(status, error));
    plan.onclick = async () => {
      try {
        await syncSets([selectedSet(set.value)], status, false);
        if (stopRequested) return;
        await calculate(set.value, grade.value, {platform, maxPrice, budget, start}, status, result);
      } catch (error) { fail(status, error); }
    };
    start.onclick = () => execute({maxPrice, budget, after, discount, purchaseMode}, status, result, start, stop).catch(error => fail(status, error));
    stop.onclick = () => { stopRequested = true; running = false; status.textContent = 'Останавливаю после текущего запроса…'; };
    sbcImport.onclick = () => importSbc(sbcUrl.value, {platform: sbcPlatform}, sbcStatus, sbcResult).catch(error => fail(sbcStatus, error));
    sbcScan.onclick = () => scanSbcClub({platform: sbcPlatform, maxPrice: sbcMax, budget: sbcBudget}, sbcStatus, sbcResult).catch(error => fail(sbcStatus, error));
    sbcBuy.onclick = () => buySbc({maxPrice: sbcMax, budget: sbcBudget, purchaseMode: sbcPurchaseMode}, sbcStatus, sbcResult, sbcBuy, sbcStop).catch(error => fail(sbcStatus, error));
    sbcStop.onclick = () => { stopRequested = true; running = false; sbcStatus.textContent = 'Останавливаю после текущего запроса…'; };
    sbcFill.onclick = () => placeSbc(sbcStatus, sbcResult, sbcFill, sbcUndo).catch(error => fail(sbcStatus, error));
    sbcUndo.onclick = () => undoSbc(sbcStatus, sbcUndo).catch(error => fail(sbcStatus, error));
    for (const button of [sync, plan, start, sbcImport, sbcScan, sbcBuy, sbcFill, sbcUndo]) {
      const action = button.onclick;
      button.onclick = () => runOperation(() => action(), button === sync ? 'sync' : 'action');
    }
    for (const control of [grade, platform, maxPrice, budget]) control.onchange = () => invalidatePlan();
    for (const control of [sbcPlatform, sbcMax, sbcBudget]) control.onchange = () => { if (sbcPlan) sbcPlan.scanned = false; updateControls(); sbcStatus.textContent = 'Параметры изменены. Повторите проверку клуба и цен.'; };
    initialize(category, set, grade, status).then(() => { ready = true; renderDashboard(); updateControls(); }).catch(error => { fail(status, error); dashboardUI.status.textContent = error.message; });
    updateControls();
  }
  function invalidatePlan() {
    currentPlan = null;
    document.getElementById('fcgh-result')?.replaceChildren();
    const status = document.getElementById('fcgh-status');
    if (status && ready) status.textContent = 'Параметры изменены. Составьте новый план перед покупкой.';
    updateControls();
  }
  function updateControls() {
    const root = document.getElementById('fcgh-root'); if (!root) return;
    for (const node of root.querySelectorAll('button, input, select')) {
      if (node.id === 'fcgh-toggle' || node.classList.contains('fcgh-close') || node.classList.contains('fcgh-tab')) continue;
      if (node.dataset.stop) { node.disabled = !operation; continue; }
      node.disabled = !ready || operation;
    }
    const setDisabled = (id, disabled) => { const node = document.getElementById(id); if (node) node.disabled = !ready || operation || disabled; };
    setDisabled('fcgh-buy', !currentPlan?.missing?.length || (currentPlan.selectedIds && currentPlan.selectedIds.size === 0));
    setDisabled('fcgh-sbc-buy', !sbcPlan?.scanned || !sbcPlan.missing.length);
    setDisabled('fcgh-sbc-scan', !sbcPlan);
    setDisabled('fcgh-sbc-fill', !sbcPlan?.scanned || sbcPlan.missing.length > 0);
    setDisabled('fcgh-sbc-undo', !canUndoSbc);
  }
  async function runOperation(action, kind = 'action') {
    if (operation || !ready) return;
    operation = true; stopRequested = false; updateControls();
    try { return await action(); }
    catch (error) { if (dashboardUI) fail(dashboardUI.status, error); }
    finally { operation = false; updateControls(); renderDashboard(); }
  }
  function mountDashboard(body, openSet) {
    const search = el('input', {type: 'search', placeholder: 'Найти команду или набор…', 'aria-label': 'Поиск наборов'});
    const category = el('select', {'aria-label': 'Категория коллекции'}, [el('option', {value: '', text: 'Все категории'})]);
    const filter = el('select', {'aria-label': 'Статус набора'}, [el('option', {value: '', text: 'Все наборы'}), el('option', {value: 'no-tier', text: 'Тир ещё не собран'}), el('option', {value: 'upgrade', text: 'Можно повысить тир'}), el('option', {value: 'complete', text: 'Все тиры собраны'}), el('option', {value: 'unknown', text: 'Нужна синхронизация'})]);
    const syncAll = el('button', {class: 'fcgh-primary', text: 'Обновить всю коллекцию'}), syncCategory = el('button', {text: 'Обновить категорию'}), stop = el('button', {'data-stop': 'true', text: 'Остановить'});
    const force = el('input', {type: 'checkbox'});
    const status = el('div', {class: 'fcgh-sync-status', role: 'status', 'aria-live': 'polite', text: 'Загружаем вашу историю…'});
    const progress = el('progress', {max: '100', value: '0', 'aria-label': 'Прогресс синхронизации'}); progress.hidden = true;
    const stats = el('div', {class: 'fcgh-collection-stats'}), categories = el('div', {class: 'fcgh-category-strip'}), grid = el('div', {class: 'fcgh-set-grid'}), log = el('details', {class: 'fcgh-journal'});
    log.append(el('summary', {text: 'История покупок и пропусков'}), el('div', {id: 'fcgh-purchase-log'}));
    const help = el('details', {class: 'fcgh-help'}, [el('summary', {text: 'Первый запуск? Как пользоваться'}), el('ol', {}, [el('li', {text: 'Нажмите «Обновить всю коллекцию». Это только проверка: монеты не тратятся. Её можно остановить и продолжить.'}), el('li', {text: 'Зелёные тиры уже собраны. Серые ещё не подтверждены. «Не проверено» не означает, что набор пуст.'}), el('li', {text: 'Нажмите «План до…» у команды. Укажите бюджет, проверьте список покупок и альтернативы.'}), el('li', {text: 'Начните покупку. Лот дороже ориентира более чем на 10% всегда потребует вашего разрешения.'})])]);
    const syncOptions = el('details', {class: 'fcgh-sync-options'}, [el('summary', {text: 'Параметры синхронизации'}), el('label', {class: 'fcgh-force-label'}, [force, ' Полная перепроверка, включая свежие данные']), el('div', {class: 'fcgh-actions'}, [syncCategory])]);
    body.append(el('div', {class: 'fcgh-page-title'}, [el('div', {}, [el('span', {class: 'fcgh-eyebrow', text: 'GALLERY FC 27'}), el('h3', {text: 'Ваша коллекция'}), el('p', {text: 'Актуальные лиги и команды видны отдельными разделами. Выберите лигу — ниже останутся только её наборы.'})]), el('span', {class: 'fcgh-live-badge', text: '● Каталог V3'})]), stats, el('h4', {class: 'fcgh-section-title', text: 'Лиги и категории'}), categories, el('div', {class: 'fcgh-toolbar'}, [el('div', {class: 'fcgh-dashboard-filters'}, [search, category, filter]), el('div', {class: 'fcgh-actions'}, [syncAll, stop])]), syncOptions, progress, status, el('p', {class: 'fcgh-legend', text: '✓ Собрано навсегда · ◌ Ещё не подтверждено · Источники: EA Gallery + клуб + покупки помощника.'}), grid, help, log);
    dashboardUI = {search, category, filter, status, stats, categories, grid, progress, openSet};
    filter.append(...['D', 'C', 'B', 'A', 'S'].map(letter => el('option', {value: 'tier:' + letter, text: 'Текущий тир ' + letter})));
    search.oninput = renderDashboard; category.onchange = renderDashboard; filter.onchange = renderDashboard;
    syncAll.onclick = () => runOperation(() => syncSets(sets, status, force.checked), 'sync');
    syncCategory.onclick = () => runOperation(() => syncSets(sets.filter(row => !category.value || row.categoryId === category.value), status, force.checked), 'sync');
    stop.onclick = () => { stopRequested = true; running = false; status.textContent = 'Останавливаемся после текущего запроса. Прочитанные данные сохранятся.'; };
  }
  function renderDashboard() {
    if (!dashboardUI || !catalog) return;
    const ui = dashboardUI;
    const overview = sets.map(row => ({row, state: GalleryCore.setOverview(row, [...collected], scores, checkedAt)}));
    const categoryRows = [...new Map(sets.map(row => [row.categoryId, row.categoryName])).entries()].map(([id, name]) => ({id, name, count: sets.filter(row => row.categoryId === id).length}));
    ui.categories.replaceChildren();
    const allCategories = el('button', {class: !ui.category.value ? 'active' : '', text: `Все · ${sets.length}`});
    allCategories.onclick = () => { ui.category.value = ''; renderDashboard(); }; ui.categories.append(allCategories);
    for (const row of categoryRows) {
      const button = el('button', {class: ui.category.value === row.id ? 'active' : '', text: `${row.name} · ${row.count}`});
      button.onclick = () => { ui.category.value = row.id; renderDashboard(); }; ui.categories.append(button);
    }
    ui.stats.replaceChildren(...[
      [sets.length, 'наборов'], [overview.filter(x => x.state.current).length, 'собран хотя бы один тир'],
      [overview.filter(x => !x.state.next).length, 'максимальный тир'], [overview.filter(x => x.state.stale).length, 'нужна проверка']
    ].map(([number, title]) => el('div', {}, [el('b', {text: format(number)}), el('span', {text: title})])));
    const query = ui.search.value.trim().toLocaleLowerCase('ru-RU');
    const visible = overview.filter(({row, state}) => (!ui.category.value || row.categoryId === ui.category.value) && `${row.name} ${row.categoryName}`.toLocaleLowerCase('ru-RU').includes(query) && (!ui.filter.value || ui.filter.value === 'no-tier' && !state.current || ui.filter.value === 'complete' && !state.next || ui.filter.value === 'upgrade' && state.next || ui.filter.value === 'unknown' && state.stale || ui.filter.value === 'tier:' + state.current));
    ui.grid.replaceChildren();
    for (const {row, state} of visible) {
      const tile = el('article', {class: `fcgh-set-card${!state.next ? ' is-complete' : ''}`});
      tile.append(el('small', {text: row.categoryName}), el('h4', {text: row.name}), el('strong', {class: 'fcgh-current-tier', text: state.current ? `Тир ${state.current}${state.stale && state.next ? ' · минимум по истории' : ''}` : state.coverage === 'complete' ? 'Тир пока не собран' : 'Тир ещё не определён'}));
      const badges = el('div', {class: 'fcgh-tier-badges'});
      for (const grade of state.grades) {
        const badge = el('button', {class: grade.reached ? 'fcgh-tier complete' : 'fcgh-tier', text: `${grade.reached ? '✓' : '○'} ${grade.letter}`, title: `${format(grade.threshold)} очков · открыть план`, 'aria-label': `${row.name}, тир ${grade.letter}: ${grade.reached ? 'собран' : 'не подтверждён'}`});
        badge.disabled = operation; badge.onclick = () => { if (!operation) ui.openSet(row, grade.letter); }; badges.append(badge);
      }
      const percent = Math.min(100, Math.round(state.count / row.cards * 100));
      tile.append(badges, el('div', {class: 'fcgh-card-metrics'}, [el('b', {text: `${state.count}/${row.cards}`}), el('span', {text: `${format(state.score)} очков`})]), el('div', {class: 'fcgh-mini-progress'}, [el('i', {style: `width:${percent}%`})]), el('div', {class: 'fcgh-next-tier', text: !row.pool.length ? 'Новые карточки ещё загружаются в локальную базу' : state.next ? `До тира ${state.next.letter}: +${format(Math.max(0, state.next.threshold - state.score))} очков${state.count < row.cards ? ` · ${row.cards - state.count} мест` : ''}` : 'Все тиры собраны'}));
      tile.append(el('small', {class: state.stale ? 'fcgh-sync-warn' : 'fcgh-sync-ok', text: `${!state.next ? 'Все тиры подтверждены историей' : state.coverage === 'unknown' ? 'Не проверено' : state.coverage === 'partial' ? `Частично: ${state.verified}/${state.total} карт проверено` : state.stale ? 'Данные требуют обновления' : 'Данные актуальны'} · ${dateTime(state.lastAt)}`}));
      const action = el('button', {class: 'fcgh-open-set', text: state.next ? `План до ${state.next.letter} →` : 'Посмотреть набор'});
      action.disabled = operation || !row.pool.length; action.textContent = row.pool.length ? action.textContent : 'Ожидается база карточек'; action.onclick = () => { if (!operation && row.pool.length) ui.openSet(row); }; tile.append(action); ui.grid.append(tile);
    }
    if (!visible.length) ui.grid.append(el('p', {text: 'Нет наборов по выбранным фильтрам.'}));
    const log = document.getElementById('fcgh-purchase-log');
    if (log) log.replaceChildren(...(purchaseLog.length ? purchaseLog.slice(0, 30).map(entry => el('div', {class: 'fcgh-log-row', text: `${dateTime(entry.at)} · ${entry.name || '#' + entry.defId} · ${entry.state === 'bought' ? 'куплено' : 'пропущено'} · ${format(entry.price)}${entry.reference ? ` / ориентир ${format(entry.reference)}` : ' / без ориентира'}${entry.reason === 'overpay' ? ' · переплата >10%' : ''}`})) : [el('p', {text: 'Здесь появятся покупки и отклонённые предложения V3.'})]));
  }
  async function recordPurchase(entry) {
    purchaseLog.unshift({...entry, at: Date.now()}); purchaseLog.splice(100);
    await chrome.storage.local.set({[`fcghPurchases.${persona}`]: purchaseLog});
    renderDashboard();
  }
  async function saveSync() {
    await saveCollected();
    await chrome.storage.local.set({[`fcghSyncV3.${persona}`]: {checkedAt, scores, names, collectedSources}});
    renderDashboard();
  }
  async function syncSets(rows, status, force = false) {
    if (running) throw new Error('Сначала остановите покупку');
    const needsCheck = row => force || GalleryCore.galleryProgress({...row, slots: row.cards, collected: [...collected], scores}).next;
    const ordered = rows.filter(Boolean).filter(needsCheck).sort((a, b) => a.pool.length - b.pool.length);
    const ids = GalleryCore.syncQueue(ordered, checkedAt, [...collected], force);
    if (!ids.length) { status.textContent = 'Данные этих наборов актуальны. Можно составлять план.'; return; }
    invalidatePlan(); status.className = 'fcgh-sync-status';
    let checked = 0, unresolved = 0, unnecessary = 0, incompleteClub = 0;
    if (dashboardUI) { dashboardUI.progress.hidden = false; dashboardUI.progress.max = ids.length; dashboardUI.progress.value = 0; }
    for (let at = 0; at < ids.length && !stopRequested; at += 50) {
      const pendingIds = new Set(ordered.filter(needsCheck).flatMap(row => row.pool).map(Number));
      const portion = ids.slice(at, at + 50), batch = portion.filter(id => pendingIds.has(id));
      unnecessary += portion.length - batch.length;
      if (!batch.length) { if (dashboardUI) dashboardUI.progress.value = checked + unnecessary; continue; }
      status.textContent = `Проверяем уникальные карты: ${checked}/${ids.length}. Общие карты учитываются во всех наборах.`;
      const history = await bridge('sync', {ids: batch}, 45_000);
      const allowed = new Set(batch), verified = new Set();
      for (const item of history.items || []) {
        const id = Number(item.defId); if (!allowed.has(id)) continue;
        if (typeof item.collected === 'boolean') { galleryVerified.add(id); verified.add(id); }
        if (item.collected === true) { collected.add(id); collectedSources[id] = 'ea-gallery'; }
        if (Number.isFinite(item.score) && item.score > 0) scores[id] = item.score;
        if (item.name) names[id] = item.name;
      }
      // Persist Gallery before the next request: a club failure must not erase progress.
      await saveSync();
      if (stopRequested) break;
      await sleep(300);
      const clubAnswer = await bridge('club', {ids: batch}, 45_000);
      if (clubAnswer.complete === false) incompleteClub++;
      else for (const id of verified) checkedAt[id] = Date.now();
      for (const [rawId, count] of Object.entries(clubAnswer.counts || {})) {
        const id = Number(rawId); if (allowed.has(id) && Number(count) > 0) { collected.add(id); collectedSources[id] ||= 'club'; }
      }
      for (const item of clubAnswer.items || []) if (item.name) names[Number(item.defId)] = item.name;
      unresolved += batch.filter(id => (!verified.has(id) || clubAnswer.complete === false) && !collected.has(id)).length;
      checked += batch.length; await saveSync();
      if (dashboardUI) dashboardUI.progress.value = checked + unnecessary;
      if (at + 50 < ids.length && !stopRequested) await sleep(800);
    }
    for (const row of rows.filter(Boolean)) if (!GalleryCore.setOverview(row, [...collected], scores, checkedAt).stale) gallerySyncAt.set(row.id, Date.now());
    status.textContent = `${stopRequested ? 'Остановлено' : 'Проверка завершена'}: прочитано ${checked} из ${ids.length} карт${unnecessary ? `; ${unnecessary} больше не нужны — максимальные тиры уже собраны` : ''}. ${unresolved ? `EA не подтвердила ${unresolved} карт — повторим их при следующей проверке.` : 'Данные сохранены.'} ${stopRequested ? 'Нажмите обновление ещё раз, чтобы продолжить.' : 'Выберите команду и следующий тир.'}`;
    if (incompleteClub) status.textContent += ` Клуб проверен частично в ${incompleteClub} частях: EA повторила страницу или достигнут предел чтения. Найденные карты и история Gallery сохранены; отсутствие остальных карт не подтверждено. Перед покупкой они проверяются отдельно.`;
    renderDashboard();
  }
  const selectedSet = id => sets.find(row => row.id === id) || null;
  function fillSets(categoryId, setSelect, gradeSelect) {
    const list = sets.filter(row => row.categoryId === categoryId); setSelect.replaceChildren(...list.map(row => el('option', {value: row.id, text: row.name}))); fillGrades(setSelect.value, gradeSelect);
  }
  function fillGrades(setId, gradeSelect) {
    const row = selectedSet(setId); gradeSelect.replaceChildren(...((row?.grades || []).map(g => el('option', {value: g.letter, text: `${g.letter} — ${format(g.threshold)} очков`}))));
    invalidatePlan();
    if (row) gradeSelect.value = GalleryCore.galleryProgress({...row, slots: row.cards, collected: [...collected], scores}).next?.letter || row.grades.at(-1)?.letter;
    if (row) { const result = document.getElementById('fcgh-result'); if (result) renderProgress(row, result); }
  }
  function renderProgress(row, result) {
    result.querySelector('.fcgh-progress')?.remove();
    const progress = GalleryCore.galleryProgress({pool: row.pool, slots: row.cards, collected: [...collected], scores, grades: row.grades});
    const box = el('div', {class: 'fcgh-progress'});
    box.append(el('b', {text: `Собранный ранг: ${progress.current || 'ещё нет'} · ${format(progress.score)} очков · ${progress.count}/${row.cards} карт`}));
    const badges = el('div', {class: 'fcgh-tier-badges'});
    for (const grade of progress.grades) badges.append(el('span', {class: grade.reached ? 'fcgh-tier complete' : 'fcgh-tier', text: `${grade.reached ? '✓ ' : ''}${grade.letter} · ${format(grade.threshold)}`}));
    box.append(badges, el('div', {text: progress.next ? `До ${progress.next.letter}: ещё ${format(Math.max(0, progress.next.threshold - progress.score))} очков и ${Math.max(0, row.cards - progress.count)} незаполненных мест. При заполненных местах нужны карты с большим Item Score.` : 'Все ранги этого набора собраны.'}));
    box.append(el('small', {text: 'Расчёт по лучшим собранным картам: история Gallery, покупки помощника и клуб.'}));
    result.prepend(box);
    const select = document.getElementById('fcgh-grade');
    if (document.getElementById('fcgh-set')?.value === row.id) for (const option of select?.options || []) {
      const grade = progress.grades.find(g => g.letter === option.value);
      if (grade) option.textContent = `${grade.reached ? '✓ Собран ' : ''}${grade.letter} — ${format(grade.threshold)} очков`;
    }
  }
  async function initialize(categorySelect, setSelect, gradeSelect, status) {
    let connected = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      connected = await bridge('status').catch(() => null);
      if (connected?.ready && connected.bridgeVersion !== BRIDGE_VERSION) throw new Error('В странице остался код старой версии расширения. Полностью закрой вкладку EA и открой её заново.');
      if (connected?.ready && connected.capture && connected.persona) break;
      await sleep(500);
    }
    if (!connected?.ready) throw new Error('EA Web App не загрузился. Войди в Ultimate Team и обнови страницу.');
    if (!connected.persona) throw new Error('EA ещё не определила ваш профиль. Полностью войдите в Ultimate Team и обновите вкладку: история разных аккаунтов не должна смешиваться.');
    persona = connected.persona; document.getElementById('fcgh-connection').textContent = `EA подключена${Number.isFinite(connected.coins) ? ` · ${format(connected.coins)} монет` : ''}`;
    const memory = await chrome.storage.local.get(`fcghCollected.${persona}`); for (const id of memory[`fcghCollected.${persona}`] || []) collected.add(Number(id));
    const saved = await chrome.storage.local.get([`fcghSyncV3.${persona}`, `fcghSyncV2.${persona}`, `fcghPurchases.${persona}`]);
    const syncState = saved[`fcghSyncV3.${persona}`] || saved[`fcghSyncV2.${persona}`] || {};
    Object.assign(checkedAt, syncState.checkedAt || {}); Object.assign(names, syncState.names || {}); Object.assign(collectedSources, syncState.collectedSources || {});
    purchaseLog.push(...(saved[`fcghPurchases.${persona}`] || []).slice(0, 100));
    catalog = (await runtime({type: 'fcgh.catalog'})).data; sets = [];
    for (const category of catalog.categories || []) for (const row of category.sets || []) sets.push({...row, categoryId: category.id, categoryName: category.name});
    for (const [id, score] of Object.entries(catalog.cardScores || {})) scores[id] = Number(score);
    Object.assign(scores, syncState.scores || {});
    const categories = [...new Map(sets.map(row => [row.categoryId, row.categoryName])).entries()]; categorySelect.replaceChildren(...categories.map(([id, name]) => el('option', {value: id, text: name})));
    if (dashboardUI) {
      dashboardUI.category.append(...categories.map(([id, name]) => el('option', {value: id, text: name})));
      dashboardUI.status.textContent = 'Сохранённая коллекция загружена. Обновите её для проверки новых карт; ранее собранные тиры уже видны.';
    }
    fillSets(categorySelect.value, setSelect, gradeSelect); status.className = ''; status.textContent = `Каталог загружен: ${sets.length} наборов. Выбери набор и синхронизируй Gallery.`;
  }
  async function saveCollected() {
    const key = `fcghCollected.${persona}`, memory = await chrome.storage.local.get(key);
    for (const id of memory[key] || []) collected.add(Number(id));
    await chrome.storage.local.set({[key]: [...collected]});
  }
  async function syncSet(setId, status, result) {
    const row = selectedSet(setId); if (!row) throw new Error('Выберите набор');
    await syncSets([row], status, true);
    result.replaceChildren(); renderProgress(row, result);
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
    const priceAnswer = await runtime({type: 'fcgh.prices', platform: controls.platform.value, ids: missing.map(card => card.defId)});
    const prices = priceAnswer.prices;
    for (const card of sbcPlan.cards) { card.referencePrice = Number(prices[card.defId]) || null; card.livePrice = card.referencePrice || card.expectedPrice || 0; }
    sbcPlan = {...sbcPlan, platform: controls.platform.value, scanned: true, priceAt: priceAnswer.at, owned, missing, cost: missing.reduce((sum, card) => sum + Number(card.livePrice || 0), 0)};
    if (answer.complete === false && missing.length) {
      sbcPlan.scanned = false; renderSbc(result);
      throw new Error(`Клуб проверен частично. Найдено ${owned.length} карт; наличие остальных пока неизвестно. Повторите проверку клуба перед покупкой.`);
    }
    renderSbc(result); status.textContent = missing.length ? `Найдено в клубе: ${owned.length}. Нужно купить: ${missing.length}. Каждая покупка будет по самому дешёвому найденному BIN в своём лимите.` : 'Все 11 карт уже есть в клубе. Покупать ничего не нужно.';
  }
  async function buySbc(controls, status, result, start, stop) {
    if (running) return;
    if (!sbcPlan?.scanned) throw new Error('Сначала проверь игроков в клубе');
    if (!sbcPlan.missing.length) throw new Error('Все карты уже есть в клубе');
    const maxPrice = Number(controls.maxPrice.value), budget = Number(controls.budget.value), purchaseMode = controls.purchaseMode.value;
    if (!Number.isSafeInteger(maxPrice) || maxPrice < 150 || !Number.isSafeInteger(budget) || budget <= 0) throw new Error('Проверь лимиты цены и бюджета');
    const rows = sbcPlan.missing.map(card => `${card.name}: ориентир ${format(card.livePrice)}, искать самый дешёвый найденный лот до ${format(maxPrice)}`).join('\n');
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
        const ownedNow = await bridge('club', {ids: [card.defId]}, 45_000);
        if (Number(ownedNow.counts?.[card.defId]) > 0) {
          if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ ЕСТЬ В КЛУБЕ, ПОКУПКА ПРОПУЩЕНА'); }
          status.textContent = `${card.name} уже есть в клубе. Перехожу к следующей карточке.`;
          continue;
        }
        if (ownedNow.complete === false) throw new Error(`EA не завершила проверку клуба для ${card.name}. Покупка остановлена, чтобы не купить дубль.`);
        const purchase = await findAndBuy({defId: card.defId, name: card.name, ceiling, purchaseMode, status, platform: sbcPlan.platform, reference: card.referencePrice, referenceAt: sbcPlan.priceAt});
        if (purchase.state === 'stopped') break;
        if (purchase.state === 'owned') { if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ В НЕПРИНЯТЫХ, ПОКУПКА ПРОПУЩЕНА'); } continue; }
        if (purchase.state === 'not-found') { if (line) { line.classList.add('fcgh-missed'); line.append(' — НЕТ ДРУГОГО ЛОТА В ЛИМИТЕ'); } await sleep(1400); continue; }
        if (purchase.state === 'skipped') { if (line) line.append(' — ПРОПУЩЕНО'); status.textContent = `${card.name} пропущен. Перехожу к следующей карточке.`; continue; }
        if (purchase.state === 'rejected') { if (line) { line.classList.add('fcgh-missed'); line.append(' — EA ОТКЛОНИЛА ЛОТЫ'); } status.textContent = `EA отклонила доступные лоты ${card.name}. Перехожу к следующей карточке.`; continue; }
        const receipt = purchase.receipt;
        spent += receipt.price; bought++;
        if (!receipt.item?.handle) throw new Error('Покупка могла пройти, но карточка не появилась в непринятых. Проверь её вручную; повтор не выполнялся.');
        await bridge('move', {handle: receipt.item.handle, destination: 'club'}, 45_000);
        if (line) { line.classList.add('fcgh-bought'); line.append(` — КУПЛЕНО ЗА ${format(receipt.price)}`); }
        status.textContent = `Куплено ${bought}/${sbcPlan.missing.length}; потрачено ${format(spent)}.`; await sleep(1500 + Math.floor(Math.random() * 900));
      }
    } finally {
      running = false; sbcPlan.scanned = false; start.disabled = true; stop.disabled = true;
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
      canUndoSbc = true;
    } finally { button.disabled = false; }
  }
  async function undoSbc(status, undoButton) {
    undoButton.disabled = true; status.className = ''; status.textContent = 'Возвращаю состав, который был на поле до расстановки…';
    await bridge('sbcundo', {}, 60_000); canUndoSbc = false; status.textContent = 'Предыдущий состав восстановлен.';
  }
  async function calculate(setId, letter, controls, status, result) {
    if (running) throw new Error('Сначала останови текущую покупку');
    const row = selectedSet(setId), target = row?.grades?.find(g => g.letter === letter); if (!row || !target) throw new Error('Выбери набор и грейд');
    const ids = [...new Set((row.pool || []).map(Number))];
    if (!ids.length) throw new Error('Набор уже добавлен, но точные версии его карточек ещё не попали в нашу локальную базу. Обновите базу позже — покупать неизвестные карты нельзя.');
    status.className = ''; status.textContent = 'Рассчитываю покупки по ценам точных версий карт…';
    const [priceAnswer, cardAnswer] = await Promise.all([
      catalogBatch('fcgh.prices', ids, controls.platform.value),
      catalogBatch('fcgh.cards', ids)
    ]);
    const referencePrices = {...priceAnswer.prices};
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
      for (let at = 0; at < unknown.length && !stopRequested; at++) {
        status.textContent = `Уточняю отсутствующие цены на рынке EA: ${at + 1} / ${unknown.length}…`;
        const live = await bridge('search', {defId: unknown[at], maxBuy: 15_000_000}, 45_000).catch(() => null);
        if (live?.found && Number.isSafeInteger(live.price)) { priceAnswer.prices[unknown[at]] = live.price; if (live.name) names[unknown[at]] = live.name; }
        if (at + 1 < unknown.length) await sleep(1300);
      }
      currentPlan = makePlan(Number(controls.maxPrice.value), Number(controls.budget.value));
      fallback = makePlan(15_000_000, 1_000_000_000);
    }
    if (stopRequested) { invalidatePlan(); status.textContent = 'Расчёт остановлен. Данные коллекции сохранены.'; return; }
    currentPlan.fallback = fallback;
    currentPlan.meta = {setId, setName: row.name, letter, platform: controls.platform.value, priceAt: priceAnswer.at}; result.replaceChildren();
    currentPlan.planning = {pool: ids, slots: row.cards, target: Number(target.threshold), prices: priceAnswer.prices, referencePrices};
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
    result.append(el('div', {class: 'fcgh-price-sources', text: `Ориентир: FUT.GG, получен ${dateTime(priceAnswer.at)}. Итоговая цена проверяется на рынке EA. Переплата >10% — только вручную.`}));
    result.append(el('div', {class: 'fcgh-plan-overview'}, [
      el('b', {text: `Для грейда ${letter} нужно закрыть ${row.cards} мест.`}),
      el('span', {text: `Уже засчитано: ${ownedCount}. Доступно для покупки до ${format(configuredMax)}: ${pricedInLimit.length}.`}),
      el('span', {text: `Минимально не хватает по количеству: ${Math.max(0, row.cards - ownedCount - pricedInLimit.length)}.`})
    ]));
    const verdict = currentPlan.reached
      ? `План ${letter} готов: ${format(currentPlan.score)} очков, до ${format(currentPlan.cost)} монет`
      : currentPlan.partial
        ? `Полный план пока невозможен. Доступная часть: ${currentPlan.lineup.length} из ${row.cards} мест, ${format(currentPlan.score)} из ${format(target.threshold)} очков, до ${format(currentPlan.cost)} монет.${fallback.reached ? ` Для полного плана нужен потолок ${format(recommendedMax)} и бюджет около ${format(fallback.cost)}.` : ''}`
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
    const shownPlan = currentPlan.reached || currentPlan.partial ? currentPlan : (fallback.reached ? fallback : currentPlan);
    currentPlan.selectedIds = new Set(shownPlan.missing.map(card => Number(card.id)));
    const updateSelection = () => {
      const selected = shownPlan.missing.filter(card => currentPlan?.selectedIds?.has(Number(card.id)));
      const selectedCost = selected.reduce((sum, card) => sum + Number(card.price || 0), 0);
      controls.start.disabled = !selected.length;
      controls.start.textContent = selected.length ? `4. Купить выбранные · ${selected.length} · ≈${format(selectedCost)}` : 'Выберите карты для покупки';
    };
    if (shownPlan.missing.length) result.append(el('strong', {text: shownPlan.reached ? `Конкретные карты для грейда ${letter}: купить ${shownPlan.missing.length}` : `Доступные сейчас карты: купить ${shownPlan.missing.length}`}));
    const renderCard = card => {
      const reference = Number(referencePrices[card.id]);
      const policy = reference > 0 ? `Дороже ${format(Math.floor(reference * 1.1))} — только с подтверждением` : 'Нет ориентира FUT.GG — цену нужно подтвердить вручную';
      const checkbox = el('input', {type: 'checkbox', 'aria-label': `Купить ${cardLabel(card.id)}`});
      checkbox.checked = currentPlan.selectedIds.has(Number(card.id));
      checkbox.onchange = () => { checkbox.checked ? currentPlan.selectedIds.add(Number(card.id)) : currentPlan.selectedIds.delete(Number(card.id)); updateSelection(); };
      return el('li', {'data-card-id': String(card.id)}, [checkbox, el('div', {class: 'fcgh-plan-card'}, [el('b', {text: cardLabel(card.id)}), el('span', {text: `${format(card.score)} очков · ориентир ${format(card.price)} · ваш потолок ${format(configuredMax)}`}), el('div', {class: 'fcgh-card-policy', text: policy})])]);
    };
    const list = el('ol', {class: 'fcgh-plan'});
    if (shownPlan.missing.length) {
      const chooseAll = el('button', {class: 'fcgh-link-button', text: 'Выбрать все'}), chooseNone = el('button', {class: 'fcgh-link-button', text: 'Снять выбор'});
      chooseAll.onclick = () => { currentPlan.selectedIds = new Set(shownPlan.missing.map(card => Number(card.id))); list.querySelectorAll('input').forEach(node => { node.checked = true; }); updateSelection(); };
      chooseNone.onclick = () => { currentPlan.selectedIds.clear(); list.querySelectorAll('input').forEach(node => { node.checked = false; }); updateSelection(); };
      result.append(el('div', {class: 'fcgh-plan-tools'}, [el('span', {text: 'Покупайте весь план или только нужные карты'}), chooseAll, chooseNone]));
    }
    list.append(...shownPlan.missing.map(renderCard));
    result.append(list);
    const ownedLineup = shownPlan.lineup.filter(card => card.collected);
    if (ownedLineup.length) result.append(el('details', {class: 'fcgh-help'}, [el('summary', {text: `Уже собраны: ${ownedLineup.length} карт — повторно не покупаем`}), el('ul', {}, ownedLineup.map(card => el('li', {text: `${cardLabel(card.id)} · ${format(card.score)} очков · ${sourceLabel(card.id)}`})))]));
    renderProgress(row, result);
    const alternatives = el('details', {class: 'fcgh-alternatives'});
    alternatives.append(el('summary', {text: 'Альтернативные игроки — выбрать замену и пересчитать план'}));
    const alternativesList = el('ul');
    const renderAlternatives = () => {
      alternativesList.replaceChildren();
      for (const card of currentPlan.missing) {
        const candidates = GalleryCore.galleryAlternatives(currentPlan, {collected: [...collected], scores, maxPrice: Number(controls.maxPrice.value), budget: Number(controls.budget.value)}, card.id);
        const entry = el('li', {}, [el('b', {text: `Вместо ${cardLabel(card.id)}: `})]);
        if (!candidates.length) entry.append('нет замены в лимитах с сохранением очков плана');
        for (const candidate of candidates.slice(0, 5)) {
          const button = el('button', {text: `${cardLabel(candidate.id)} · ${format(candidate.score)} очков · ≈${format(candidate.price)} монет`});
          button.onclick = () => {
            if (running) return;
            const index = currentPlan.lineup.findIndex(item => item.id === card.id);
            if (index < 0) return;
            currentPlan.lineup[index] = candidate;
            currentPlan.missing = currentPlan.lineup.filter(item => !item.collected);
            currentPlan.cost = currentPlan.missing.reduce((sum, item) => sum + item.price, 0);
            currentPlan.score = Math.min(Number(target.threshold), currentPlan.lineup.reduce((sum, item) => sum + item.score, 0));
            currentPlan.reached = currentPlan.lineup.length === row.cards && currentPlan.score >= Number(target.threshold);
            currentPlan.partial = !currentPlan.reached && currentPlan.lineup.length > 0;
            currentPlan.selectedIds = new Set(currentPlan.missing.map(item => Number(item.id)));
            const verdictNode = result.querySelector('.fcgh-plan-ok, .fcgh-plan-bad');
            if (verdictNode) {
              verdictNode.className = currentPlan.reached ? 'fcgh-plan-ok' : 'fcgh-plan-bad';
              verdictNode.textContent = `План ${letter}: ${format(currentPlan.score)} очков, около ${format(currentPlan.cost)} монет${currentPlan.reached ? '' : ' · неполный план'}`;
            }
            controls.start.textContent = currentPlan.reached ? '3. Купить по плану' : `3. Купить доступные (${currentPlan.missing.length})`;
            list.replaceChildren(...currentPlan.missing.map(renderCard));
            status.textContent = `План обновлён: ${currentPlan.missing.length} покупок, около ${format(currentPlan.cost)} монет. Грейд ${letter}: ${currentPlan.reached ? 'достижим' : 'неполный план'}.`;
            renderAlternatives();
          };
          entry.append(button);
        }
        alternativesList.append(entry);
      }
    };
    renderAlternatives(); alternatives.append(alternativesList); result.append(alternatives);
    updateSelection();
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
        for (const id of withoutMarket.slice(0, 10)) {
          unavailable.append(el('li', {text: `${cardLabel(id)} — нет актуальной цены или найденного лота`}));
        }
        diagnostic.append(unavailable);
      }
      if (!aboveLimit.length && !withoutMarket.length) diagnostic.append(el('span', {text: `Карточек по количеству хватает, но их очков недостаточно для порога ${format(target.threshold)}.`}));
      result.append(diagnostic);
    }
    status.textContent = currentPlan.reached
      ? `План ${letter}: уже засчитано ${shownPlan.lineup.filter(x => x.collected).length}, докупить ${shownPlan.missing.length}. Для каждого игрока поиск идёт от минимальной цены до указанного общего потолка.`
      : currentPlan.partial
          ? `Можно купить ${currentPlan.missing.length} доступных карт, но этого пока недостаточно для грейда ${letter}. Недоступные карты останутся для следующей проверки.`
        : fallback.reached
          ? `Для грейда ${letter} докупить ${shownPlan.missing.length} карт. Нажми кнопку подстановки лимитов, затем ещё раз «2. Составить план».`
        : `Для грейда ${letter} сейчас доступно ${ownedCount + pricedInLimit.length} из ${row.cards} необходимых карт. Ниже показано, какие карты дороже лимита или отсутствуют на рынке.`;
  }
  async function execute(controls, status, result, start, stop) {
    if (running) return; if (!currentPlan?.missing?.length) throw new Error('В текущем плане нет доступных карт для покупки');
    const maxPrice = Number(controls.maxPrice.value), maxSpend = Number(controls.budget.value), mode = controls.after.value, discount = Number(controls.discount.value), purchaseMode = controls.purchaseMode.value;
    if (!Number.isSafeInteger(maxPrice) || maxPrice < 150 || !Number.isSafeInteger(maxSpend) || maxSpend <= 0) throw new Error('Проверь лимиты цены и расходов');
    const meta = currentPlan.meta, planning = currentPlan.planning;
    if (Date.now() - Number(meta.priceAt || 0) > 10 * 60_000) throw new Error('План старше 10 минут. Составьте его заново, чтобы обновить цены и бюджет.');
    if (!planning?.pool?.length || !Number.isFinite(planning.target)) throw new Error('Пересчитай план для выбранного грейда');
    const selectedMissing = currentPlan.missing.filter(card => !currentPlan.selectedIds || currentPlan.selectedIds.has(Number(card.id)));
    if (!selectedMissing.length) throw new Error('Выбери хотя бы одну карту в плане');
    const review = selectedMissing.map(card => `${names[card.id] || '#' + card.id}: ориентир ${format(card.price)}, искать самый дешёвый найденный лот до ${format(maxPrice)}`).join('\n');
    const modeNotice = purchaseMode === 'auto'
      ? '\n\nВНИМАНИЕ: автоматические покупки нарушают правила EA и выполняются на ваш риск.'
      : '\n\nПолуавтоматический режим: найденный лот будет куплен только после отдельного подтверждения.';
    const partialNotice = currentPlan.reached ? '' : `\n\nНЕПОЛНЫЙ ПЛАН: эти покупки пока не закроют грейд ${meta.letter}. После покупки снова проверь карты и пересчитай план.`;
    if (!confirm(`${currentPlan.reached ? 'План покупки' : 'Покупка доступной части'}:\n${review}\n\nОбщие расходы не больше ${format(maxSpend)} монет. Перед каждой покупкой будет выбран самый дешёвый найденный BIN.${partialNotice}${modeNotice}\n\nПродолжить?`)) return;
    running = true; start.disabled = true; stop.disabled = false; let spent = 0, bought = 0, listed = 0;
    const unavailable = new Set();
    let queue = [...selectedMissing];
    const replaceCard = failedCard => {
      unavailable.add(failedCard.id);
      const replacement = GalleryCore.galleryPlan({pool: planning.pool.filter(id => !unavailable.has(id)), slots: planning.slots, target: planning.target, collected: [...collected], scores, prices: planning.prices, maxPrice, budget: Math.max(0, maxSpend - spent)});
      if ((!replacement.reached && currentPlan.reached) || !replacement.missing.length) return false;
      currentPlan = {...replacement, meta, planning};
      queue = replacement.missing.filter(card => !unavailable.has(card.id) && !collected.has(card.id));
      const list = result.querySelector('.fcgh-plan');
      for (const card of queue) if (list && !list.querySelector(`li[data-card-id="${card.id}"]`)) {
        const ceiling = maxPrice;
        list.append(el('li', {'data-card-id': String(card.id), class: 'fcgh-replacement'}, [el('b', {text: names[card.id] || '#' + card.id}), el('span', {text: ` — ЗАМЕНА · ожидаемая цена ${format(card.price)}, искать самый дешёвый найденный лот до ${format(ceiling)} · ${format(card.score)} очков`})]));
      }
      result.prepend(el('div', {class: 'fcgh-run-summary', text: `Для грейда ${meta.letter} план пересчитан без карты ${names[failedCard.id] || '#' + failedCard.id}. Новых покупок в очереди: ${queue.length}.` }));
      return true;
    };
    try {
      while (queue.length) {
        const card = queue.shift();
        if (!running) break; const remaining = maxSpend - spent, ceiling = Math.min(maxPrice, remaining); if (ceiling < 150) { status.textContent = 'Остановлено: достигнут лимит расходов.'; break; }
        const cardName = names[card.id] || '#' + card.id;
        const line = result.querySelector(`li[data-card-id="${card.id}"]`);
        const memory = await chrome.storage.local.get(`fcghCollected.${persona}`);
        for (const id of memory[`fcghCollected.${persona}`] || []) collected.add(Number(id));
        if (collected.has(Number(card.id))) {
          if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ СОБРАНА, ПОКУПКА ПРОПУЩЕНА'); }
          continue;
        }
        status.textContent = `Повторно проверяю Gallery для ${cardName}…`;
        const galleryNow = await bridge('sync', {ids: [card.id]}, 45_000);
        const galleryItem = (galleryNow.items || []).find(item => Number(item.defId) === Number(card.id));
        if (galleryItem?.collected === true) {
          galleryVerified.add(card.id); collected.add(card.id); await saveCollected();
          if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ СОБРАНА В GALLERY, ПОКУПКА ПРОПУЩЕНА'); }
          status.textContent = `${cardName} уже собрана в Gallery. Покупка пропущена.`;
          continue;
        }
        if (!galleryItem || typeof galleryItem.collected !== 'boolean') {
          unavailable.add(card.id);
          if (line) { line.classList.add('fcgh-missed'); line.append(' — EA НЕ ПОДТВЕРДИЛА СТАТУС GALLERY'); }
          if (!replaceCard(card)) { status.textContent = `EA не подтвердила статус Gallery для ${cardName}; покупка остановлена, чтобы не купить дубль.`; break; }
          status.textContent = `EA не подтвердила статус Gallery для ${cardName}. Карта исключена, план пересчитан.`;
          continue;
        }
        galleryVerified.add(card.id);
        status.textContent = `Проверяю клуб перед покупкой ${cardName}…`;
        const ownedNow = await bridge('club', {ids: [card.id]}, 45_000);
        if (Number(ownedNow.counts?.[card.id]) > 0) {
          collected.add(card.id); await saveCollected();
          if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ ЕСТЬ В КЛУБЕ, ПОКУПКА ПРОПУЩЕНА'); }
          status.textContent = `${cardName} уже есть в клубе. Покупка пропущена.`;
          continue;
        }
        if (ownedNow.complete === false) throw new Error(`EA не завершила проверку клуба для ${cardName}. Покупка остановлена, чтобы не купить дубль.`);
        status.textContent = `Ищу ${cardName} до ${format(ceiling)}…`;
        const purchase = await findAndBuy({defId: card.id, name: cardName, ceiling, purchaseMode, status, platform: meta.platform, reference: planning.referencePrices?.[card.id] ?? null, referenceAt: meta.priceAt});
        if (purchase.state === 'stopped') break;
        if (purchase.state === 'owned') {
          collected.add(card.id); await saveCollected();
          if (line) { line.classList.add('fcgh-owned'); line.append(' — УЖЕ В НЕПРИНЯТЫХ, ПОКУПКА ПРОПУЩЕНА'); }
          renderProgress(selectedSet(meta.setId), result);
          continue;
        }
        if (purchase.found?.name) names[card.id] = purchase.found.name;
        if (purchase.state === 'not-found' || purchase.state === 'skipped' || purchase.state === 'rejected') {
          const reason = purchase.state === 'not-found' ? 'НЕТ ЛОТА' : purchase.state === 'skipped' ? 'ПРОПУЩЕНО' : 'EA ОТКЛОНИЛА ЛОТЫ';
          if (line) { line.classList.add('fcgh-missed'); line.append(` — ${reason}`); }
          if (!replaceCard(card)) { status.textContent = `Для ${names[card.id] || cardName} не найдено подходящей замены, сохраняющей грейд ${meta.letter} в заданных лимитах. Покупки остановлены.`; break; }
          status.textContent = `${names[card.id] || cardName} заменён другой картой. Продолжаю план грейда ${meta.letter}.`;
          await sleep(750);
          continue;
        }
        const receipt = purchase.receipt;
        spent += receipt.price; bought++; collected.add(card.id); await saveCollected(); if (line) { line.classList.add('fcgh-bought'); line.append(` — КУПЛЕНО ЗА ${format(receipt.price)}`); }
        renderProgress(selectedSet(meta.setId), result);
        if (!receipt.item?.handle) throw new Error('Покупка подтверждена и сохранена в истории, но карта ещё не появилась в непринятых. Проверь её вручную; повторная покупка исключена.');
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
              status.textContent = 'EA отклонила выставление. Сохраняю карту в трансфер-листе для ручной продажи.';
              await bridge('move', {handle: receipt.item.handle, destination: 'transfer'}, 45_000);
              if (line) line.append(' — В ТРАНСФЕР-ЛИСТЕ: выставите вручную');
            }
          } else {
            await bridge('move', {handle: receipt.item.handle, destination: 'transfer'}, 45_000);
            if (line) line.append(' — ЦЕНА РЫНКА НЕ НАЙДЕНА, ОСТАВЛЕНО В ТРАНСФЕР-ЛИСТЕ');
          }
        }
        else await bridge('move', {handle: receipt.item.handle, destination: mode}, 45_000);
        status.textContent = `Грейд ${meta.letter}: куплено ${bought}, в очереди ${queue.length}; потрачено ${format(spent)}; выставлено ${listed}.`; await sleep(1400 + Math.floor(Math.random() * 900));
      }
    } finally {
      running = false; start.disabled = true; stop.disabled = true;
      result.prepend(el('div', {class: 'fcgh-run-summary', text: `Куплено: ${bought} · расходы: ${format(spent)} · выставлено: ${listed}. Коллекция обновлена. Для дальнейших покупок составьте новый план.`}));
      currentPlan = null;
      result.querySelector('.fcgh-alternatives')?.remove();
      renderProgress(selectedSet(meta.setId), result); renderDashboard();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();
})();
