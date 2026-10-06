(() => {
  if (window.__FCGH_FUTBIN_IMPORT__) return;
  window.__FCGH_FUTBIN_IMPORT__ = true;

  const number = text => {
    const clean = String(text || '').replace(/[^0-9]/g, '');
    return clean ? Number(clean) : null;
  };
  const compactNumber = text => {
    const match = String(text || '').replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
    if (!match) return null;
    const multiplier = {K: 1_000, M: 1_000_000, B: 1_000_000_000}[String(match[2] || '').toUpperCase()] || 1;
    const value = Math.round(Number(match[1]) * multiplier);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const price = (slot, platform) => {
    const selector = platform === 'pc' ? '.platform-pc-only .price-segment' : '.platform-ps-only .price-segment';
    return number(slot.querySelector(selector)?.textContent);
  };
  function parseSolution() {
    if (!/^\/27\/squad\/\d+/i.test(location.pathname)) throw new Error('Это не ссылка на готовую сборку FUTBIN');
    const slots = [...document.querySelectorAll('[id^="cardlid"]')]
      .filter(node => /^cardlid(?:[1-9]|1[01])$/.test(node.id))
      .sort((a, b) => number(a.id) - number(b.id));
    if (slots.length !== 11) throw new Error(`FUTBIN показал ${slots.length} из 11 позиций`);
    const centers = slots.map(slot => {
      const rect = slot.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    });
    const xs = centers.map(point => point.x), ys = centers.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const normalize = (value, min, max) => max > min ? (value - min) / (max - min) : .5;
    const cards = slots.map((slot, index) => {
      const link = slot.querySelector('a[href*="/27/player/"]');
      const face = slot.querySelector('.playercard-27-base-img');
      const cardBackground = slot.querySelector('.playercard-27-bg')?.src || '';
      const clubImage = slot.querySelector('.playercard-27-club')?.src || '';
      const leagueImage = slot.querySelector('.playercard-27-league')?.src || '';
      const nationImage = slot.querySelector('.playercard-27-nation')?.src || '';
      const imageId = face?.src?.match(/\/players\/(\d+)\.png/i)?.[1];
      const futbinId = link?.getAttribute('href')?.match(/\/player\/(\d+)/i)?.[1];
      const rating = number(slot.querySelector('.playercard-27-rating')?.textContent);
      const position = slot.querySelector('.playercard-27-position')?.textContent?.trim() || null;
      const name = slot.querySelector('.playercard-27-name')?.textContent?.trim() || face?.alt?.trim() || `Позиция ${index + 1}`;
      if (!link || !imageId || !rating) throw new Error(`Не удалось прочитать карточку на позиции ${index + 1}`);
      const raritySquadId = number(cardBackground.match(/\/cards\/hd\/(\d+)_/i)?.[1]);
      const clubEaId = number(clubImage.match(/\/clubs\/(?:light\/)?(\d+)\.png/i)?.[1]);
      const leagueEaId = number(leagueImage.match(/\/league\/(?:light\/)?(\d+)\.png/i)?.[1]);
      const nationEaId = number(nationImage.match(/\/nation\/(?:light\/)?(\d+)\.png/i)?.[1]);
      return {slot: index + 1, fieldX: normalize(centers[index].x, minX, maxX), fieldY: normalize(centers[index].y, minY, maxY), futbinId: Number(futbinId), baseEaId: Number(imageId), raritySquadId, clubEaId, leagueEaId, nationEaId, rating, position, name, ps5: price(slot, 'ps5'), pc: price(slot, 'pc')};
    });
    const body = document.body?.innerText || '';
    const chemistry = number(body.match(/Total Chemistry\s*(\d+)\s*\/\s*33/i)?.[1]);
    const squadRating = number(body.match(/Squad Rating:\s*(\d+)/i)?.[1]);
    const crumb = [...document.querySelectorAll('.pager-header a')].map(a => a.textContent.trim()).filter(Boolean);
    return {url: location.href, title: document.querySelector('h1')?.textContent?.trim() || document.title, challenge: crumb.at(-1) || null, chemistry, squadRating, cards};
  }
  function parseScoreTable(platform) {
    if (!/\/27\/squad-building-challenges\/cheapest-item-score/i.test(location.pathname)) throw new Error('Это не таблица Cheapest Item Score FUTBIN');
    const parseRows = table => [...table.querySelectorAll('tbody tr, tr')].map(row => {
      const cells = [...row.querySelectorAll('td')];
      if (cells.length < 4) return null;
      const card = cells[0].innerText.trim(), rating = Number(card.match(/\b(\d{2})\b/)?.[1]);
      const price = compactNumber(cells[1].innerText), score = compactNumber(cells[3].innerText);
      if (!Number.isSafeInteger(rating) || !price || !score) return null;
      return {rating, card, price, score, players: number(cells[2].innerText), coinsPerPoint: Number(cells[4]?.innerText?.replace(',', '.')) || null};
    }).filter(Boolean);
    const tables = [...document.querySelectorAll('table')].map(table => ({table, rows: parseRows(table)})).filter(item => item.rows.length);
    if (!tables.length) throw new Error('FUTBIN ещё не показал таблицу Item Score');
    const marker = platform === 'pc' ? 'pc' : 'ps';
    const marked = tables.find(item => {
      let node = item.table, context = '';
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) context += ` ${node.className || ''} ${node.id || ''}`;
      context = context.toLowerCase();
      return context.includes(`platform-${marker}`) || context.includes(`${marker}-only`);
    });
    const selected = marked || (platform === 'pc' ? tables.at(-1) : tables[0]);
    const bestByScore = {};
    for (const row of selected.rows) if (!bestByScore[row.score] || row.price < bestByScore[row.score].price) bestByScore[row.score] = row;
    return {url: location.href, platform, rows: Object.values(bestByScore), readAt: Date.now()};
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!['fcgh.futbin.parse', 'fcgh.futbin.score.parse'].includes(message?.type)) return;
    try { respond({ok: true, data: message.type === 'fcgh.futbin.parse' ? parseSolution() : parseScoreTable(message.platform)}); }
    catch (error) { respond({ok: false, error: String(error?.message || error)}); }
  });
})();
