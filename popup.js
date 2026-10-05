const button = document.getElementById('update-data');
const status = document.getElementById('data-status');

const send = message => new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
  if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
  response?.ok ? resolve(response.data) : reject(new Error(response?.error || 'Фоновый процесс не ответил'));
}));

const date = value => value ? new Date(value).toLocaleString('ru-RU') : 'ещё не проверялась';

async function showStatus() {
  try {
    const data = await send({type: 'fcgh.data.status'});
    status.textContent = `Источник: ${data.source === 'github' ? 'наш GitHub' : 'встроенная копия'}. Последняя проверка: ${date(data.at)}.`;
  } catch (error) { status.textContent = error.message; }
}

button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = 'Проверяю каталог и базу карточек в GitHub…';
  try {
    const data = await send({type: 'fcgh.data.update'});
    const source = data.source === 'github' ? 'наш GitHub' : 'встроенная копия';
    status.textContent = `Готово: ${source}, версия базы ${data.version ?? '?'}, ${data.sets} наборов. Проверено ${date(data.at)}.`;
  } catch (error) {
    status.textContent = `Не удалось обновить: ${error.message}. Встроенная база продолжает работать.`;
  } finally { button.disabled = false; }
});

showStatus();
